import {createHash} from 'node:crypto';
import {createScoutBrief} from '../worker/scout.mjs';
import {createCompareBrief} from '../worker/compare.mjs';
export async function materializeWork({sdk,store,tokenId,jobId,startHash,sender,releases}){
  const record=await sdk.getServiceJob(tokenId,jobId),job=record?.job;
  if(job?.status!=='FINALIZED'||!releases.some(r=>r.versionKey===job.version_key&&r.artifactCodec==='scout-compare-v1'))throw Error('Finalized reviewed service output required');
  const tx=await sdk.transaction(startHash,sender);
  if(tx.transaction?.receiver_id!==sdk.registryAccountId||tx.transaction.hash!==startHash||tx.transaction.signer_id!==sender||
    tx.final_execution_status!=='FINAL'||!Object.hasOwn(tx.status||{},'SuccessValue'))throw Error('Successful service start transaction required');
  const call=(tx.transaction.actions||[]).map(a=>a.FunctionCall).find(c=>['start_service_job','start_paid_scout'].includes(c?.method_name));
  const args=call&&JSON.parse(Buffer.from(call.args,'base64').toString());
  if(args?.token_id!==tokenId||args.id!==jobId||typeof args.input_data!=='string'||
    'sha256:'+createHash('sha256').update(args.input_data).digest('hex')!==job.input_hash)throw Error('Start transaction commitment mismatch');
  const input=JSON.parse(args.input_data);
  const result=record.service_id==='scout'?createScoutBrief(input):record.service_id==='compare'?createCompareBrief(input):null;
  if(!result||result.outputHash!==job.output_hash)throw Error('Artifact differs from finalized output commitment');
  const stored=await store.put(result.artifact);
  return {...stored,artifact:result.artifact,provenance:'deterministic reconstruction of public input, verified against finalized commitment',startTransaction:startHash};
}
