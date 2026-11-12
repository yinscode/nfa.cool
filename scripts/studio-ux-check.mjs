#!/usr/bin/env node
// Exercises the same launch planner, HTTP preparation and wallet receipts as the UI.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile,readFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {nextLaunchStep,nearAmount,DEFAULT_LIMITS} from '../apps/web/launch-state.mjs';
const run=promisify(execFile),port=Number(process.env.NFA_PORT||3102),base=`http://127.0.0.1:${port}`;
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function api(path,body,{token,raw=false}={}){const response=await fetch(base+path,{...(body?{method:'POST',body:JSON.stringify(body)}:{}),headers:{...(body?{'content-type':'application/json'}:{}),...(token?{authorization:'Bearer '+token}:{})}});const data=await response.json();if(!response.ok&&!raw)throw Error(path+': '+data.error);return raw?{status:response.status,data}:data}
async function until(work,check){for(let i=0;i<60;i++){const value=await work();if(check(value))return value;await pause(200)}throw Error('Confirmed state did not settle')}
const config=await api('/config');assert.equal(config.network,'sandbox');assert.equal(config.workspace.persistent,true);
const wallet=(accountId,action)=>fetch(base+'/dev/wallet/transaction',{method:'POST',headers:{'content-type':'application/json','x-nfa-local-wallet':'1'},body:JSON.stringify({accountId,action})}).then(async response=>{const body=await response.json();if(!response.ok)throw Error(body.error);return body});
const prepare=async body=>(await api('/prepare',body)).unsignedAction;
const sign=async(account,body)=>wallet(account,await prepare(body));
const alice='alice.test.near',bob='bob.test.near',customer='customer.test.near';
const {items:skills}=await api('/studio/skills'),{releases}=await api('/studio/releases');
const preview=await api('/preview',{seed:'compact-'+randomUUID().slice(0,8),traits:{body:'sphere',attachment:'none',ornament:'none',hat:'none'}});
const manifest=await api('/manifests',{previewKey:preview.key,displayName:'Compact Launch',description:'Two services with a resumable setup',templateId:'both'});
assert.equal(manifest.manifest.services.length,2);assert.equal(manifest.manifest.description,'Two services with a resumable setup');
const plan={owner:alice,requestId:'ux-'+randomUUID(),serviceIds:['scout','compare'],marginYocto:nearAmount('0.02'),reserveYocto:nearAmount('2'),maxDepositYocto:nearAmount('0.5'),release:releases.at(-1),manifest,receipts:[]};
let tokenId,snapshot;
for(let i=0;i<12;i++){
  const request=await api('/requests?owner='+alice+'&requestId='+plan.requestId);
  tokenId=request.minted?request.tokenId:tokenId;snapshot=tokenId?await api('/studio/nfas/'+tokenId):null;
  const step=nextLaunchStep(plan,request,snapshot,skills);
  if(step.ready)break;if(step.waiting){await pause(250);continue}assert.equal(step.blocked,undefined);
  let body;
  if(step.id==='mint')body={kind:'create',requestId:plan.requestId,manifestHash:manifest.manifestHash,manifestUri:manifest.manifestUri};
  if(step.id==='project')body={kind:'outlayer_provision',tokenId,wasmUrl:plan.release.url,versionKey:plan.release.versionKey,deposit:nearAmount('0.1')};
  if(step.service)body={kind:'service_policy',tokenId,serviceId:step.service,schemaHash:skills.find(s=>s.id===step.service).schemaHash,enabled:true,margin:plan.marginYocto,maxDeposit:plan.maxDepositYocto,limits:DEFAULT_LIMITS};
  if(step.id==='reserve')body={kind:'fund',vaultAccountId:snapshot.identity.vaultAccountId,yocto:step.amount};
  const action=await prepare(body),tx=await wallet(alice,action),hash=tx.transaction.hash;
  const pending={...plan,pending:{action,hash}};
  assert.equal(nextLaunchStep(pending,request,snapshot,skills).id,'reconcile','A refresh must not repeat an uncertain action');
  const receipt=await api('/studio/launch/inspect',{action,hash,sender:alice});assert.equal(receipt.status,'SUCCEEDED');
  plan.receipts.push({step:step.id,hash});console.log(step.id+' confirmed');
}
assert.ok(tokenId);snapshot=await api('/studio/nfas/'+tokenId);assert.equal(nextLaunchStep(plan,{minted:true},snapshot,skills).ready,true);
const uuid=snapshot.project.project_uuid,vault=snapshot.identity.vaultAccountId;
const discovered=await api('/studio/discover');assert.ok(discovered.items.some(n=>n.tokenId===tokenId));
const sample={question:'How does the agent retain its treasury?',sources:[{title:'Vault',url:'https://example.org/vault',text:'The agent retains its treasury in the same NEAR vault after its NFT transfers to a new owner.'}]};
const quote=await api(`/v1/nfas/${tokenId}/services/scout/quotes`,{input:sample});
assert.equal(BigInt(quote.feeYocto)-BigInt(quote.replenishYocto),BigInt(plan.marginYocto),'The customer quote must honor the selected on-chain margin');
const payment=await wallet(customer,quote.unsignedAction);
const receipt=await api('/studio/transactions/inspect',{tokenId,hash:payment.transaction.hash,sender:customer});assert.ok(Number.isSafeInteger(receipt.assignedJobId));
const jobId=receipt.assignedJobId;
const denied=await wallet(alice,await prepare({kind:'list',tokenId,price:nearAmount('0.05'),expiresAtNs:Number(BigInt(Date.now()+3600000)*1000000n)}));assert.ok(denied.status.Failure,'Pending paid job must block listing');
const start=(await api(`/v1/nfas/${tokenId}/services/scout/jobs/${jobId}/prepare-start`,{inputData:quote.inputData})).unsignedAction;
const started=await wallet(customer,start),startHash=started.transaction.hash;
const finalized=await until(()=>api(`/v1/nfas/${tokenId}/services/scout/jobs/${jobId}`),j=>j.job?.status==='FINALIZED');
assert.ok(finalized.job.output_hash);console.log('paid public service finalized');
async function session(accountId){const challenge=await api('/auth/challenge',{accountId,tokenId,studio:true});
  const response=await fetch(base+'/dev/wallet/message',{method:'POST',headers:{'content-type':'application/json','x-nfa-local-wallet':'1'},body:JSON.stringify({accountId,challenge})});const proof=await response.json();
  return (await api('/auth/session',{challengeId:challenge.challengeId,...proof})).session}
