// Read-only bindings and actual OutLayer resource charges. Not Intel collateral verification.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const u64=v=>{const b=Buffer.alloc(8);b.writeBigUInt64LE(BigInt(v));return b};
const json=async url=>{const r=await fetch(url,{signal:AbortSignal.timeout(25000)});if(!r.ok)throw Error('Hosted evidence unavailable');return r.json()};
export async function hostedExecutionEvidence({sdk,hash,sender,runtimeHash,predecessor,projectUuid,requiredPriorWork=[]}){
  const tx=await sdk.transaction(hash,sender);assert.equal(tx.final_execution_status,'FINAL');
  const events=tx.receipts_outcome.flatMap(r=>(r.outcome.logs||[]).filter(l=>l.startsWith('EVENT_JSON:'))
    .map(l=>({executor:r.outcome.executor_id,...JSON.parse(l.slice(11))})));
  const requested=events.find(e=>e.executor==='outlayer.testnet'&&e.event==='execution_requested');
  assert.ok(requested,'OutLayer execution request absent');
  const request=JSON.parse(requested.data[0].request_data),completed=events.find(e=>e.executor==='outlayer.testnet'&&e.event==='execution_completed')?.data[0];
  assert.equal(completed?.success,true);assert.equal(request.predecessor_id,predecessor);assert.equal(request.project_uuid,projectUuid);
  assert.equal(request.code_source.WasmUrl.hash,runtimeHash);
  const input=JSON.parse(request.input_data),prior=input.context?.priorWork||[];
  for(const expected of requiredPriorWork)assert.ok(prior.some(p=>p.jobId===expected.jobId&&p.outputHash===expected.outputHash),'Buyer request omitted finalized pre-sale context');
  const api='https://testnet-api.outlayer.ai',jobs=await json(`${api}/public/jobs?project=${encodeURIComponent(request.project_id)}&limit=100`);
  const job=jobs.find(j=>j.transaction_hash===hash&&j.success===true);assert.ok(job,'Hosted job unavailable');
  const attestation=await json(`${api}/attestations/${job.job_id}`);
  assert.equal(attestation.transaction_hash,hash);assert.equal(attestation.request_id,request.request_id);
  assert.equal(attestation.caller_account_id,request.sender_id);assert.equal(attestation.project_id,request.project_id);
  assert.equal(attestation.input_hash,digest(request.input_data));assert.equal(attestation.wasm_hash,runtimeHash);
  assert.equal(attestation.executed_wasm_sha256,runtimeHash);
  const h=createHash('sha256').update(attestation.task_type).update(u64(attestation.task_id));
  for(const key of ['repo','commit','build_target','wasm_hash','input_hash','output_hash'])if(attestation[key]!=null)h.update(attestation[key]);
  if(attestation.block_height!=null)h.update(u64(attestation.block_height));
  for(const key of ['caller_account_id','project_id','secrets_ref'])if(attestation[key]!=null)h.update(attestation[key]);
  h.update(u64(attestation.timestamp));if(attestation.attached_usd!=null)h.update(attestation.attached_usd);
  const reportHash=h.digest(),quote=Buffer.from(attestation.tdx_quote,'base64');assert.ok(quote.length>=636);
  assert.equal(quote.readUInt16LE(0),4);assert.equal(quote.readUInt32LE(4),0x81);
  assert.deepEqual(quote.subarray(568,600),reportHash);assert.deepEqual(quote.subarray(600,632),Buffer.alloc(32));
  return {transaction:hash,hostJobId:job.job_id,requestId:request.request_id,predecessor:request.predecessor_id,
    projectId:request.project_id,projectUuid:request.project_uuid,runtimeHash,inputHash:attestation.input_hash,
    stdoutHash:attestation.output_hash,priorWork:prior,reportDataHash:reportHash.toString('hex'),quoteSha256:digest(quote),
    paymentYocto:request.payment,chargedYocto:completed.payment_charged,refundedYocto:completed.payment_refunded,
    resources:completed.resources_used,intelCollateralVerified:false};
}
