import {createScoutBrief} from './scout.mjs';

/** Worker has a bounded SCOUT_RUN grant; wallet signs the on-chain completion. */
export async function runScout({sdk,store,inputStore,wallet,tokenId,jobId,input}){
  const [agent,job]=await Promise.all([sdk.get(tokenId),sdk.getJob(tokenId,jobId)]);
  if(!job||job.status!=='REQUESTED'||agent.lifecycle!=='ACTIVE'||agent.ownerEpoch!==job.epoch)
    throw Error('Job is stale or agent is not active');
  const supplied=input??await inputStore.get(job.brief_hash,job.source_hash);
  const result=createScoutBrief(supplied);
  if(result.briefHash!==job.brief_hash||result.sourceHash!==job.source_hash)
    throw Error('Input does not match paid job');
  const stored=await store.put(result.artifact);
  if(stored.outputHash!==result.outputHash)throw Error('Artifact commitment mismatch');
  const [fresh,current]=await Promise.all([sdk.get(tokenId),sdk.getJob(tokenId,jobId)]);
  if(fresh.ownerEpoch!==agent.ownerEpoch||fresh.lifecycle!=='ACTIVE'||
      !current||current.status!=='REQUESTED'||current.epoch!==job.epoch)
    throw Error('Ownership or job changed before commit');
  const action=sdk.prepare('complete_scout_job',{token_id:tokenId,id:jobId,expected_epoch:job.epoch,
    output_hash:result.outputHash,output_uri:result.outputUri},'0');
  await wallet.signAndSendTransaction(action);
  // The RPC's final view can lag a successful transaction response. Poll the
  // same job, never submit a second completion just because one read is stale.
  let finalized;
  for(let attempt=0;attempt<20;attempt++){
    finalized=await sdk.getJob(tokenId,jobId);
    if(finalized?.status==='FINALIZED'||finalized?.status==='FAILED')break;
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  if(finalized?.status!=='FINALIZED'||finalized.output_hash!==result.outputHash)
    throw Error('Completion not finalized; work remains private');
  return {outputHash:result.outputHash,outputUri:result.outputUri,artifact:result.artifact};
}
