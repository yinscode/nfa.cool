#!/usr/bin/env node
// One operator-cell HTTPS transport probe. This is not an NFA job or vault-memory test.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {NfaSdk} from '@nfa/sdk';
import {paymentKeyOwner} from '../services/worker/outlayer-https-async.mjs';

const phase=process.argv[2];if(!['submit','poll'].includes(phase))throw Error('Use submit or poll');
const registry='nfagent-registry-0e9b2a.testnet',projectId=`nfa-2.${registry}/scout`;
const sdk=new NfaSdk({registryAccountId:registry,rpcUrl:process.env.NEAR_RPC_URL||'https://test.rpc.fastnear.com'});
const p=JSON.parse(await readFile('.data/outlayer-operator-payment-key.private.json','utf8'));
if(paymentKeyOwner(p.apiKey)!==p.owner||p.projectIds?.length!==1||p.projectIds[0]!==projectId)
  throw Error('Operator Payment Key binding changed');
const project=await sdk.getOutlayerProject('nfa-2');
if(project?.project_id!==projectId||project.state!=='READY')throw Error('Pinned Project unavailable');
const input={operation:'run',service:'scout',jobId:1_000_000_001,
  question:'What remains with the NFA after its NFT changes owner?',
  sources:[{title:'NFA vault continuity',url:'https://docs.near.org/',
    text:'The NFA vault account and its OutLayer Project remain attached to the NFT after the owner changes. The buyer receives current control while the former owner loses authority.'}]};
const digest=createHash('sha256').update(JSON.stringify(input)).digest('hex');
const path='.data/outlayer-operator-https-scout.json';
const endpoint=`https://testnet-api.outlayer.ai/call/${projectId}`;
const json=async(response)=>{const raw=await response.text();if(raw.length>64_000)throw Error('OutLayer response too large');return JSON.parse(raw)};
const balance=await fetch(`https://testnet-api.outlayer.ai/public/payment-keys/${p.owner}/${p.nonce}/balance`,
  {signal:AbortSignal.timeout(15000)}).then(json);
if(phase==='submit'){
  if(Number(balance.available)<30_000)throw Error('Operator Payment Key has insufficient balance');
  await mkdir('.data',{recursive:true});
  const base={network:'testnet',scope:'Operator-cell HTTPS Scout diagnostic only; no NFA settlement',
    projectId,versionKey:project.version_key,jobId:input.jobId,inputHash:digest,
    paymentKeyOwner:p.owner,status:'submission_unknown',createdAt:new Date().toISOString()};
  await writeFile(path,JSON.stringify(base,null,2)+'\n',{flag:'wx',mode:0o600});
  const response=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json',
    'x-payment-key':p.apiKey,'x-compute-limit':'30000'},
    body:JSON.stringify({input,async:true,version_key:project.version_key,
      resource_limits:{max_instructions:1_000_000_000,max_memory_mb:128,max_execution_seconds:30}}),
    signal:AbortSignal.timeout(15_000)});
  const result=await json(response);
  if(!response.ok)throw Error(`OutLayer HTTPS call declined (HTTP ${response.status}); inspect journal before retrying`);
  if(!/^[a-f0-9-]{36}$/i.test(result.call_id||''))throw Error('OutLayer admission has no call ID');
  const row={...base,status:result.status,callId:result.call_id};
  await writeFile(path,JSON.stringify(row,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({status:row.status,callId:row.callId,jobId:row.jobId}));
}else{
  const row=JSON.parse(await readFile(path,'utf8'));
  if(row.projectId!==projectId||row.versionKey!==project.version_key||row.inputHash!==digest||!row.callId)
    throw Error('Operator HTTPS journal or Project changed');
  const response=await fetch(`https://testnet-api.outlayer.ai/calls/${row.callId}`,{
    headers:{'x-payment-key':p.apiKey},signal:AbortSignal.timeout(15000)});
  const result=await json(response);
  if(!response.ok||result.call_id!==row.callId)throw Error('OutLayer HTTPS poll failed');
  const next={...row,status:result.status};
  if(result.status==='completed'){
    const output=typeof result.output==='string'?JSON.parse(result.output):result.output;
    if(output?.jobId!==input.jobId||output?.status!=='ok'||
      !/^sha256:[a-f0-9]{64}$/.test(output.outputHash||''))throw Error('Scout diagnostic output invalid');
    Object.assign(next,{outputHash:output.outputHash,computeCostMicrousd:result.compute_cost??null,
      attestationUrl:result.attestation_url??null});
  }
  if(result.status==='failed')next.error=String(result.error||'unknown').slice(0,400);
  await writeFile(path,JSON.stringify(next,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({status:next.status,callId:next.callId,outputHash:next.outputHash??null,
    computeCostMicrousd:next.computeCostMicrousd??null,error:next.error??null}));
}