const oldSession=await session(alice);
await sign(alice,{kind:'list',tokenId,price:nearAmount('0.05'),expiresAtNs:Number(BigInt(Date.now()+3600000)*1000000n)});
const listed=await until(()=>api('/studio/nfas/'+tokenId),s=>!!s.identity.listing);
await sign(bob,{kind:'buy',tokenId,price:listed.identity.listing.price,nonce:listed.identity.listing.nonce});
await until(()=>api('/studio/nfas/'+tokenId),s=>s.identity.ownerAccountId===bob);
const oldRead=await api(`/studio/nfas/${tokenId}/work/${jobId}`,null,{token:oldSession,raw:true});assert.equal(oldRead.status,401);
const buyerPreview=await api('/preview',{seed:'buyer-'+randomUUID().slice(0,8),traits:{body:'capsule',eyewear:'round-wire',attachment:'none',ornament:'none',hat:'none'}});
const revision=await api('/studio/appearance',{tokenId,previewKey:buyerPreview.key,displayName:'Buyer’s Agent',expectedOwner:bob,expectedEpoch:1});
await sign(bob,{kind:'manifest',tokenId,manifestHash:revision.manifestHash,manifestUri:revision.manifestUri});
await sign(bob,{kind:'recall',tokenId,jobId,deposit:nearAmount('0.003')});
const after=await until(()=>api('/studio/nfas/'+tokenId),s=>s.agent.pending_op==null&&s.identity.manifestHash===revision.manifestHash);
assert.equal(after.project.project_uuid,uuid);assert.equal(after.identity.vaultAccountId,vault);
const buyerSession=await session(bob),artifact=await api(`/studio/nfas/${tokenId}/work/${jobId}`,{startHash,sender:customer},{token:buyerSession});assert.equal(artifact.outputHash,finalized.job.output_hash);
console.log('sale, buyer edit/recall and old-owner denial passed');
const nextInput={question:'What stays after the agent changes owners?',sources:[{title:'Buyer continuity',url:'https://example.org/buyer',text:'After an agent changes owners, its vault, service Project and finalized work stay with the NFT. The buyer controls the same service and can earn the next customer payment.'}]};
const nextQuote=await api(`/v1/nfas/${tokenId}/services/scout/quotes`,{input:nextInput});
const nextPayment=await wallet(customer,nextQuote.unsignedAction);
const nextReceipt=await api('/studio/transactions/inspect',{tokenId,hash:nextPayment.transaction.hash,sender:customer});
assert.ok(Number.isSafeInteger(nextReceipt.assignedJobId));
const nextJobId=nextReceipt.assignedJobId;
await wallet(customer,(await api(`/v1/nfas/${tokenId}/services/scout/jobs/${nextJobId}/prepare-start`,{inputData:nextQuote.inputData})).unsignedAction);
await until(()=>api(`/v1/nfas/${tokenId}/services/scout/jobs/${nextJobId}`),j=>j.job?.status==='FINALIZED');
const earningBuyer=await until(()=>api('/studio/nfas/'+tokenId),s=>s.agent.pending_op==null);
assert.equal(earningBuyer.project.project_uuid,uuid);assert.equal(earningBuyer.identity.vaultAccountId,vault);
assert.equal(BigInt(earningBuyer.identity.income)-BigInt(after.identity.income),BigInt(plan.marginYocto));
const economics=await api(`/v1/nfas/${tokenId}/economics`),inventory=await api(`/v1/nfas/${tokenId}/inventory`);
assert.equal(economics.netProfit,null);assert.equal(economics.jobs.finalized,2);assert.equal(inventory.included.eligibleWork.length,2);
assert.equal(inventory.owner,bob);assert.equal(inventory.transferBarrier.blocked,false);
console.log('buyer continued the same service and earned the next customer payment');
const evidence={testedAt:new Date().toISOString(),workspaceId:config.workspace.id,tokenId,vault,projectUuid:uuid,owner:bob,manifestHash:revision.manifestHash,jobId,outputHash:finalized.job.output_hash,launchReceipts:plan.receipts,checks:['compact two-service launch','refresh retains uncertain receipt','exact reviewed receipt reconciliation','dynamic on-chain earnings margin','public assigned-ID checkout','pending sale lock','NFT sale','buyer character edit','buyer memory recall','old session rejected']};
evidence.nextPaidJobId=nextJobId;evidence.economics=economics;evidence.inventory=inventory;
evidence.mode='local NEAR sandbox receipts; OutLayer mock';
evidence.checks.push('buyer continues service and earns again','separate economics and buyer inventory');
await writeFile('.data/studio-ux-proof.json',JSON.stringify(evidence,null,2)+'\n');
if(process.argv.includes('--restart')){
  await run(process.execPath,['scripts/studio-background.mjs','stop'],{env:{...process.env,NFA_PORT:String(port)}});
  await run(process.execPath,['scripts/studio-background.mjs','start'],{env:{...process.env,NFA_PORT:String(port)},timeout:60000});
  const restored=await api('/studio/nfas/'+tokenId),restoredConfig=await api('/config');
  assert.equal(restoredConfig.workspace.id,config.workspace.id);assert.equal(restored.identity.ownerAccountId,bob);assert.equal(restored.identity.manifestHash,revision.manifestHash);assert.equal(restored.project.project_uuid,uuid);
  assert.ok(restored.jobs.some(row=>row.id===jobId&&row.service?.job.output_hash===finalized.job.output_hash));
  evidence.checks.push('server restart preserves owner, character, UUID and finalized work');await writeFile('.data/studio-ux-proof.json',JSON.stringify(evidence,null,2)+'\n');console.log('persistent restart passed');
}
console.log(JSON.stringify({tokenId,projectUuid:uuid,checks:evidence.checks.length}));
