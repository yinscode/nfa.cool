import {createHash} from 'node:crypto';

const digest=text=>'sha256:'+createHash('sha256').update(text).digest('hex');

/** An optional hosted trigger. No key, URL, version or project-management method is taken from job input. */
export async function triggerPaidScout({sdk,wallet,tokenId,jobId,inputData,journal=null}) {
  return triggerPaidService({sdk,wallet,tokenId,jobId,inputData,service:'scout',legacy:true,journal});
}

export async function triggerPaidService({sdk,wallet,tokenId,jobId,inputData,service,legacy=false,journal=null}) {
  if(!['scout','compare'].includes(service))throw Error('Unknown service');
  if(typeof inputData!=='string'||inputData.length>8192)throw Error('Input size cap');
  const value=JSON.parse(inputData);
  const expectedKeys=service==='scout'?'question,sources':'criteria,question,sources';
  if(!value||typeof value!=='object'||Array.isArray(value)||
    Object.keys(value).sort().join(',')!==expectedKeys||
    typeof value.question!=='string'||!Array.isArray(value.sources)||
    (service==='compare'&&!Array.isArray(value.criteria)))throw Error('Typed service payload required');
  const [agent,record,project]=await Promise.all([sdk.get(tokenId),
    legacy?sdk.getPaidJob(tokenId,jobId):sdk.getServiceJob(tokenId,jobId),sdk.getOutlayerProject(tokenId)]);
  if(!legacy&&record?.service_id!==service)throw Error('Job service mismatch');
  const job=legacy?record:record?.job;
  if(!job||job.status!=='REQUESTED'||agent.lifecycle!=='ACTIVE'||project?.state!=='READY')return {status:'skipped'};
  if(job.input_hash!==digest(inputData)||job.version_key!==project.version_key)throw Error('Pinned input or version changed');
  if(BigInt(Date.now())*1_000_000n>=BigInt(job.deadline_ns))throw Error('Job deadline passed');
  const action=legacy?sdk.startPaidScout(tokenId,jobId,inputData):sdk.startServiceJob(tokenId,jobId,inputData);
  if(journal&&!await journal.claim(tokenId,jobId,job.input_hash,service))return {status:'reconcile_required',jobId};
  try{
    const tx=await wallet.signAndSendTransaction(action);
    if(journal)await journal.record(tokenId,jobId,'SUBMITTED',tx?.transaction?.hash??null);
  }catch(error){
    if(journal)await journal.record(tokenId,jobId,'UNCERTAIN');
    throw error;
  }
  return {status:'submitted',jobId};
}

/** Observe an ambiguous send against finalized chain state; never infer failure from silence. */
export async function reconcileKeeperIntent({sdk,journal,tokenId,jobId}) {
  const intent=await journal.get(tokenId,jobId);
  const record=await sdk.getServiceJob(tokenId,jobId);
  if(!record||record.service_id!==intent.service||record.job?.input_hash!==intent.inputHash)
    throw Error('Keeper intent does not match on-chain job');
  const status=record.job.status;
  if(!['REQUESTED','EXECUTING','UNCERTAIN','RECONCILING','FINALIZED','FAILED'].includes(status))
    throw Error('Unknown on-chain job state');
  if(status==='REQUESTED')return {status:'unresolved',jobId,chainStatus:status,
    transaction:intent.transaction??null,action:'inspect_transaction_and_deadline'};
  if(['UNCERTAIN','RECONCILING'].includes(status))return {status:'unresolved',jobId,chainStatus:status,
    transaction:intent.transaction??null,action:'inspect_outlayer_callback_or_reimbursement'};
  await journal.record(tokenId,jobId,'OBSERVED');
  return {status:'observed',jobId,chainStatus:status,transaction:intent.transaction??null};
}

/** The monitor reports unresolved work; it never refunds or retries an unknown callback. */
export async function inspectOutlayer({sdk,tokenId,jobIds,minRunwayYocto='1000000000000000000000000'}) {
  const agent=await sdk.get(tokenId);
  const [project,treasury,ledger,jobs]=await Promise.all([
    sdk.getOutlayerProject(tokenId),sdk.getTreasury(tokenId),sdk.getPaidLedger(),
    Promise.all(jobIds.map(id=>sdk.getPaidJob(tokenId,id)))]);
  const alerts=[];
  if(typeof sdk.view==='function'){
    try{if(await sdk.view('outlayer.testnet','is_paused'))alerts.push('outlayer_paused')}
    catch{alerts.push('outlayer_unreachable')}
  }
  if(!project||project.state!=='READY')alerts.push('project_unavailable');
  if(BigInt(treasury.available)<BigInt(minRunwayYocto))alerts.push('vault_low_runway');
  if(jobs.some(j=>j&&['UNCERTAIN','RECONCILING'].includes(j.status)))alerts.push('job_needs_reconciliation');
  const now=BigInt(Date.now())*1_000_000n;
  if(jobs.some(j=>j&&j.status==='EXECUTING'&&j.started_at_ns!==null&&j.started_at_ns!==undefined&&
    now-BigInt(j.started_at_ns)>180_000_000_000n))alerts.push('callback_delayed');
  const terminal=jobs.filter(j=>j&&['FINALIZED','FAILED'].includes(j.status));
  if(terminal.length>=5&&terminal.filter(j=>j.status==='FAILED').length*2>=terminal.length)
    alerts.push('high_failure_rate');
  return {tokenId,ownerEpoch:agent.ownerEpoch,projectId:project?.project_id,
    projectUuid:project?.project_uuid,versionKey:project?.version_key,
    pendingJobs:jobs.filter(j=>j&&!['FINALIZED','FAILED'].includes(j.status)).map(j=>({id:j.id,status:j.status})),
    ledger,alerts};
}
