#!/usr/bin/env node
// Phased testnet acceptance. Public REST remains gated until real inference + buyer continuity pass.
import {readFile,writeFile} from 'node:fs/promises';
import {loadEnvFile} from 'node:process';
import {createHash} from 'node:crypto';
import {transactions,utils} from 'near-api-js';
import {NfaSdk} from '@nfa/sdk';
import {testnet,pause} from './testnet-lib.mjs';
import {quoteService,schemaHashFor} from '../services/api/service-runtime.mjs';
import {researchEncryptionKey,researchSecretAccess,sealOutlayerSecrets} from '../services/worker/outlayer-secrets.mjs';
import {hostedExecutionEvidence} from './hosted-execution-evidence.mjs';
const phase=process.argv[2]||'inspect';
if(!['inspect','upload','upgrade','secrets-smoke','secrets','stage','activate','configure-smoke','configure','smoke','legacy','research','handover','buyer','verify'].includes(phase))throw Error('Unknown M06 phase');
const ctx=await testnet('deployments/m06-research.json'),registry=await ctx.signer('t006-registry'),operator=await ctx.signer('t004-operator'),
  alice=await ctx.signer('t006-alice'),bob=await ctx.signer('t008-bob'),customer=await ctx.signer('studio-funder');
const tokenId='nfa-2',sdk=new NfaSdk({registryAccountId:registry.id,rpcUrl:ctx.rpcUrl});
const runtime=JSON.parse(await readFile('docs/evidence/m04-runtime.json','utf8')),
  rehearsal=JSON.parse(await readFile('docs/m03-upgrade-rehearsal.json','utf8'));
