#!/usr/bin/env node
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {transactions,KeyPairSigner} from 'near-api-js';
import {NfaSdk} from '@nfa/sdk';
import {testnet,pause,sha} from './testnet-lib.mjs';
import {verifyRelease} from '../services/api/wasm-release.mjs';
import {materializeWork} from '../services/api/materialize-work.mjs';
import {publishedManifest,publishedBytes} from '../services/api/published-artifacts.mjs';
import {WorkStore} from '../services/api/work-store.mjs';
import {AccessService,verifyNearFullAccessKey} from '../services/api/access.mjs';
import assert from 'node:assert/strict';

const base=JSON.parse(await readFile('deployments/studio-testnet-public.json'));
const ctx=await testnet('deployments/studio-final-gates-public.json');
const bob=await ctx.signer('t008-bob'),funder=await ctx.signer('studio-funder');
const registryId=base.afterUpgrade.registryId,tokenId=base.tokenId;
const sdk=new NfaSdk({registryAccountId:registryId,rpcUrl:ctx.rpcUrl});
const catalog=JSON.parse(await readFile('releases/catalog.json'));
const v2=catalog.releases.find(r=>r.id==='scout-compare-2');
if(!v2||(await verifyRelease(v2)).activationAllowed!==true)throw Error('V2 release has not passed hosted staging');
const send=(label,person,a,options)=>ctx.send(label,person,a.receiverId,[transactions.functionCall(a.methodName,a.args,BigInt(a.gas),BigInt(a.deposit))],options);
const raw=(method,args,deposit='0')=>sdk.prepare(method,args,deposit);
const until=async(work,check)=>{for(let i=0;i<180;i++){const value=await work();if(check(value))return value;await pause(500)}throw Error('State did not settle')};
let project=await sdk.getOutlayerProject(tokenId);
if(project.version_key!==v2.versionKey){
  if(project.candidate_version!==v2.versionKey)await send('stageNfaRuntimeV2',bob,sdk.addOutlayerVersion(tokenId,v2.url,v2.versionKey,'50000000000000000000000'));
  await until(()=>sdk.getOutlayerProject(tokenId),p=>p?.candidate_version===v2.versionKey&&p.state==='READY');
  await send('activateNfaRuntimeV2',bob,sdk.activateOutlayerVersion(tokenId));
}
project=await until(()=>sdk.getOutlayerProject(tokenId),p=>p?.version_key===v2.versionKey&&p.state==='READY');
assert.equal(project.project_uuid,base.project.project_uuid);
await send('recallPresaleV1MemoryUnderV2',bob,sdk.recallOwnerMemory(tokenId,base.scout.jobId,'3000000000000000000000'));
ctx.evidence.versionContinuity={projectUuid:project.project_uuid,beforeRuntime:base.project.version_key,afterRuntime:project.version_key,
  recalledOutputHash:base.scout.finalized.output_hash};await ctx.save();

// A valid typed direct customer request with no supporting finding exercises
// the definite guest-failure/refund lane rather than a transport timeout.
let failure=ctx.evidence.definiteFailure;
if(!failure){
  const inputData=JSON.stringify({question:'What is quantum cargo allocation?',sources:[{title:'River',url:'https://example.org/river',
    text:'A river winds through the quiet city with ancient bridges and autumn leaves.'}]});
  const limits={max_instructions:1_000_000_000,max_memory_mb:64,max_execution_seconds:10};
  const estimate=BigInt(await sdk.view('outlayer.testnet','estimate_execution_cost',{resource_limits:limits,input_len:Buffer.byteLength(inputData)+128}));
  const deposit=(estimate*6n+4n)/5n,fee=deposit+10n**22n;
  const beforeIncome=(await sdk.get(tokenId)).income,beforePayout=await sdk.view(registryId,'payout',{seller:funder.id});
  const project=await sdk.getOutlayerProject(tokenId),scoutPolicy=await sdk.getServicePolicy(tokenId,'scout');
  const payment=await send('payDefiniteFailure',funder,sdk.requestReviewedServiceJob(tokenId,'scout','sha256:'+sha(inputData),
    Number(BigInt(Date.now()+900000)*1_000_000n),fee.toString(),deposit.toString(),deposit.toString(),scoutPolicy.limits,
    project.version_key,scoutPolicy.version));
  assert.ok(Number.isSafeInteger(payment.value));
  failure={jobId:payment.value,inputData,fee:fee.toString(),beforeIncome,beforePayout};ctx.evidence.definiteFailure=failure;await ctx.save();
}
if(!ctx.evidence.steps.pendingListingDenied)await send('pendingListingDenied',bob,
  sdk.listForSale(tokenId,'10000000000000000000000',Number(BigInt(Date.now()+3600000)*1_000_000n)),{failureExpected:true});
