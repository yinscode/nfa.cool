#!/usr/bin/env node
// One paid NFA-to-NFA hiring receipt after the reviewed registry upgrade.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {transactions,utils} from 'near-api-js';
import {NfaSdk} from '@nfa/sdk';
import {testnet,pause} from './testnet-lib.mjs';

const registryHash='b733b54b7ea955c6f95042f3ecbe27ad2391dbaa83409416d2dc9cdc790295b4';
const rollout=JSON.parse(await readFile('docs/evidence/hiring-testnet-rollout.json'));
if(rollout.newHash!==registryHash)throw Error('Hiring registry rollout not verified');
const ctx=await testnet('deployments/hiring-acceptance.json');
const registry=await ctx.signer('t006-registry'),alice=await ctx.signer('t006-alice'),
  worker=await ctx.signer('t008-bob'),customer=await ctx.signer('studio-funder');
const sdk=new NfaSdk({registryAccountId:registry.id,rpcUrl:ctx.rpcUrl});
const codeHash=Buffer.from(utils.serialize.base_decode((await ctx.account(registry.id)).code_hash)).toString('hex');
if(codeHash!==registryHash)throw Error('Wrong live registry code');
const source='nfa-1',target='nfa-2',sourceState=await sdk.get(source),targetState=await sdk.get(target);
if(sourceState.ownerAccountId!==alice.id||targetState.ownerAccountId!==alice.id||
  sourceState.lifecycle!=='ACTIVE'||targetState.lifecycle!=='ACTIVE')throw Error('NFA ownership or state changed');
const project=await sdk.getOutlayerProject(target),policy=await sdk.getServicePolicy(target,'scout');
if(project?.state!=='READY'||!policy?.enabled)throw Error('Target Scout is unavailable');
const limit=policy.limits,fee='30000000000000000000000',reserve='10000000000000000000000';
const legacyFee='50000000000000000000000';
const h=text=>'sha256:'+createHash('sha256').update(text).digest('hex');
const call=(method,args,deposit='0')=>[transactions.functionCall(method,Buffer.from(JSON.stringify(args)),
  250_000_000_000_000n,BigInt(deposit))];
const until=async(work,predicate)=>{for(let i=0;i<80;i++){
  try{const value=await work();if(predicate(value))return value}catch{}await pause(500)
}throw Error('Final state not observed; inspect private journal before retry')};
if(!ctx.evidence.before){
  const ledger=await sdk.view(registry.id,'registry_ledger');
  ctx.evidence.before={sourceIncome:await sdk.getAgentIncome(source),targetIncome:await sdk.getAgentIncome(target),
    liabilities:ledger.liabilities,sourceEpoch:sourceState.ownerEpoch,targetEpoch:targetState.ownerEpoch,
    projectUuid:project.project_uuid};await ctx.save();
}
if(!ctx.evidence.expiresAtNs){ctx.evidence.expiresAtNs=Number(BigInt(Date.now()+900_000)*1_000_000n);await ctx.save()}
const expiry=ctx.evidence.expiresAtNs;
const fresh=await sdk.getAgentIncome(source);
if(!ctx.evidence.steps.hireScout?.outcome&&BigInt(fresh)<BigInt(fee)){
  await ctx.send('grantLegacyWorker',alice,registry.id,call('grant_delegate',{token_id:source,
    delegate:worker.id,method:'SCOUT_RUN',recipient:null,budget:'1',expires_at_ns:expiry},'1'));
  await ctx.send('fundLegacyJob',customer,registry.id,call('request_scout_job',{token_id:source,
    brief_hash:h('nfa-hiring-source-brief'),source_hash:h('nfa-hiring-source-evidence'),
    deadline_ns:expiry,fee:legacyFee},legacyFee));
  const oldId=Number(ctx.evidence.steps.fundLegacyJob.outcome.value);
  if(!Number.isSafeInteger(oldId)||oldId<1)throw Error('Legacy job ID missing');
  await ctx.send('finishLegacyJob',worker,registry.id,call('complete_scout_job',{token_id:source,id:oldId,
    expected_epoch:sourceState.ownerEpoch,output_hash:h('nfa-hiring-source-result'),
    output_uri:'nfa://work/nfa-hiring-source-result'}));
  await until(()=>sdk.getAgentIncome(source),value=>BigInt(value)>=BigInt(fee));
}
if(!ctx.evidence.incomeBeforeHire){
  if(ctx.evidence.steps.hireScout?.outcome){
    const prior=JSON.parse(await readFile('docs/evidence/hiring-testnet-acceptance.json'));
    ctx.evidence.incomeBeforeHire=prior.sourceIncomeBeforeHire;
  }else ctx.evidence.incomeBeforeHire=await sdk.getAgentIncome(source);
  await ctx.save();
}
const incomeBeforeHire=ctx.evidence.incomeBeforeHire;
await ctx.send('grantHiredScout',alice,registry.id,call('grant_delegate',{token_id:source,
  delegate:worker.id,method:'NFA_HIRE',recipient:target,budget:fee,expires_at_ns:expiry},'1'));
