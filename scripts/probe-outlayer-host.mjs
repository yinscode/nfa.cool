#!/usr/bin/env node
// Disposable Alice-owned OutLayer Project smoke test; never touches the NFA registry.
import {createPrivateKey,createPublicKey} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {connect,KeyPair,keyStores,utils} from 'near-api-js';

const command=process.argv[2];
if(!['create','run','run-warm','run-compare','recall','recall-warm','inspect','run-minimal','run-p1'].includes(command)){
  console.error('Usage: node scripts/probe-outlayer-host.mjs create|run|recall|inspect|run-minimal|run-p1');process.exit(2);
}
const accountId='nfagent-alice-fe53d8.testnet',projectId=`${accountId}/nfa-probe`;
const rpcUrl=process.env.NEAR_RPC_URL||'https://test.rpc.fastnear.com';
const evidencePath='deployments/outlayer-probe-public.json';
const limits={max_instructions:1_000_000_000,max_memory_mb:64,max_execution_seconds:10};
async function rpc(method,params){
  const res=await fetch(rpcUrl,{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:'outlayer-probe',method,params}),signal:AbortSignal.timeout(15000)});
  const data=await res.json();if(data.error)throw Error(JSON.stringify(data.error));return data.result;
}
async function view(method,args){
  const r=await rpc('query',{request_type:'call_function',finality:'final',account_id:'outlayer.testnet',
    method_name:method,args_base64:Buffer.from(JSON.stringify(args)).toString('base64')});
  return JSON.parse(Buffer.from(r.result).toString());
}
async function evidence(){try{return JSON.parse(await readFile(evidencePath,'utf8'))}catch(e){if(e.code==='ENOENT')return {};throw e}}
async function save(value){await writeFile(evidencePath,JSON.stringify(value,null,2)+'\n')}
async function signer(){
  const record=JSON.parse(await readFile('deployments/t006-alice.key.json','utf8'));
  if(record.account_id!==accountId||record.network!=='testnet')throw Error('Unexpected probe signer');
  const privateKey=createPrivateKey(record.private_key_pkcs8_pem);
  const pub=createPublicKey(privateKey).export({format:'der',type:'spki'}).subarray(-32);
  if(record.public_key!=='ed25519:'+utils.serialize.base_encode(pub))throw Error('Signer mismatch');
  const seed=privateKey.export({format:'der',type:'pkcs8'}).subarray(-32);
  const pair=KeyPair.fromString('ed25519:'+utils.serialize.base_encode(Buffer.concat([seed,pub])));
  const keys=new keyStores.InMemoryKeyStore();await keys.setKey('testnet',accountId,pair);
  return (await connect({networkId:'testnet',nodeUrl:rpcUrl,deps:{keyStore:keys}})).account(accountId);
}
async function call(method,args,deposit){
  const account=await signer();
  const tx=await account.functionCall({contractId:'outlayer.testnet',methodName:method,args,
    gas:250_000_000_000_000n,attachedDeposit:BigInt(deposit)});
  if(tx.status?.Failure)throw Error(`${method} failed: ${JSON.stringify(tx.status.Failure)}`);
  const value=tx.status?.SuccessValue?Buffer.from(tx.status.SuccessValue,'base64').toString():null;
  return {hash:tx.transaction.hash,value:value?JSON.parse(value):null,
    receipts:tx.receipts_outcome?.map(r=>({id:r.id,gas_burnt:r.outcome.gas_burnt,status:r.outcome.status}))};
}
async function main(){
  const record=await evidence();
  if(command==='run-minimal'||command==='run-p1'){
    const p1=command==='run-p1',tag=p1?'p1':'minimal';
    const path=p1?'/tmp/nfa-outlayer-minimal-p1-upload.json':'/tmp/nfa-outlayer-minimal-upload.json';
    const uploaded=JSON.parse(await readFile(path,'utf8'));
    if(record[`${tag}Intent`])throw Error(`${tag} probe already attempted; reconcile its transaction before retry`);
    const bytes=Buffer.from(await (await fetch(uploaded.url,{signal:AbortSignal.timeout(20000)})).arrayBuffer());
    const {createHash}=await import('node:crypto');
    if(createHash('sha256').update(bytes).digest('hex')!==uploaded.wasmSha256)throw Error('Uploaded minimal WASM mismatch');
    const source={WasmUrl:{url:uploaded.url,hash:uploaded.wasmSha256,build_target:p1?'wasm32-wasip1':'wasm32-wasip2'}};
    await save({...record,[`${tag}Intent`]:new Date().toISOString(),[`${tag}Source`]:source});
    const probeLimits=p1?{max_instructions:2_000_000_000,max_memory_mb:128,max_execution_seconds:30}:limits;
    const tx=await call('request_execution',{source,input_data:'{"probe":true}',resource_limits:probeLimits,
      response_format:'Json'},'5000000000000000000000');
    await save({...await evidence(),[`${tag}Run`]:tx});
    console.log(JSON.stringify({tx},null,2));return;
  }
  const project=await view('get_project',{project_id:projectId});
  if(command==='inspect'){console.log(JSON.stringify({projectId,project,evidence:record},null,2));return}
  if(command==='create'){
    if(project){await save({...record,project});console.log(JSON.stringify({projectId,project,existing:true},null,2));return}
    if(record.createIntent)throw Error('Previous create is unresolved; inspect transaction before retry');
    const uploaded=JSON.parse(await readFile('deployments/outlayer-upload-public.json','utf8'));
    await save({...record,projectId,versionKey:uploaded.wasmSha256,url:uploaded.url,createIntent:new Date().toISOString()});
    const tx=await call('create_project',{name:'nfa-probe',source:{WasmUrl:{url:uploaded.url,
      hash:uploaded.wasmSha256,build_target:'wasm32-wasip2'}}},'100000000000000000000000');
    await save({...await evidence(),create:tx});
    const confirmed=await view('get_project',{project_id:projectId});
    if(!confirmed)throw Error('Create submitted, project view not ready');
    await save({...await evidence(),project:confirmed});
    console.log(JSON.stringify({tx:tx.hash,project:confirmed},null,2));return;
  }
  if(!project)throw Error('Project not created');
  if(command==='run-compare'){
    if(record.compareRunIntent)throw Error('Compare already attempted; inspect before retry');
    const input=JSON.stringify({operation:'run',service:'compare',jobId:10003,
      question:'Which option has cost and speed evidence?',criteria:['cost','speed'],sources:[
        {title:'Option A',url:'https://example.org/a',text:'The cost of option A is five units per run. The speed of option A is two seconds per run.'},
        {title:'Option B',url:'https://example.org/b',text:'The cost of option B is seven units for a single run.'}]});
    await save({...record,compareRunInput:input,compareRunIntent:new Date().toISOString()});
    const tx=await call('request_execution',{source:{Project:{project_id:projectId,version_key:record.versionKey}},
      input_data:input,resource_limits:limits,response_format:'Json'},'5000000000000000000000');
    await save({...await evidence(),compareRun:tx});console.log(JSON.stringify(tx,null,2));return;
  }
  if(command==='run'||command==='run-warm'){
    const warm=command==='run-warm',tag=warm?'warmRun':'run';
    if(record[`${tag}Intent`])throw Error('Run already attempted; inspect before retry');
    const input=JSON.stringify({operation:'scout',jobId:warm?10002:10001,question:'How does an NFA retain its treasury?',
      sources:[{title:'Vault account',url:'https://example.org/vault',
        text:'An NFA vault retains the same account and treasury after its NFT transfers to a new owner. The registry gives the current owner control while the vault account remains unchanged.'}]});
    const estimate=await view('estimate_execution_cost',{resource_limits:limits,input_len:Buffer.byteLength(input)});
    await save({...record,estimate,[`${tag}Input`]:input,[`${tag}Intent`]:new Date().toISOString()});
    const tx=await call('request_execution',{source:{Project:{project_id:projectId,version_key:record.versionKey}},
      input_data:input,resource_limits:limits,response_format:'Json'},'5000000000000000000000');
    await save({...await evidence(),[tag]:tx});
    console.log(JSON.stringify({estimate,tx},null,2));return;
  }
  if(command==='recall'||command==='recall-warm'){
    const warm=command==='recall-warm',tag=warm?'warmRecall':'recall';
    if(record[`${tag}Intent`])throw Error('Recall already attempted; inspect before retry');
    const output=(warm?record.warmRun:record.run)?.value;
    if(output?.status!=='ok'||!/^sha256:[0-9a-f]{64}$/.test(output.outputHash))throw Error('No successful stored run');
    const input=JSON.stringify({operation:'recall',service:'scout',jobId:warm?10002:10001,expectedHash:output.outputHash});
    await save({...record,[`${tag}Input`]:input,[`${tag}Intent`]:new Date().toISOString()});
    const tx=await call('request_execution',{source:{Project:{project_id:projectId,version_key:record.versionKey}},
      input_data:input,resource_limits:limits,response_format:'Json'},'5000000000000000000000');
    await save({...await evidence(),[tag]:tx});
    console.log(JSON.stringify(tx,null,2));
  }
}
main().catch(error=>{console.error(error.message);process.exitCode=1});
