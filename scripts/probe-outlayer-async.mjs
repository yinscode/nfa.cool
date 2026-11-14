#!/usr/bin/env node
// Testnet transport probe only. It recalls finalized work; it does not create or settle an NFA job.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {parseEnv} from 'node:util';
import {NfaSdk} from '@nfa/sdk';
import {OutlayerHttpsAsync,paymentKeyOwner,verifyRecallResult} from '../services/worker/outlayer-https-async.mjs';

const phase=process.argv[2]||'preflight';
if(!['preflight','submit','poll'].includes(phase))throw Error('Use preflight, submit or poll');
const registryAccountId='nfagent-registry-0e9b2a.testnet',tokenId='nfa-2',jobId=26;
const sdk=new NfaSdk({registryAccountId,rpcUrl:process.env.NEAR_RPC_URL||'https://test.rpc.fastnear.com'});
const [identity,project,job,reviewed]=await Promise.all([
  sdk.get(tokenId),sdk.getOutlayerProject(tokenId),sdk.getServiceJob(tokenId,jobId),
  readFile('docs/evidence/m06-reviewed-runtime.json','utf8').then(JSON.parse)]);
if(!identity?.vaultAccountId||project?.project_id!==`${identity.vaultAccountId}/scout`||
  project?.state!=='READY'||project?.version_key!==reviewed.sha256||
  job?.job?.status!=='FINALIZED'||job?.service_id!=='scout'||
  !/^sha256:[a-f0-9]{64}$/.test(job.job.output_hash||''))
  throw Error('Live vault, pinned Project or finalized Scout commitment changed');

let key=process.env.OUTLAYER_TESTNET_PAYMENT_KEY||'';
if(!key){try{key=parseEnv(await readFile('.env.research','utf8')).OUTLAYER_TESTNET_PAYMENT_KEY||''}catch{}}
if(!key){try{
  const prepared=JSON.parse(await readFile('.data/outlayer-payment-key-nfa-2.private.json','utf8'));
  if(prepared.owner===identity.vaultAccountId&&prepared.projectIds?.length===1&&
    prepared.projectIds[0]===project.project_id)key=prepared.apiKey||'';
}catch{}}
const keyOwner=key?paymentKeyOwner(key):null,ownerMatches=keyOwner===identity.vaultAccountId;
const setup=await sdk.view(registryAccountId,'payment_key_setup',{token_id:tokenId}).catch(()=>null);
let availableMicrousd=null;
if(ownerMatches&&setup?.state==='READY'){
  const nonce=Number(key.split(':')[1]);
  if(Number.isSafeInteger(nonce)&&nonce===setup.nonce){
    try{const response=await fetch(`https://testnet-api.outlayer.ai/public/payment-keys/${identity.vaultAccountId}/${nonce}/balance`,
      {signal:AbortSignal.timeout(15000)});
      if(response.ok)availableMicrousd=(await response.json()).available??null;
    }catch{}
  }
}
const readyToSubmit=ownerMatches&&setup?.state==='READY'&&
  availableMicrousd!==null&&Number(availableMicrousd)>0;
const journalPath='.data/outlayer-https-async-recall.json';
if(phase==='preflight'){
  console.log(JSON.stringify({network:'testnet',projectId:project.project_id,versionKey:project.version_key,
    recallJobId:jobId,paymentKeyConfigured:!!key,paymentKeyOwnerMatches:ownerMatches,
    paymentKeyOnchainState:setup?.state??null,availableMicrousd,readyToSubmit,
    scope:'transport-and-vault-memory-only; no model inference or on-chain settlement'}));
  process.exit(0);
}
if(phase==='submit'&&!readyToSubmit)throw Error('Issued, funded, vault-owned OutLayer Payment Key is required');
if(phase==='poll'&&(!ownerMatches||setup?.state!=='READY'))throw Error('Issued vault-owned Payment Key is required to poll');
const client=new OutlayerHttpsAsync({paymentKey:key,vaultId:identity.vaultAccountId,
  projectId:project.project_id,versionKey:project.version_key});
await mkdir('.data',{recursive:true});
const base={network:'testnet',projectId:project.project_id,versionKey:project.version_key,
  vaultId:identity.vaultAccountId,jobId,service:'scout',expectedHash:job.job.output_hash};
if(phase==='submit'){
  // A journal exists before any paid POST. Unknown outcomes must never be retried blindly.
  await writeFile(journalPath,JSON.stringify({...base,status:'submission_unknown'},null,2)+'\n',{flag:'wx',mode:0o600});
  const admission=await client.submitRecall(base);
  const row={...base,status:admission.status,callId:admission.callId};
  if(admission.status==='completed')Object.assign(row,verifyRecallResult(admission.result,base));
  await writeFile(journalPath,JSON.stringify(row,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({status:row.status,callId:row.callId,jobId}));
}else{
  const saved=JSON.parse(await readFile(journalPath,'utf8'));
  if(saved.vaultId!==base.vaultId||saved.projectId!==base.projectId||
    saved.versionKey!==base.versionKey||saved.expectedHash!==base.expectedHash||!saved.callId)
    throw Error('Probe journal does not match the live finalized commitment');
  const result=await client.poll(saved.callId);
  const row={...saved,status:result.status};
  if(result.status==='completed')Object.assign(row,verifyRecallResult(result,base));
  await writeFile(journalPath,JSON.stringify(row,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({status:row.status,callId:row.callId,jobId,
    outputHash:row.status==='completed'?row.outputHash:undefined,
    computeCostMicrousd:row.status==='completed'?row.computeCostMicrousd:undefined}));
}
