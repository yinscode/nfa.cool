#!/usr/bin/env node
// FastFS simple upload, compatible with the OutLayer CLI's on-chain format.
// Only the public WASM is sent; the private key stays in the local key file.
import {createHash,createPrivateKey,createPublicKey} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {KeyPair,transactions,utils} from 'near-api-js';

const rpcUrl=process.env.NEAR_RPC_URL||'https://test.rpc.fastnear.com';
const keyPath=process.env.NFA_UPLOAD_KEY_PATH||'deployments/t006-alice.key.json';
const wasmPath=process.env.NFA_UPLOAD_WASM_PATH||'releases/nfa-scout-compare-b2cf2dd2b606ec15.wasm';
const outputPath=process.env.NFA_UPLOAD_RECORD_PATH||'deployments/outlayer-upload-public.json';
const receiver='outlayer.testnet';
const u32=n=>{const b=Buffer.alloc(4);b.writeUInt32LE(n);return b};
const field=b=>Buffer.concat([u32(b.length),b]);
const string=s=>field(Buffer.from(s));
async function rpc(method,params){
  const response=await fetch(rpcUrl,{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:'nfa-fastfs',method,params}),signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw Error(`RPC HTTP ${response.status}`);
  const data=await response.json();if(data.error)throw Error(JSON.stringify(data.error));return data.result;
}
async function main(){
  const bytes=await readFile(wasmPath);
  if(bytes.length<100||bytes.length>1_048_576)throw Error('Expected a single-chunk WASM release');
  const hash=createHash('sha256').update(bytes).digest('hex');
  const record=JSON.parse(await readFile(keyPath,'utf8'));
  if(record.network!=='testnet'||!record.account_id||!record.private_key_pkcs8_pem)throw Error('Testnet key required');
  const privateKey=createPrivateKey(record.private_key_pkcs8_pem);
  const publicRaw=createPublicKey(privateKey).export({format:'der',type:'spki'}).subarray(-32);
  const publicKey='ed25519:'+utils.serialize.base_encode(publicRaw);
  if(record.public_key!==publicKey)throw Error('Key record mismatch');
  const seed=privateKey.export({format:'der',type:'pkcs8'}).subarray(-32);
  const pair=KeyPair.fromString('ed25519:'+utils.serialize.base_encode(Buffer.concat([seed,publicRaw])));
  const relativePath=hash+'.wasm';
  const payload=Buffer.concat([Buffer.from([0]),string(relativePath),Buffer.from([1]),
    string('application/wasm'),field(bytes)]);
  const url=`https://test.fastfs.io/${record.account_id}/${receiver}/${relativePath}`;
  const summary={sender:record.account_id,receiver,wasmSha256:hash,wasmBytes:bytes.length,
    payloadBytes:payload.length,url};
  if(!process.argv.includes('--send')){console.log(JSON.stringify({...summary,dryRun:true},null,2));return}
  if(process.argv.includes('--reconcile'))throw Error('Use --reconcile alone');
  const status=await rpc('status',[]);
  if(status.chain_id!=='testnet')throw Error('Wrong chain');
  const key=await rpc('query',{request_type:'view_access_key',finality:'final',
    account_id:record.account_id,public_key:publicKey});
  if(key.permission!=='FullAccess')throw Error('Uploader requires a full-access testnet key');
  const action=transactions.functionCall('__fastdata_fastfs',payload,1n,0n);
  const tx=transactions.createTransaction(record.account_id,pair.getPublicKey(),receiver,
    BigInt(key.nonce)+1n,[action],utils.serialize.base_decode(key.block_hash));
  const digest=createHash('sha256').update(tx.encode()).digest();
  const signed=new transactions.SignedTransaction({transaction:tx,
    signature:new transactions.Signature({keyType:0,data:pair.sign(digest).signature})});
  const txHash=utils.serialize.base_encode(digest);
  const receipt={...summary,txHash,preparedAt:new Date().toISOString(),state:'PREPARED'};
  await writeFile(outputPath,JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o644});
  const accepted=await rpc('broadcast_tx_async',[Buffer.from(signed.encode()).toString('base64')]);
  if(accepted!==txHash)throw Error(`Unexpected upload transaction hash ${accepted}`);
  const submitted={...receipt,state:'SUBMITTED',submittedAt:new Date().toISOString()};
  await writeFile(outputPath,JSON.stringify(submitted,null,2)+'\n');
  console.log(JSON.stringify(submitted,null,2));
}
async function reconcile(){
  const record=JSON.parse(await readFile(outputPath,'utf8'));
  const tx=await rpc('tx',{tx_hash:record.txHash,sender_account_id:record.sender,
    wait_until:'EXECUTED_OPTIMISTIC'});
  console.log(JSON.stringify({txHash:record.txHash,finalExecutionStatus:tx.final_execution_status,
    included:!!tx.transaction_outcome,failedAsExpected:!!tx.status?.Failure,url:record.url},null,2));
}
(process.argv.includes('--reconcile')?reconcile():main()).catch(error=>{console.error(error.message);process.exitCode=1});
