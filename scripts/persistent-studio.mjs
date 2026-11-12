#!/usr/bin/env node
import {mkdir,readFile,writeFile,access} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createServer} from 'node:net';
import {randomUUID,createHash} from 'node:crypto';
import {connect,KeyPair,keyStores,utils} from 'near-api-js';
import {NfaSdk} from '@nfa/sdk';
import {startSandbox,serveStudio} from './sandbox-check.mjs';
import {assertStudioPortAvailable} from '../services/api/studio-listen.mjs';

const home=resolve(process.env.NFA_SANDBOX_HOME||'.data/sandbox-chain');
const stateFile=join(home,'studio-accounts.json'),runtimeFile=join(home,'studio-runtime.json');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function settled(work,check=()=>true){let last;for(let i=0;i<50;i++){try{const value=await work();if(check(value))return value}catch(e){last=e}await pause(150)}throw last||Error('Local finalized state did not settle')}
const freePort=()=>new Promise(resolve=>{const server=createServer();server.listen(0,'127.0.0.1',()=>{const p=server.address().port;server.close(()=>resolve(p))})});
const json=async path=>{try{return JSON.parse(await readFile(path,'utf8'))}catch(error){if(error.code==='ENOENT')return null;throw error}};
async function chainStatus(url){try{const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:'nfa',method:'status',params:[]}),signal:AbortSignal.timeout(2000)});return (await r.json()).result}catch{return null}}
await assertStudioPortAvailable();await mkdir(home,{recursive:true,mode:0o700});
let child;
try{
  const saved=await json(stateFile)||{workspaceId:randomUUID(),accounts:{}};
  const save=()=>writeFile(stateFile,JSON.stringify(saved),{mode:0o600});
  const runtime=await json(runtimeFile),existing=runtime&&await chainStatus(runtime.rpcUrl);
  let rpcUrl;
  if(existing){
    if(existing.genesis_hash!==runtime.genesisHash||!['test-chain','test_chain','sandbox'].includes(existing.chain_id)&&!existing.chain_id.startsWith('test-chain-'))throw Error('Recorded sandbox identity mismatch');
    rpcUrl=runtime.rpcUrl;
  }else{
    let reuse=false;try{await access(join(home,'config.json'));reuse=true}catch{}
    const running=await startSandbox(process.env.NEAR_SANDBOX_BIN_PATH,home,await freePort(),await freePort(),{reuse});
    child=running.child;rpcUrl=running.rpcUrl;
    const status=await chainStatus(rpcUrl);
    await writeFile(runtimeFile,JSON.stringify({rpcUrl,genesisHash:status.genesis_hash}),{mode:0o600});
  }
  const root=JSON.parse(await readFile(join(home,'validator_key.json'))),keys=new keyStores.InMemoryKeyStore();
  await keys.setKey('sandbox','test.near',KeyPair.fromString(root.secret_key));
  const node=await connect({networkId:'sandbox',nodeUrl:rpcUrl,deps:{keyStore:keys}}),rootAccount=await node.account('test.near'),people={};
  for(const name of ['registry','alice','bob','customer','worker','receiver','outlayer']){
    const id=`${name}.test.near`;
    if(!saved.accounts[name]){saved.accounts[name]={id,secretKey:KeyPair.fromRandom('ed25519').toString()};await save()}
    const key=KeyPair.fromString(saved.accounts[name].secretKey);await keys.setKey('sandbox',id,key);
    const account=()=>node.connection.provider.query({request_type:'view_account',finality:'final',account_id:id});
    try{await node.connection.provider.query({request_type:'view_account',finality:'optimistic',account_id:id})}
    catch(error){
      if(!/does not exist|doesn't exist|UNKNOWN_ACCOUNT/i.test(error.message))throw error;
      try{await rootAccount.createAccount(id,key.getPublicKey(),30n*10n**24n)}catch(created){if(created.type!=='AccountAlreadyExists')throw created}
    }
    await settled(account);
    await node.connection.provider.query({request_type:'view_access_key',finality:'final',account_id:id,public_key:key.getPublicKey().toString()});
    people[name]={id,key,account:await node.account(id)};
  }
  const sdk=new NfaSdk({registryAccountId:people.registry.id,rpcUrl});
  const deploy=async(person,path)=>{const bytes=await readFile(path),hash=utils.serialize.base_encode(createHash('sha256').update(bytes).digest());
    const account=()=>node.connection.provider.query({request_type:'view_account',finality:'final',account_id:person.id});
    const current=await settled(account);
    if(current.code_hash!==hash){await person.account.deployContract(bytes);await settled(account,value=>value.code_hash===hash)}};
  await deploy(people.outlayer,'output/sandbox-outlayer-mock.wasm');
  await deploy(people.registry,'output/sandbox-nfa-registry.wasm');
  for(const [name,init] of [['outlayer',{}],['registry',{admin:people.registry.id,guardian:people.registry.id,reporter:people.registry.id}]]){
    const state=()=>node.connection.provider.query({request_type:'view_state',finality:'final',account_id:people[name].id,prefix_base64:Buffer.from('STATE').toString('base64'),include_proof:false});
    if(!(await state()).values.some(row=>row.key===Buffer.from('STATE').toString('base64'))){
      await people[name].account.functionCall({contractId:people[name].id,methodName:'new',args:init,gas:100_000_000_000_000n,attachedDeposit:0n});
      await settled(state,value=>value.values.length>0);
    }
  }
  await save();
  console.log(`Persistent workspace ${saved.workspaceId}; chain data retained at ${home}`);
  await serveStudio({sdk,people,rpcUrl,...people,persistent:true,workspaceId:saved.workspaceId,controlToken:process.env.NFA_STUDIO_CONTROL_TOKEN});
}finally{
  if(child&&child.exitCode===null){child.kill();await new Promise(resolve=>{child.once('exit',resolve);setTimeout(resolve,3000).unref()})}
}
