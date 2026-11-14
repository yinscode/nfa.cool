#!/usr/bin/env node
// One paid HTTPS model diagnostic. It is deliberately outside NFA job settlement.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {parseEnv} from 'node:util';
import {createHash} from 'node:crypto';
import {NfaSdk} from '@nfa/sdk';
import {OutlayerHttpsAsync,paymentKeyOwner,verifyResearchDiagnostic} from '../services/worker/outlayer-https-async.mjs';
import {researchSecretAccess} from '../services/worker/outlayer-secrets.mjs';

const phase=process.argv[2]||'preflight';
if(!['preflight','submit','poll'].includes(phase))throw Error('Use preflight, submit or poll');
const registry='nfagent-registry-0e9b2a.testnet',tokenId='nfa-2',vault=`${tokenId}.${registry}`;
const wasmHash='40e425829df5f22253c80a5ede821bbc13bdcafedb846f7faeb6fbb6ebc8772e';
const oldHash='578af9bf7adb3a8d40b749ece673b8a8f25d777f7ed2c881a294628f4e3a7dfe';
const operator='01871de834e09e380684d3cdbdfd4a3d029051ce76957865bbccc19471b35ae8';
const profile='research-v7',jobId=1_000_000_003,journal='.data/research-output-fix-diagnostic.private.json';
const sha=b=>createHash('sha256').update(b).digest('hex');
const sdk=new NfaSdk({registryAccountId:registry,rpcUrl:process.env.NEAR_RPC_URL||'https://test.rpc.fastnear.com'});
const values=parseEnv(await readFile('.env.research','utf8'));
if(!values.NFA_RESEARCH_API_KEY||values.NFA_RESEARCH_PROVIDER!=='near-ai'||!values.NFA_RESEARCH_MODEL)
  throw Error('Dedicated near-ai credential and model required in .env.research');
const [identity,project,setup,secret]=await Promise.all([
  sdk.get(tokenId),sdk.getOutlayerProject(tokenId),
  sdk.view(registry,'payment_key_setup',{token_id:tokenId}).catch(()=>null),
  sdk.view('outlayer.testnet','get_secrets',{accessor:{Project:{project_id:`${vault}/scout`}},profile,owner:operator})]);
if(identity.vaultAccountId!==vault||project?.project_id!==`${vault}/scout`||project.state!=='READY'||
  project.version_key!==oldHash||project.candidate_version!==wasmHash||
  JSON.stringify(secret?.access)!==JSON.stringify(researchSecretAccess(vault,wasmHash)))
  throw Error('Vault, staged WASM or exact secret grant changed');
const keyPackage=JSON.parse(await readFile('.data/outlayer-payment-key-nfa-2.private.json','utf8'));
const key=keyPackage.apiKey;
if(paymentKeyOwner(key)!==vault||keyPackage.projectIds?.length!==1||
  keyPackage.projectIds[0]!==project.project_id||keyPackage.maxPerCallMicrousd!=='100000'||
  (setup?.state==='READY'&&keyPackage.nonce!==setup.nonce))
  throw Error('Private Payment Key owner/nonce changed');
let availableMicrousd=null;
if(setup?.state==='READY'){
  try{const response=await fetch(`https://testnet-api.outlayer.ai/public/payment-keys/${vault}/${setup.nonce}/balance`,
    {signal:AbortSignal.timeout(15000)});
    if(response.ok)availableMicrousd=(await response.json()).available??null;
  }catch{}
}
const ready=setup?.state==='READY'&&Number(availableMicrousd)>=30_000;
if(phase==='preflight'){
  console.log(JSON.stringify({network:'testnet',vault,activeHash:oldHash,candidateHash:wasmHash,
    exactSecretGrant:true,paymentKeyState:setup?.state??null,availableMicrousd,
    provider:'near-ai',modelConfigured:true,readyToSubmit:ready,
    scope:'one paid HTTPS model diagnostic; no NFA job or earnings settlement'}));
  process.exit(0);
}
if(phase==='submit'&&!ready)throw Error('Issued Payment Key with at least $0.03 available is required');
if(phase==='poll'&&setup?.state!=='READY')throw Error('Issued Payment Key is required to poll');
const secretsRef={account_id:operator,profile};
const settings={version_key:wasmHash,secrets_ref:secretsRef,allowed_sources:[{host:'docs.near.org',path_prefix:'/'}],
  model:values.NFA_RESEARCH_MODEL,max_input_tokens:8_000,max_output_tokens:2048,
  input_microusd_per_token:1,output_microusd_per_token:2,max_cost_microusd:30_000,daily_budget_microusd:150_000};
const input={operation:'run',service:'research',jobId,
  question:'How do NEAR access keys authorize actions?',
  sources:[{title:'NEAR access keys',url:'https://docs.near.org/protocol/accounts-contracts/access-keys'}],
  research:{version:1,configuration_hash:`sha256:${sha(JSON.stringify(settings))}`,settings},
  context:{registryAccountId:registry,tokenId,vaultAccountId:vault,ownerEpoch:identity.ownerEpoch,priorWork:[]}};
const client=new OutlayerHttpsAsync({paymentKey:key,vaultId:vault,projectId:project.project_id,versionKey:wasmHash});
const base={scope:'HTTPS model diagnostic only; no NFA settlement',vault,projectId:project.project_id,
  wasmHash,jobId,inputHash:sha(JSON.stringify(input)),ownerEpoch:identity.ownerEpoch};
const recordCompleted=(row,result)=>{
  const output=typeof result.output==='string'?JSON.parse(result.output):result.output;
  if(output?.jobId!==jobId||output.schemaVersion!==1)throw Error('Diagnostic output identity changed');
  if(output.status==='ok')Object.assign(row,verifyResearchDiagnostic(result,jobId),{accepted:true});
  else if(output.status==='failed'&&['customer','operator'].includes(output.fault)){
    Object.assign(row,{accepted:false,outputStatus:output.status,fault:output.fault,
      inferenceOutcome:output.inferenceOutcome??null,pricedUsageMicrousd:output.pricedUsageMicrousd??null,
      computeCostMicrousd:result.compute_cost??null});
  }else throw Error('Unexpected Research diagnostic output');
};
await mkdir('.data',{recursive:true});
if(phase==='submit'){
  await writeFile(journal,JSON.stringify({...base,status:'submission_unknown'},null,2)+'\n',{flag:'wx',mode:0o600});
  const admission=await client.submitResearchDiagnostic(input,secretsRef);
  const row={...base,status:admission.status,callId:admission.callId};
  if(admission.status==='completed')recordCompleted(row,admission.result);
  await writeFile(journal,JSON.stringify(row,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({status:row.status,callId:row.callId,jobId,scope:base.scope}));
}else{
  const saved=JSON.parse(await readFile(journal,'utf8'));
  if(saved.vault!==vault||saved.wasmHash!==wasmHash||saved.inputHash!==base.inputHash||!saved.callId)
    throw Error('Diagnostic journal differs from the pinned input or has no admitted call ID');
  const result=await client.poll(saved.callId);
  const row={...saved,status:result.status};
  if(result.status==='completed')recordCompleted(row,result);
  await writeFile(journal,JSON.stringify(row,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({status:row.status,callId:row.callId,
    outputHash:row.outputHash??null,pricedUsageMicrousd:row.pricedUsageMicrousd??null,
    computeCostMicrousd:row.computeCostMicrousd??null,accepted:row.accepted??null,
    inferenceOutcome:row.inferenceOutcome??null,scope:base.scope}));
}
