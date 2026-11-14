#!/usr/bin/env node
import {readFile,writeFile} from 'node:fs/promises';
import {parseEnv} from 'node:util';
import {transactions,utils} from 'near-api-js';
import {NfaSdk} from '@nfa/sdk';
import {testnet,pause} from './testnet-lib.mjs';
import {schemaHashFor} from '../services/api/service-runtime.mjs';
import {researchSecretAccess} from '../services/worker/outlayer-secrets.mjs';

const phase=process.argv[2]||'verify';
if(!['activate','configure','verify'].includes(phase))throw Error('Use activate, configure or verify');
const long=process.argv[3]==='long';if(process.argv[3]&&!long)throw Error('Use optional long mode');
const options=process.argv.slice(4);
if(options.some(option=>!['fast','memory'].includes(option))||new Set(options).size!==options.length)
  throw Error('Use optional fast and/or memory configuration');
const fast=options.includes('fast'),memory=options.includes('memory');
const registryHash=long?'f9c750ad48e369b79e65f3de6c6533602b09658c3202e389d96dbfba154c1353':
  'f989bfe9bc179b14b4272334f4f819663df5d5186132a88a03eb3f01de3acae4';
const wasmHash=long?'a8513acd137f37ce21a820e8d2e9b92b9712970e3c3710b41a4e26df06137588':
  '40e425829df5f22253c80a5ede821bbc13bdcafedb846f7faeb6fbb6ebc8772e';
const profile=long?'research-v8':'research-v7';
const ctx=await testnet(long?'deployments/research-long-activation.json':'deployments/async-research-activation.json');
const registry=await ctx.signer('t006-registry'),alice=await ctx.signer('t006-alice'),
  bob=await ctx.signer('t008-bob'),operator=await ctx.signer('t004-operator');
const sdk=new NfaSdk({registryAccountId:registry.id,rpcUrl:ctx.rpcUrl});
const hash=Buffer.from(utils.serialize.base_decode((await ctx.account(registry.id)).code_hash)).toString('hex');
if(hash!==registryHash)throw Error('Async Research registry is not deployed');
const tokenId='nfa-2',identity=await sdk.get(tokenId),project=await sdk.getOutlayerProject(tokenId);
const owner=identity.ownerAccountId===alice.id?alice:identity.ownerAccountId===bob.id?bob:null;
if(!owner||project?.state!=='READY'||
  project.project_id!==`${identity.vaultAccountId}/scout`)throw Error('NFA owner or Project changed');
const secret=await sdk.view('outlayer.testnet','get_secrets',{accessor:{Project:{project_id:project.project_id}},
  profile,owner:operator.id});
if(JSON.stringify(secret?.access)!==JSON.stringify(researchSecretAccess(identity.vaultAccountId,wasmHash)))
  throw Error('Exact guest secret access changed');
const until=async(work,check)=>{for(let i=0;i<100;i++){const v=await work();if(check(v))return v;await pause(500)}
  throw Error('Final state not observed; inspect journal')};
const send=(label,a)=>ctx.send(label,owner,a.receiverId,[transactions.functionCall(a.methodName,a.args,BigInt(a.gas),BigInt(a.deposit))]);
if(phase==='activate'&&project.version_key!==wasmHash){
  if(project.candidate_version!==wasmHash)throw Error('Expected candidate missing');
  await send('activateAsyncResearchGuest',sdk.activateOutlayerVersion(tokenId));
  await until(()=>sdk.getOutlayerProject(tokenId),p=>p.state==='READY'&&p.version_key===wasmHash);
}
if(phase==='configure'){
  if(project.version_key!==wasmHash)throw Error('Activate guest first');
  const env=parseEnv(await readFile('.env.research','utf8'));
  if(env.NFA_RESEARCH_PROVIDER!=='near-ai'||!env.NFA_RESEARCH_API_KEY||!env.NFA_RESEARCH_MODEL)
    throw Error('Dedicated near-ai credential/model required');
  const model=fast?'openai/gpt-4.1-mini':env.NFA_RESEARCH_MODEL;
  const settings={version_key:wasmHash,secrets_ref:{account_id:operator.id,profile},
    allowed_sources:[{host:'docs.near.org',path_prefix:'/'}],model,
    max_input_tokens:memory?12000:8000,max_output_tokens:2048,input_microusd_per_token:1,
    output_microusd_per_token:2,max_cost_microusd:30000,daily_budget_microusd:150000};
  const configured=await sdk.getResearchConfig(tokenId);
  if(configured?.settings?.version_key!==wasmHash||configured?.settings?.model!==model||
    configured?.settings?.max_input_tokens!==settings.max_input_tokens||
    configured?.settings?.secrets_ref?.profile!==profile||
    configured?.settings?.max_output_tokens!==2048)
    await send(fast?'configureFastResearch':memory?'configureMemoryResearch':'configureAsyncResearch',
      sdk.configureResearch(tokenId,settings));
  const policy=await sdk.getServicePolicy(tokenId,'research');
  if(!policy?.enabled||policy.schema_hash!==schemaHashFor('research'))
    await send('enableAsyncResearchService',sdk.configureService(tokenId,'research',schemaHashFor('research'),
      true,'10000000000000000000000','500000000000000000000000',
      {max_instructions:1000000000,max_memory_mb:128,max_execution_seconds:30}));
}
const active=await sdk.getOutlayerProject(tokenId),config=await sdk.getResearchConfig(tokenId),
  policy=await sdk.getServicePolicy(tokenId,'research'),setup=await sdk.view(registry.id,'payment_key_setup',{token_id:tokenId});
const ready=active.version_key===wasmHash&&config?.settings?.version_key===wasmHash&&
  config?.settings?.secrets_ref?.profile===profile&&config.settings.max_output_tokens===2048&&
  policy?.enabled&&setup?.state==='READY';
if(phase==='verify'&&!ready)throw Error('Research is not ready for a paid HTTPS job');
const evidence={checkedAt:new Date().toISOString(),network:'NEAR testnet',registryHash,wasmHash,
  projectUuid:active.project_uuid,ownerEpoch:identity.ownerEpoch,secretBound:true,
  paymentKeyState:setup?.state,configurationHash:config?.configuration_hash,
  maxInputTokens:config?.settings?.max_input_tokens,
  researchPolicyVersion:policy?.version,ready,
  transactions:Object.fromEntries(Object.entries(ctx.evidence.steps).map(([k,v])=>[k,{hash:v.hash,failed:v.outcome?.failed}]))};
await writeFile(long?'docs/evidence/research-long-activation.json':'docs/evidence/async-research-activation.json',
  JSON.stringify(evidence,null,2)+'\n');
console.log(JSON.stringify({phase,ready,wasmHash,configurationHash:evidence.configurationHash}));
