#!/usr/bin/env node
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {transactions,utils} from 'near-api-js';
import {NfaSdk} from '@nfa/sdk';
import {testnet,pause} from './testnet-lib.mjs';
const oldHash='f989bfe9bc179b14b4272334f4f819663df5d5186132a88a03eb3f01de3acae4';
const newHash='f9c750ad48e369b79e65f3de6c6533602b09658c3202e389d96dbfba154c1353';
const code=await readFile('releases/nfa-registry-async-recovery-f9c750ad48e369b7.wasm');
if(createHash('sha256').update(code).digest('hex')!==newHash)throw Error('Recovery bytecode changed');
const rehearsal=JSON.parse(await readFile('docs/evidence/async-research-recovery-upgrade-rehearsal.json'));
if(rehearsal.oldHash!==oldHash||rehearsal.newHash!==newHash)throw Error('Exact predecessor rehearsal required');
const ctx=await testnet('deployments/async-research-recovery-rollout.json'),registry=await ctx.signer('t006-registry');
const sdk=new NfaSdk({registryAccountId:registry.id,rpcUrl:ctx.rpcUrl}),tokenId='nfa-2';
const hash=async()=>Buffer.from(utils.serialize.base_decode((await ctx.account(registry.id)).code_hash)).toString('hex');
const snapshot=async()=>({identity:await sdk.get(tokenId),agent:await sdk.getAgentState(tokenId),
  job:await sdk.getServiceJob(tokenId,42),async:await sdk.view(registry.id,'async_research_job',{token_id:tokenId,id:42}),
  resume:await sdk.view(registry.id,'service_resume',{token_id:tokenId}),
  project:await sdk.getOutlayerProject(tokenId),
  vault:await sdk.view(`nfa-2.${registry.id}`,'status'),
  ledger:await sdk.view(registry.id,'registry_ledger')});
let liveHash=await hash();if(![oldHash,newHash].includes(liveHash))throw Error('Unexpected live registry code');
if(!ctx.evidence.before){
  if(liveHash!==oldHash)throw Error('Pre-deploy recovery snapshot missing');
  ctx.evidence.before=await snapshot();await ctx.save();
}
const before=ctx.evidence.before;
if(before.agent.lifecycle!=='Draining'||before.agent.pending_op!==before.resume?.id||
  before.job.job.status!=='FAILED'||before.async.state!=='FAILED'||before.resume.failed_job_id!==42||
  before.vault.pending!==null)throw Error('Expected refunded and pending resume state changed');
if(liveHash===oldHash){
  if(JSON.stringify(await snapshot())!==JSON.stringify(before))throw Error('Recovery state drifted before deployment');
  const account=await ctx.account(registry.id),reserve=BigInt(account.amount)-
    BigInt(account.storage_usage+code.length-1488635)*10n**19n-BigInt(before.ledger.liabilities);
  if(reserve<10n**23n)throw Error('Registry reserve too low for recovery deployment');
  await ctx.send('deployAsyncResearchRecovery',registry,registry.id,[transactions.deployContract(code)]);
  for(let i=0;i<90;i++){liveHash=await hash();if(liveHash===newHash)break;await pause(500)}
  if(liveHash!==newHash)throw Error('Recovery code hash not observed');
}
let after;for(let i=0;i<90;i++){after=await snapshot();if(JSON.stringify(after)===JSON.stringify(before))break;await pause(500)}
if(JSON.stringify(after)!==JSON.stringify(before))throw Error('Recovery deployment changed NFA state or liabilities');
const evidence={checkedAt:new Date().toISOString(),network:'NEAR testnet',oldHash,newHash,
  preserved:['NFA identity','pending recovery request','refunded Research job 42','Project and vault','liabilities'],
  liabilityYocto:after.ledger.liabilities,deployTx:ctx.evidence.steps.deployAsyncResearchRecovery?.hash,
  exception:'Direct deployment with existing FullAccess key; public two-day path remains pending'};
await writeFile('docs/evidence/async-research-recovery-rollout.json',JSON.stringify(evidence,null,2)+'\n');
console.log(JSON.stringify({deployed:newHash,job42:after.job.job.status,resumePending:after.resume.id}));