let failed=await sdk.getPaidJob(tokenId,failure.jobId);
if(failed.status==='REQUESTED'||(ctx.evidence.steps.startDefiniteFailure&&!ctx.evidence.steps.startDefiniteFailure.outcome))
  await send('startDefiniteFailure',funder,sdk.startServiceJob(tokenId,failure.jobId,failure.inputData));
failed=await until(()=>sdk.getPaidJob(tokenId,failure.jobId),j=>j?.status==='FAILED');
assert.equal((await sdk.get(tokenId)).income,failure.beforeIncome);
if(!ctx.evidence.steps.withdrawFailureRefund){
  const credited=await sdk.view(registryId,'payout',{seller:funder.id});
  assert.equal(BigInt(credited.available),BigInt(failure.beforePayout.available)+BigInt(failure.fee));
  ctx.evidence.refundCredit=credited;await ctx.save();
}
if((await sdk.get(tokenId)).lifecycle==='DRAINING'){
  for(let attempt=0;attempt<3;attempt++){
    await send('resumeAfterDefiniteFailure'+attempt,bob,raw('resume_failed_service',{token_id:tokenId,failed_job_id:failure.jobId},'1'));
    if((await sdk.get(tokenId)).lifecycle==='ACTIVE')break;
    await pause(500);
  }
}
await until(()=>sdk.get(tokenId),a=>a.lifecycle==='ACTIVE');
await send('withdrawFailureRefund',funder,sdk.withdrawProceeds(failure.fee));
ctx.evidence.definiteFailure.finalized=failed;
ctx.evidence.refundAfterWithdrawal=await sdk.view(registryId,'payout',{seller:funder.id});

const access=new AccessService({sdk,origin:'http://127.0.0.1:3902',verifyKey:payload=>verifyNearFullAccessKey({...payload,rpcUrl:ctx.rpcUrl})});
const challenge=access.challenge(bob.id,tokenId);
const proof=await new KeyPairSigner(bob.key).signNep413Message(challenge.message,bob.id,challenge.recipient,Buffer.from(challenge.nonce,'base64'),challenge.callbackUrl);
const {session}=await access.authorize({challengeId:challenge.challengeId,accountId:bob.id,publicKey:proof.publicKey.toString(),signature:Buffer.from(proof.signature).toString('base64')});
await access.requireOwner(session,tokenId);
const materialized=await materializeWork({sdk,store:new WorkStore('.data/studio-live/work'),tokenId,jobId:base.scout.jobId,
  startHash:base.steps.startscout.outcome.hash,sender:funder.id,releases:catalog.releases});
await access.requireOwner(session,tokenId);
ctx.evidence.ownerArtifact={owner:bob.id,hash:materialized.outputHash,provenance:materialized.provenance};
const emptyCache=await mkdtemp(join(tmpdir(),'nfa-public-artifact-check-'));
try{
  const current=await sdk.get(tokenId),manifest=await publishedManifest({hash:current.manifestHash,uri:current.manifestUri,manifests:new WorkStore(emptyCache)});
  const image=await publishedBytes(manifest.publicCharacter.imageUri),cutout=await publishedBytes(manifest.publicCharacter.cutoutUri);
  assert.equal('sha256:'+sha(image),manifest.publicCharacter.imageHash);assert.equal('sha256:'+sha(cutout),manifest.publicCharacter.cutoutHash);
  ctx.evidence.emptyCacheArtifactCheck={manifestHash:current.manifestHash,imageHash:manifest.publicCharacter.imageHash,cutoutHash:manifest.publicCharacter.cutoutHash};
}finally{await rm(emptyCache,{recursive:true,force:true})}
ctx.evidence.finalIdentity=await sdk.get(tokenId);ctx.evidence.finalProject=await sdk.getOutlayerProject(tokenId);
ctx.evidence.finalLedger=await sdk.getPaidLedger();ctx.evidence.finalVault=await sdk.view(base.vaultId,'outlayer_status');
assert.equal(ctx.evidence.finalLedger.customer_escrow,'0');assert.equal(ctx.evidence.finalLedger.vault_replenishment_pending,'0');
assert.equal(ctx.evidence.finalVault.pending,null);ctx.evidence.completedAt=new Date().toISOString();await ctx.save();
console.log(JSON.stringify({tokenId,versionContinuity:true,definiteFailureRefunded:true,recovered:true,ownerArtifactVerified:true},null,2));
