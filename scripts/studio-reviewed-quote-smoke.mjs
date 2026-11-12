#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import {transactions} from 'near-api-js';
import {NfaSdk} from '@nfa/sdk';
import {testnet,pause} from './testnet-lib.mjs';
import {quoteService} from '../services/api/service-runtime.mjs';
import assert from 'node:assert/strict';
const base=JSON.parse(await readFile('deployments/studio-testnet-public.json'));
const ctx=await testnet('deployments/studio-reviewed-quote-public.json'),funder=await ctx.signer('studio-funder');
const sdk=new NfaSdk({registryAccountId:base.afterUpgrade.registryId,rpcUrl:ctx.rpcUrl}),tokenId=base.tokenId;
const send=(name,a,options)=>ctx.send(name,funder,a.receiverId,[transactions.functionCall(a.methodName,a.args,BigInt(a.gas),BigInt(a.deposit))],options);
const policy={limits:{max_instructions:1_000_000_000,max_memory_mb:64,max_execution_seconds:10},
  marginYocto:'10000000000000000000000',maxDepositYocto:'500000000000000000000000'};
let quote=ctx.evidence.quote;
if(!quote){quote=await quoteService({sdk,tokenId,service:'scout',body:{input:JSON.parse(base.scout.quote.inputData)},policy:{scout:policy,compare:policy}});
  ctx.evidence.quote=quote;ctx.evidence.beforeIncome=(await sdk.get(tokenId)).income;await ctx.save()}
if(!ctx.evidence.steps.payReviewedQuote){
  const before=await sdk.getAgentState(tokenId);
  await send('staleRuntimeRejected',{...quote.unsignedAction,args:{...quote.unsignedAction.args,expected_version:'f'.repeat(64)}},{failureExpected:true});
  await send('stalePolicyRejected',{...quote.unsignedAction,args:{...quote.unsignedAction.args,expected_policy_version:999999}},{failureExpected:true});
  assert.equal((await sdk.getAgentState(tokenId)).next_op_id,before.next_op_id);
}
const paid=await send('payReviewedQuote',quote.unsignedAction);assert.ok(Number.isSafeInteger(paid.value));
const jobId=paid.value,job=await sdk.getPaidJob(tokenId,jobId);
if(job.status==='REQUESTED'||(ctx.evidence.steps.startReviewedQuote&&!ctx.evidence.steps.startReviewedQuote.outcome))
  await send('startReviewedQuote',sdk.startServiceJob(tokenId,jobId,quote.inputData));
let finalized;
for(let i=0;i<180;i++){finalized=await sdk.getPaidJob(tokenId,jobId);if(finalized.status==='FINALIZED')break;await pause(500)}
assert.equal(finalized.status,'FINALIZED');
const after=await sdk.get(tokenId);assert.equal(BigInt(after.income),BigInt(ctx.evidence.beforeIncome)+10n**22n);
ctx.evidence.finalized=finalized;ctx.evidence.afterIncome=after.income;ctx.evidence.ledger=await sdk.getPaidLedger();
assert.equal(ctx.evidence.ledger.customer_escrow,'0');assert.equal(ctx.evidence.ledger.vault_replenishment_pending,'0');
ctx.evidence.completedAt=new Date().toISOString();await ctx.save();console.log(JSON.stringify({tokenId,jobId,runtimeDriftRejected:true,policyDriftRejected:true,finalized:true}));
