#!/usr/bin/env node
// Read-only evidence capture. Report-data binding is not Intel collateral verification.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {NfaSdk} from '@nfa/sdk';
const base=JSON.parse(await readFile('deployments/studio-testnet-public.json'));
const gates=JSON.parse(await readFile('deployments/studio-final-gates-public.json'));
const sdk=new NfaSdk({registryAccountId:base.afterUpgrade.registryId,
  rpcUrl:process.env.NEAR_RPC_URL||'https://test.rpc.fastnear.com'});
const api='https://testnet-api.outlayer.ai';
const json=async url=>{const response=await fetch(url,{signal:AbortSignal.timeout(25000)});
  if(!response.ok)throw Error(`Evidence unavailable: ${response.status}`);return response.json()};
const jobs=await json(`${api}/public/jobs?project=${encodeURIComponent(base.project.project_id)}&limit=100`);
const selected=[['scout',base.steps.startscout],['compare',base.steps.startcompare],
  ['buyer-recall',base.steps.buyerRecallScout],['version-recall',gates.steps.recallPresaleV1MemoryUnderV2]];
try{const reviewed=JSON.parse(await readFile('deployments/studio-reviewed-quote-public.json'));
  if(reviewed.completedAt)selected.push(['reviewed-quote',reviewed.steps.startReviewedQuote]);
}catch(error){if(error.code!=='ENOENT')throw error}
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const u64=value=>{const bytes=Buffer.alloc(8);bytes.writeBigUInt64LE(BigInt(value));return bytes};
const evidence={capturedAt:new Date().toISOString(),project:base.project.project_id,projectUuid:base.project.project_uuid,
  verification:'Final NEAR receipt, execution-input/runtime/caller/project bindings and TDX v4 report-data hash. Intel collateral/signature trust chain was not independently verified.',records:[]};
await mkdir('docs/evidence/attestations',{recursive:true});
for(const [label,step] of selected){
  const tx=await sdk.transaction(step.hash,step.sender);
  assert.equal(tx.final_execution_status,'FINAL');assert.ok(Object.hasOwn(tx.status,'SuccessValue'));
  const events=tx.receipts_outcome.flatMap(r=>(r.outcome.logs||[]).filter(l=>l.startsWith('EVENT_JSON:'))
    .map(l=>({executor:r.outcome.executor_id,...JSON.parse(l.slice(11))})));
  const request=JSON.parse(events.find(e=>e.executor==='outlayer.testnet'&&e.event==='execution_requested').data[0].request_data);
  const completed=events.find(e=>e.executor==='outlayer.testnet'&&e.event==='execution_completed').data[0];
  assert.equal(completed.success,true);assert.equal(request.predecessor_id,base.vaultId);
  assert.equal(request.project_uuid,base.project.project_uuid);
  const job=jobs.find(j=>j.transaction_hash===step.hash&&j.success===true);assert.ok(job,`Hosted job absent: ${label}`);
  const attestation=await json(`${api}/attestations/${job.job_id}`);
  assert.equal(attestation.transaction_hash,step.hash);assert.equal(attestation.request_id,request.request_id);
  assert.equal(attestation.caller_account_id,request.sender_id);assert.equal(attestation.project_id,request.project_id);
  assert.equal(attestation.input_hash,digest(request.input_data));
  assert.equal(attestation.wasm_hash,request.code_source.WasmUrl.hash);
  assert.equal(attestation.executed_wasm_sha256,attestation.wasm_hash);
  const hash=createHash('sha256').update(attestation.task_type).update(u64(attestation.task_id));
  for(const key of ['repo','commit','build_target','wasm_hash','input_hash','output_hash'])
    if(attestation[key]!=null)hash.update(attestation[key]);
  if(attestation.block_height!=null)hash.update(u64(attestation.block_height));
  for(const key of ['caller_account_id','project_id','secrets_ref'])if(attestation[key]!=null)hash.update(attestation[key]);
  hash.update(u64(attestation.timestamp));if(attestation.attached_usd!=null)hash.update(attestation.attached_usd);
  const reportHash=hash.digest(),quote=Buffer.from(attestation.tdx_quote,'base64');
  assert.ok(quote.length>=636);assert.equal(quote.readUInt16LE(0),4);assert.equal(quote.readUInt32LE(4),0x81);
  // Intel TDX quote v4: 48-byte header + 520-byte TD report fields before report_data.
  assert.deepEqual(quote.subarray(568,600),reportHash);assert.deepEqual(quote.subarray(600,632),Buffer.alloc(32));
  const file=`attestations/${label}.json`;
  await writeFile(`docs/evidence/${file}`,JSON.stringify(attestation,null,2)+'\n');
  evidence.records.push({label,transaction:step.hash,hostJobId:job.job_id,requestId:request.request_id,
    runtimeHash:attestation.executed_wasm_sha256,inputHash:attestation.input_hash,stdoutHash:attestation.output_hash,
    reportDataHash:reportHash.toString('hex'),quoteSha256:digest(quote),quoteFile:file,
    paymentYocto:request.payment,chargedYocto:completed.payment_charged,refundedYocto:completed.payment_refunded,
    instructions:completed.resources_used.instructions,timeMs:completed.resources_used.time_ms,
    registryEvents:events.filter(e=>e.executor===sdk.registryAccountId)});
}
await writeFile('docs/evidence/studio-attestations.json',JSON.stringify(evidence,null,2)+'\n');
console.log(JSON.stringify({captured:evidence.records.length,reportDataBindingsVerified:true,intelCollateralVerified:false}));