const hash=b=>createHash('sha256').update(b).digest('hex');
const until=async(work,predicate)=>{for(let i=0;i<100;i++){const result=await work();if(predicate(result))return result;await pause(500)}throw Error('Finalized state not ready; rerun same phase')};
const action=(label,who,a,options)=>ctx.send(label,who,a.receiverId,[transactions.functionCall(a.methodName,a.args,BigInt(a.gas),BigInt(a.deposit))],options);
const identity=await sdk.get(tokenId),vault=identity.vaultAccountId,project=await sdk.getOutlayerProject(tokenId);
if(!ctx.evidence.initial){ctx.evidence.initial={vault,address:identity.foreignWallet.address,projectUuid:project.project_uuid,projectId:project.project_id};await ctx.save()}
const initial=ctx.evidence.initial;
if(initial.vault!==vault||initial.projectUuid!==project.project_uuid||initial.address!==identity.foreignWallet.address)throw Error('Stable NFA identity changed');
const owner=identity.ownerAccountId===alice.id?alice:identity.ownerAccountId===bob.id?bob:null;
if(!owner)throw Error('Unexpected NFA owner');
async function assertIdle(){
  const [a,s]=await Promise.all([sdk.getAgentState(tokenId),sdk.view(vault,'status')]);
  if(a.pending_op!=null||s.pending!=null||a.lifecycle!=='Active')throw Error('NFA must be active with no pending authority');return s;
}
const limits={max_instructions:1000000000,max_memory_mb:128,max_execution_seconds:30};
const policy={limits,marginYocto:'10000000000000000000000',maxDepositYocto:'500000000000000000000000'};
async function run(label,service,input){
  let record=ctx.evidence[label];
  if(!record){
    const existing=await sdk.getServicePolicy(tokenId,service);
    const compatible=service==='research'||!existing?policy:{...policy,limits:existing.limits,
      maxDepositYocto:(BigInt(existing.max_deposit)<BigInt(policy.maxDepositYocto)?BigInt(existing.max_deposit):BigInt(policy.maxDepositYocto)).toString()};
    const quote=await quoteService({sdk,tokenId,service,body:{input},policy:{[service]:compatible},allowResearchCandidate:true});
    record={quote,input};ctx.evidence[label]=record;await ctx.save();
  }
  const paid=await action(label+'Pay',customer,record.quote.unsignedAction);
  const id=paid.value;if(!Number.isSafeInteger(id))throw Error('Missing assigned job ID');
  record.id=id;await ctx.save();
  await action(label+'Start',customer,sdk.startServiceJob(tokenId,id,record.quote.inputData));
  record.result=await until(()=>sdk.getServiceJob(tokenId,id),r=>['FINALIZED','FAILED','UNCERTAIN'].includes(r?.job?.status));
  await ctx.save();return record;
}
function configValues(smoke){
  if(!smoke){
    try{loadEnvFile('.env.research')}catch{throw Error('Place the dedicated model credential/configuration in .env.research before this phase')}
    if(!process.env.NFA_RESEARCH_API_KEY||!['near-ai','openai'].includes(process.env.NFA_RESEARCH_PROVIDER)||!process.env.NFA_RESEARCH_MODEL)
      throw Error('Dedicated NFA_RESEARCH_API_KEY, NFA_RESEARCH_PROVIDER and NFA_RESEARCH_MODEL required');
  }
  return {version_key:runtime.sha256,secrets_ref:{account_id:operator.id,profile:smoke?'research-v3-smoke':'research-v3'},
    allowed_sources:[{host:'docs.near.org',path_prefix:'/'}],model:smoke?'no-model-smoke':process.env.NFA_RESEARCH_MODEL,
    max_input_tokens:24000,max_output_tokens:512,input_microusd_per_token:1,output_microusd_per_token:2,
    max_cost_microusd:30000,daily_budget_microusd:150000};
}
if(phase==='upload'){
  const bytes=await readFile(runtime.artifact);if(hash(bytes)!==runtime.sha256)throw Error('Pinned guest mismatch');
  ctx.evidence.upload=await ctx.upload('researchRuntimeUpload',customer,bytes,'application/wasm','wasm');await ctx.save();
}else if(phase==='upgrade'){
  const m02=JSON.parse(await readFile('docs/evidence/m02-handover.json','utf8'));if(!m02.complete)throw Error('Complete M02 before live upgrades');
  const status=await assertIdle(),code=await readFile(`releases/nfa-registry-research-${rehearsal.newCodeSha256.slice(0,16)}.wasm`),
    vaultCode=await readFile(`releases/nfa-vault-research-${rehearsal.vaultCodeSha256.slice(0,16)}.wasm`);
  if(hash(code)!==rehearsal.newCodeSha256||hash(vaultCode)!==rehearsal.vaultCodeSha256)throw Error('Rehearsed contract hash mismatch');
  const deployed=await ctx.account(registry.id),deployedHash=Buffer.from(utils.serialize.base_decode(deployed.code_hash)).toString('hex');
  if(![rehearsal.oldCodeSha256,rehearsal.newCodeSha256].includes(deployedHash))throw Error('Unexpected deployed registry release');
  await ctx.send('researchRegistryUpgrade',registry,registry.id,[transactions.deployContract(code)]);
  await action('researchVaultUpgrade',operator,{receiverId:vault,methodName:'emergency_upgrade',args:{code:vaultCode.toString('base64')},gas:'100000000000000',deposit:'0'});
  const after=await until(()=>sdk.view(vault,'status'),s=>s.research_interface===1);
  const {research_interface,...preserved}=after,{research_interface:oldInterface,...old}=status;
  if(JSON.stringify(preserved)!==JSON.stringify(old))throw Error('Vault state changed during upgrade');
  await action('verifyResearchVault',owner,sdk.verifyResearchVault(tokenId));
  if(!await sdk.view(registry.id,'research_vault_capable',{token_id:tokenId}))throw Error('Upgraded vault not verified');
  ctx.evidence.upgrade={registrySha256:hash(code),vaultSha256:hash(vaultCode),preservedStatus:preserved};await ctx.save();
}else if(phase==='secrets'||phase==='secrets-smoke'){
  const smoke=phase==='secrets-smoke',settings=configValues(smoke),profile=settings.secrets_ref.profile;
  const pubkey=await researchEncryptionKey({owner:operator.id,profile,projectId:project.project_id});
  const secrets=smoke?{NFA_RESEARCH_PROVIDER:'near-ai'}:{NFA_RESEARCH_API_KEY:process.env.NFA_RESEARCH_API_KEY,NFA_RESEARCH_PROVIDER:process.env.NFA_RESEARCH_PROVIDER};
  const accessor={Project:{project_id:project.project_id}},access=researchSecretAccess(vault,runtime.sha256);
  await action(smoke?'storeSmokeSecret':'storeResearchSecret',operator,{receiverId:'outlayer.testnet',methodName:'store_secrets',
    args:{accessor,profile,encrypted_secrets_base64:sealOutlayerSecrets(pubkey,secrets),access,vault_id:null},gas:'50000000000000',deposit:'100000000000000000000000'});
  const row=await until(()=>sdk.view('outlayer.testnet','get_secrets',{accessor,profile,owner:operator.id}),r=>!!r);
  if(JSON.stringify(row.access)!==JSON.stringify(access))throw Error('Stored secret access differs from the vault/build grant');
  // Never serialize row ciphertext or plaintext values into public evidence.
  ctx.evidence[smoke?'smokeSecret':'researchSecret']={owner:operator.id,profile,access,stored:!!row};await ctx.save();
}else if(phase==='stage'){
  await assertIdle();if(!ctx.evidence.upload)throw Error('Upload the pinned runtime first');
  await action('stageResearchVersion',owner,sdk.addOutlayerVersion(tokenId,ctx.evidence.upload.url,runtime.sha256,'10000000000000000000000'));
}else if(phase==='activate'){
  await assertIdle();await action('activateResearchVersion',owner,sdk.activateOutlayerVersion(tokenId));
}else if(phase==='configure'||phase==='configure-smoke'){
  await assertIdle();const settings=configValues(phase==='configure-smoke');
  await action(phase+'Research',owner,sdk.configureResearch(tokenId,settings));
  await action(phase+'Policy',owner,sdk.configureService(tokenId,'research',schemaHashFor('research'),true,policy.marginYocto,policy.maxDepositYocto,limits));
}else if(phase==='smoke'){
  const result=await run('smoke','research',{question:'How does NEAR represent accounts?',sources:[{title:'NEAR documentation',url:'https://docs.near.org/'}]});
  if(result.result.job.status!=='FAILED'||result.result.research_usage.state!=='NOT_STARTED')throw Error('Hosted no-key failure did not classify as not started');
  await action('resumeAfterSmoke',owner,{receiverId:registry.id,methodName:'resume_failed_service',args:{token_id:tokenId,failed_job_id:result.id},gas:'100000000000000',deposit:'1'});
}else if(phase==='legacy'){
  for(const service of ['scout','compare']){
    const input={question:'What follows the NFA when sold?',sources:[{title:'Vault',url:'https://docs.near.org/',text:'The NFA vault and its agent memory stay with the NFT when ownership changes.'}]};
    if(service==='compare'){input.criteria=['memory'];input.sources.push({title:'Signer',url:'https://docs.near.org/accounts-contracts/account',text:'A human signer can change while the agent vault and memory remain the same.'})}
    const result=await run('legacy'+service,service,input);if(result.result.job.status!=='FINALIZED')throw Error('Legacy handler acceptance failed');
  }
}else if(phase==='research'||phase==='buyer'){
  if(phase==='buyer'&&identity.ownerAccountId!==bob.id)throw Error('Buyer must own the NFA');
  const result=await run(phase,'research',{question:phase==='buyer'?'Which NEAR account facts remain useful after an NFT ownership change?':'How are NEAR accounts and their keys related?',
    sources:[{title:'NEAR accounts',url:'https://docs.near.org/protocol/accounts-contracts/access-keys'}]});
  if(result.result.job.status!=='FINALIZED'||result.result.research_usage.state!=='PRICED_USAGE')throw Error('Research did not finalize with model usage');
}else if(phase==='handover'){
  if(ctx.evidence.research?.result?.job.status!=='FINALIZED')throw Error('First paid research must finalize before handover');
  if(identity.ownerAccountId===alice.id){
    await action('listResearchNfa',alice,sdk.listForSale(tokenId,'1000000000000000000000',Number(BigInt(Date.now()+3600000)*1000000n)));
    const listing=(await until(()=>sdk.get(tokenId),n=>!!n.listing)).listing;await action('buyResearchNfa',bob,sdk.buy(tokenId,listing.nonce,listing.price));
  }
  await until(()=>sdk.get(tokenId),n=>n.ownerAccountId===bob.id);
  const recallDeposit=ctx.evidence.research.quote.depositCapYocto;
  await action('oldOwnerRecallDenied',alice,sdk.recallOwnerMemory(tokenId,ctx.evidence.research.id,recallDeposit),{failureExpected:true});
  await action('buyerRecall',bob,sdk.recallOwnerMemory(tokenId,ctx.evidence.research.id,recallDeposit));
}else if(phase==='verify'){
  if(!ctx.evidence.research||!ctx.evidence.buyer||!ctx.evidence.legacyscout||!ctx.evidence.legacycompare||
    !ctx.evidence.steps.buyerRecall?.outcome||!ctx.evidence.steps.oldOwnerRecallDenied?.outcome?.failed)
    throw Error('Paid research, buyer repeat, recall and old-owner denial must all complete');
  await assertIdle();const current=await sdk.get(tokenId);
  if(current.ownerAccountId!==bob.id||project.version_key!==runtime.sha256)throw Error('Buyer or active runtime differs');
  for(const label of ['legacyscout','legacycompare','research','buyer']){
    const live=await sdk.getServiceJob(tokenId,ctx.evidence[label].id);
    if(live.job.status!=='FINALIZED'||live.job.version_key!==runtime.sha256)throw Error('Hosted job not finalized on the pinned runtime');
    if(['research','buyer'].includes(label)&&live.research_usage?.state!=='PRICED_USAGE')throw Error('Real inference usage not recorded');
    ctx.evidence[label].result=live;
  }
  const ledger=await sdk.getPaidLedger();if(ledger.customer_escrow!=='0'||ledger.vault_replenishment_pending!=='0')throw Error('Native ledger still has pending liabilities');
  const hosted={};
  for(const label of ['research','buyer'])hosted[label]=await hostedExecutionEvidence({sdk,hash:ctx.evidence.steps[label+'Start'].hash,
    sender:customer.id,runtimeHash:runtime.sha256,predecessor:vault,projectUuid:project.project_uuid,
    requiredPriorWork:label==='buyer'?[{jobId:ctx.evidence.research.id,outputHash:ctx.evidence.research.result.job.output_hash}]:[]});
  const evidence={milestone:'M06',complete:true,checkedAt:new Date().toISOString(),mode:'real NEAR testnet / hosted OutLayer',initial,
    owner:current.ownerAccountId,runtimeHash:runtime.sha256,projectUuid:project.project_uuid,nativeLedger:ledger,hosted,
    jobs:Object.fromEntries(['smoke','legacyscout','legacycompare','research','buyer'].filter(k=>ctx.evidence[k]).map(k=>[k,{id:ctx.evidence[k].id,result:ctx.evidence[k].result}])),
    nearTransactions:Object.fromEntries(Object.entries(ctx.evidence.steps).map(([k,v])=>[k,{hash:v.hash,failed:v.outcome?.failed}])),
    memoryBasis:'The deployed registry supplies its finalized research index; the pinned guest validates every prior commitment in the vault cell before successful buyer inference.',
    limits:['Model token prices are configured usage estimates, not provider invoices.','Attestation does not establish factual accuracy.',
      'Secret remains operator-owned and revocable; the vault/build access grant persists through NFT sale.',
      'Full research artifacts remain encrypted; owner recall returns a summary.','Independent full Intel collateral validation remains open.']};
  await writeFile('docs/evidence/m06-hosted-research.json',JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence,null,2));
  const hostedEvidence={research:ctx.evidence.steps.researchStart.hash,buyerResearch:ctx.evidence.steps.buyerStart.hash,
    recall:ctx.evidence.steps.buyerRecall.hash,scout:ctx.evidence.steps.legacyscoutStart.hash,
    compare:ctx.evidence.steps.legacycompareStart.hash,projectUuid:project.project_uuid};
  const catalog=JSON.parse(await readFile('releases/catalog.json','utf8')),release=catalog.releases.find(r=>r.versionKey===runtime.sha256);
  if(!release||!ctx.evidence.upload?.url)throw Error('Pinned candidate catalog entry and verified upload required');
  Object.assign(release,{url:ctx.evidence.upload.url,hostedStatus:'verified',hostedEvidence,
    reason:'Real paid research and buyer continuation passed on the same vault-owned Project; seller recall was denied.'});
  await writeFile('releases/catalog.json',JSON.stringify(catalog,null,2)+'\n');
  const pkg=JSON.parse(await readFile('service-packages/research.json','utf8'));
  Object.assign(pkg,{stage:'hosted-testnet-verified',hostedEvidence});await writeFile('service-packages/research.json',JSON.stringify(pkg,null,2)+'\n');
}else console.log(JSON.stringify({phase,tokenId,vault,owner:identity.ownerAccountId,projectUuid:project.project_uuid,runtime:runtime.sha256,
  pending:(await sdk.getAgentState(tokenId)).pending_op,hasDedicatedCredentialFile:await readFile('.env.research').then(()=>true,()=>false)}));