const inputData=JSON.stringify({question:'How does the NFA retain its treasury after a sale?',sources:[{
  title:'Vault account',url:'https://example.org/nfa-vault',
  text:'The same NEAR vault account persists after an NFT transfer and keeps its treasury.'}]});
const quote=sdk.hireReviewedServiceJob(source,target,'scout',h(inputData),expiry,fee,reserve,reserve,
  limit,project.version_key,policy.version,sourceState.ownerEpoch,fee);
await ctx.send('hireScout',worker,registry.id,call(quote.methodName,quote.args,quote.deposit));
const jobId=Number(ctx.evidence.steps.hireScout.outcome.value);
if(!Number.isSafeInteger(jobId)||jobId<1)throw Error('Hired job ID missing');
await ctx.send('startHiredScout',worker,registry.id,call('start_service_job',{
  token_id:target,id:jobId,input_data:inputData}));
const record=await until(()=>sdk.getServiceJob(target,jobId),value=>value?.job?.status==='FINALIZED');
assert.equal(record.hired_by,source);assert.equal(record.service_id,'scout');
assert.equal(record.job.requester,worker.id);assert.equal(record.job.input_hash,h(inputData));
const sourceIncome=await sdk.getAgentIncome(source),targetIncome=await sdk.getAgentIncome(target);
assert.equal(BigInt(sourceIncome),BigInt(incomeBeforeHire)-BigInt(fee));
assert.ok(BigInt(targetIncome)>BigInt(ctx.evidence.before.targetIncome));
const grant=await sdk.view(registry.id,'grant',{token_id:source,delegate:worker.id,method:'NFA_HIRE'});
assert.equal(grant.remaining,'0');
const attemptedFee='12000000000000000000000',attemptedReserve='1000000000000000000000';
const exhausted=sdk.hireReviewedServiceJob(source,target,'scout',h(inputData),expiry,attemptedFee,
  attemptedReserve,attemptedReserve,limit,project.version_key,policy.version,
  sourceState.ownerEpoch,attemptedFee);
await ctx.send('exhaustedHireDenied',worker,registry.id,
  call(exhausted.methodName,exhausted.args,exhausted.deposit),{failureExpected:true});
assert.equal(await sdk.getAgentIncome(source),sourceIncome);
assert.equal((await sdk.get(source)).ownerEpoch,sourceState.ownerEpoch);
assert.equal((await sdk.getOutlayerProject(target)).project_uuid,ctx.evidence.before.projectUuid);
const ledger=await sdk.view(registry.id,'registry_ledger');
const evidence={checkedAt:new Date().toISOString(),network:'NEAR testnet',registry:registry.id,
  registryHash,source,target,jobId,requester:worker.id,feeYocto:fee,reserveYocto:reserve,
  sourceIncomeBeforeHire:incomeBeforeHire,sourceIncomeAfterHire:sourceIncome,targetIncome,
  grantRemaining:grant.remaining,outputHash:record.job.output_hash,projectUuid:project.project_uuid,
  liabilities:ledger.liabilities,transactions:Object.fromEntries(Object.entries(ctx.evidence.steps).map(([name,row])=>
    [name,{hash:row.hash,failed:row.outcome?.failed}])),
  scope:'Live testnet Scout hiring from accrued NFA income. No FT or Intents payment.'};
await writeFile('docs/evidence/hiring-testnet-acceptance.json',JSON.stringify(evidence,null,2)+'\n');
console.log(JSON.stringify({jobId,status:record.job.status,sourceIncome,targetIncome,
  grantRemaining:grant.remaining,projectUuid:project.project_uuid},null,2));
