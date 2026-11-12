import {readFile,writeFile} from 'node:fs/promises';
import {createPrivateKey,createPublicKey,createHash} from 'node:crypto';
import {connect,KeyPair,keyStores,transactions,utils} from 'near-api-js';
export const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function testnet(evidencePath){
  const rpcUrl=process.env.NEAR_RPC_URL||'https://test.rpc.fastnear.com';
  async function rpc(method,params){const response=await fetch(rpcUrl,{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:'studio-testnet',method,params}),signal:AbortSignal.timeout(25000)});
    const data=await response.json();if(!response.ok||data.error)throw Error(JSON.stringify(data.error||response.status));return data.result}
  if((await rpc('status',[])).chain_id!=='testnet')throw Error('Only NEAR testnet is authorized');
  let evidence;try{evidence=JSON.parse(await readFile(evidencePath))}catch(error){if(error.code!=='ENOENT')throw error;evidence={steps:{}}}
  const save=()=>writeFile(evidencePath,JSON.stringify(evidence,null,2)+'\n');
  async function finalized(hash,sender){
    for(let i=0;i<120;i++){
      try{const outcome=await rpc('tx',{tx_hash:hash,sender_account_id:sender,wait_until:'FINAL'});
        if(outcome.final_execution_status==='FINAL')return outcome;
      }catch{}
      await pause(1000);
    }
    throw Error(`Transaction ${hash} remains unresolved; no resubmission was made`);
  }
  const keys=new keyStores.InMemoryKeyStore();const node=await connect({networkId:'testnet',nodeUrl:rpcUrl,deps:{keyStore:keys}});
  async function signer(name){const record=JSON.parse(await readFile(`deployments/${name}.key.json`));
    const privateKey=createPrivateKey(record.private_key_pkcs8_pem),pub=createPublicKey(privateKey).export({format:'der',type:'spki'}).subarray(-32);
    const publicKey='ed25519:'+utils.serialize.base_encode(pub);
    if(record.public_key?record.public_key!==publicKey:record.account_id!==pub.toString('hex'))throw Error('Signer record mismatch');
    if(record.network&&record.network!=='testnet')throw Error('Only testnet keys accepted');
    const seed=privateKey.export({format:'der',type:'pkcs8'}).subarray(-32);
    const key=KeyPair.fromString('ed25519:'+utils.serialize.base_encode(Buffer.concat([seed,pub])));
    await keys.setKey('testnet',record.account_id,key);return {id:record.account_id,key,account:await node.account(record.account_id)};
  }
  async function send(label,person,receiver,actions,{failureExpected=false}={}){
    let step=evidence.steps[label],outcome;
    if(step?.outcome){
      if(step.outcome.failed!==failureExpected)throw Error(`Recorded step ${label} has an unexpected outcome; inspect ${step.hash}`);
      return step.outcome;
    }
    if(step){
      if(step.state==='REJECTED'&&step.submissionError?.includes('NotEnoughBalance')){
        const intent=JSON.parse(await readFile(`deployments/studio-${step.hash}.signed.json`));
        if(intent.hash!==step.hash||intent.sender!==person.id)throw Error('Signed intent mismatch');
        await rpc('send_tx',{signed_tx_base64:intent.signed_tx_base64,wait_until:'INCLUDED_FINAL'});
        step.state='SUBMITTED';await save();
      }
      try{outcome=await finalized(step.hash,person.id)}
      catch{throw Error(`Step ${label} has an unresolved transaction ${step.hash}; inspect before retrying`)}}
    else{
      const [digest,signed]=await person.account.signTransaction(receiver,actions);
      step={hash:utils.serialize.base_encode(digest),sender:person.id,receiver,state:'PREPARED',
        nonce:signed.transaction.nonce.toString(),blockHash:utils.serialize.base_encode(signed.transaction.blockHash),at:new Date().toISOString()};
      await writeFile(`deployments/studio-${step.hash}.signed.json`,JSON.stringify({hash:step.hash,sender:person.id,
        signed_tx_base64:Buffer.from(signed.encode()).toString('base64')}),{mode:0o600});
      evidence.steps[label]=step;await save();
      try{await rpc('send_tx',{signed_tx_base64:Buffer.from(signed.encode()).toString('base64'),wait_until:'INCLUDED_FINAL'});
        step.state='SUBMITTED';await save();
      }catch(error){step.submissionError=error.message.slice(0,1200);await save();
        if(!/TIMEOUT|PENDING|Timeout/.test(error.message)){step.state='REJECTED';await save();throw error}}
      outcome=await finalized(step.hash,person.id);
    }
    const value=outcome.status?.SuccessValue;let decoded=null;
    if(value){const text=Buffer.from(value,'base64').toString();try{decoded=JSON.parse(text)}catch{decoded=text}}
    const result={hash:step.hash,failed:!!outcome.status?.Failure,failure:outcome.status?.Failure||null,value:decoded,
      finality:outcome.final_execution_status,events:(outcome.receipts_outcome||[]).flatMap(r=>(r.outcome.logs||[]).filter(l=>l.startsWith('EVENT_JSON:')).map(l=>({executor:r.outcome.executor_id,event:JSON.parse(l.slice(11))}))),
      receipts:(outcome.receipts_outcome||[]).map(r=>({id:r.id,executor:r.outcome.executor_id,gas:r.outcome.gas_burnt,status:r.outcome.status}))};
    step.state='FINAL';step.outcome=result;await save();console.log(`${label}: ${step.hash} ${result.failed?'failed':'succeeded'}`);
    if(result.failed&&!failureExpected)throw Error(`Step ${label} failed: ${JSON.stringify(result.failure)}`);
    if(!result.failed&&failureExpected)throw Error(`Step ${label} unexpectedly succeeded`);
    return result;
  }
  async function upload(label,person,bytes,mime,extension){
    if(bytes.length>1_048_576)throw Error('Single-chunk artifact too large');
    const hash=sha(bytes),path=`studio/${hash}.${extension}`,receiver='outlayer.testnet';
    const u32=n=>{const b=Buffer.alloc(4);b.writeUInt32LE(n);return b};
    const field=b=>Buffer.concat([u32(b.length),b]),str=s=>field(Buffer.from(s));
    const payload=Buffer.concat([Buffer.from([0]),str(path),Buffer.from([1]),str(mime),field(bytes)]);
    const result=await send(label,person,receiver,[transactions.functionCall('__fastdata_fastfs',payload,1n,0n)],{failureExpected:true});
    const url=`https://test.fastfs.io/${person.id}/${receiver}/${path}`;
    for(let i=0;i<30;i++){try{const response=await fetch(url,{signal:AbortSignal.timeout(10000)});
      if(response.ok&&sha(Buffer.from(await response.arrayBuffer()))===hash)return {url,hash,transaction:result.hash};}catch{}
      await pause(500)}throw Error(`Published artifact not yet verified: ${url}`);
  }
  return {rpcUrl,rpc,signer,send,upload,evidence,save,node,
    account:id=>rpc('query',{request_type:'view_account',finality:'final',account_id:id})};
}
