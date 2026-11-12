const amount=value=>{try{return BigInt(value||0)}catch{throw Error('Invalid on-chain amount')}};
export async function studioPages(sdk,id){
  const rows=[];let from=1;
  for(let page=0;page<100;page++){
    const data=await sdk.view(sdk.registryAccountId,'studio_page',{token_id:id,from,limit:50});
    if(!Array.isArray(data?.rows))throw Error('Studio registry views unavailable');
    rows.push(...data.rows);if(data.next==null)return {rows,complete:true};from=data.next;
  }
  return {rows,complete:false};
}
export function finances(rows){
  const result={customerEscrow:0n,replenishmentLiability:0n,recallFunding:0n,grossReceipts:0n,
    replenished:0n,refunded:0n};
  for(const row of rows){
    const job=row.service?.job;
    if(job){
      if(['REQUESTED','EXECUTING','UNCERTAIN','RECONCILING'].includes(job.status))result.customerEscrow+=amount(job.fee);
      if(job.status==='RECONCILING')result.replenishmentLiability+=amount(job.replenish);
      if(job.status==='FINALIZED'){result.grossReceipts+=amount(job.fee);result.replenished+=amount(job.replenish)}
      if(job.status==='FAILED')result.refunded+=amount(job.fee);
    }else if(row.legacy_job&&['REQUESTED','EXECUTING'].includes(row.legacy_job.status))result.customerEscrow+=amount(row.legacy_job.fee);
    if(row.recall&&row.recall.state!=='FINALIZED')result.recallFunding+=amount(row.recall.deposit);
  }
  return Object.fromEntries(Object.entries(result).map(([key,value])=>[key,value.toString()]));
}
export function recoveryActions({registryAccountId,tokenId,project,agent,rows,resume,now=Date.now()}){
  const actions=[];
  const add=(methodName,args,label)=>actions.push({label,unsignedAction:{receiverId:registryAccountId,
    methodName,args:{token_id:tokenId,...args},deposit:'0',gas:'250000000000000'}});
  if(project?.state==='UNCERTAIN'&&agent?.pending_op!=null)add('reconcile_outlayer_project',{},'Inspect Project and reconcile');
  const pending=rows.find(row=>row.id===agent?.pending_op);
  const job=pending?.service?.job,recall=pending?.recall;
  if(job?.status==='REQUESTED'&&BigInt(job.deadline_ns)<=BigInt(now)*1_000_000n)
    add('expire_unstarted_paid_scout',{id:pending.id},'Refund expired unstarted job');
  if(job?.status==='RECONCILING'&&!job.reimbursement_pending)
    add('retry_outlayer_replenishment',{id:pending.id},'Retry confirmed replenishment failure');
  if(recall?.state==='RECONCILING'&&!recall.reimbursement_pending)
    add('retry_recall_replenishment',{id:pending.id},'Retry recall replenishment');
  const failed=rows.find(row=>row.id===(resume?.failed_job_id??(agent?.next_op_id-1))&&row.service?.job.status==='FAILED');
  if(agent?.lifecycle==='Draining'&&failed&&(agent.pending_op==null||resume)){
    add('resume_failed_service',{failed_job_id:failed.id},'Verify vault is clear and resume after definite failure');
    actions.at(-1).ownerRequired=true;actions.at(-1).unsignedAction.deposit='1';
  }
  return actions;
}
export async function studioAudit(sdk,id){
  const first=await sdk.view(sdk.registryAccountId,'studio_audit',{token_id:id,from:1,limit:50});
  let from=Math.max(1,(first?.count||0)-199),rows=[];
  while(rows.length<200){const page=from===1?first:await sdk.view(sdk.registryAccountId,'studio_audit',
    {token_id:id,from,limit:50});if(!Array.isArray(page?.rows))throw Error('Audit unavailable');
    rows.push(...page.rows);if(page.next==null)break;from=page.next}
  return rows;
}
