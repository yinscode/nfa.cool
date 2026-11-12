const amount=x=>{const n=BigInt(x??0);if(n<0n)throw Error('Negative accounting amount');return n};
export function businessSummary(snapshot){
  const f=snapshot.financial,complete=snapshot.financialComplete===true;
  const rows=snapshot.jobs||[],byService={};let finalized=0,failed=0,unresolved=0;
  for(const row of rows){
    const record=row.service,job=record?.job;if(!job)continue;
    const service=byService[record.service_id]||={finalized:0,failed:0,pending:0,grossReceiptsYocto:'0',executionReplenishmentYocto:'0',creditedEarningsYocto:'0'};
    if(job.status==='FINALIZED'){
      const fee=amount(job.fee),replenish=amount(job.replenish);if(replenish>fee)throw Error('Replenishment exceeds paid fee');
      service.finalized++;finalized++;
      service.grossReceiptsYocto=(amount(service.grossReceiptsYocto)+fee).toString();
      service.executionReplenishmentYocto=(amount(service.executionReplenishmentYocto)+replenish).toString();
      service.creditedEarningsYocto=(amount(service.creditedEarningsYocto)+fee-replenish).toString();
    }else if(job.status==='FAILED'){service.failed++;failed++}else{service.pending++;unresolved++}
  }
  const gross=f?amount(f.grossReceipts):null,replenished=f?amount(f.replenished):null;
  return {unit:'yoctoNEAR',coverage:complete?'complete_job_history':'partial_or_unavailable',
    grossCustomerReceipts:gross?.toString()??null,executionReplenishment:replenished?.toString()??null,
    creditedServiceEarnings:gross!=null&&replenished!=null?(gross-replenished).toString():null,
    withdrawableIncome:snapshot.identity.income??null,operatingAvailable:snapshot.treasury?.available??null,
    storageReserve:snapshot.treasury?.storage_reserve??null,gasReserve:snapshot.treasury?.gas_reserve??null,
    customerEscrow:f?.customerEscrow??null,replenishmentLiability:f?.replenishmentLiability??null,
    customerRefundCredits:f?.refunded??null,actualOutlayerExecutionCost:null,externalInferenceCost:null,
    gasPaid:null,netProfit:null,jobs:{finalized,failed,unresolved},byService,
    explanation:'Replenishment is an execution reserve returned to the vault, not measured compute cost. Service earnings are fee minus replenishment. Actual OutLayer, inference, storage and gas costs are not fully reconciled; net profit is unknown. Prefunding, sale proceeds and customer escrow are not service revenue.'};
}

export function buyerInventory(snapshot){
  const i=snapshot.identity,p=snapshot.project,pending=snapshot.agent?.pending_op;
  const services=(snapshot.services||[]).filter(s=>s.enabled).map(s=>({id:s.service_id,policyVersion:s.version,schemaHash:s.schema_hash}));
  return {tokenId:i.tokenId,owner:i.ownerAccountId,ownerEpoch:i.ownerEpoch,lifecycle:i.lifecycle,
    transferBarrier:pending!=null?{blocked:true,operationId:pending}:['DRAINING','TRANSFER_CALL_PENDING'].includes(i.lifecycle)?
      {blocked:true,reason:'lifecycle_requires_reconciliation'}:{blocked:false},
    included:{vault:i.vaultAccountId,vaultBalance:snapshot.treasury?.balance??null,
      unclaimedIncome:i.income??null,characterManifest:i.manifestHash,
      chainAddresses:i.foreignWallet?[{chainId:i.foreignWallet.chain_id,address:i.foreignWallet.address}]:[],
      outlayerProject:p?{id:p.project_id,uuid:p.project_uuid,version:p.version_key,state:p.state}:null,
      services,eligibleWork:(snapshot.jobs||[]).filter(r=>r.service?.job.status==='FINALIZED').map(r=>({jobId:r.id,service:r.service.service_id,outputHash:r.service.job.output_hash}))},
    liabilities:{customerEscrow:snapshot.financial?.customerEscrow??null,replenishment:snapshot.financial?.replenishmentLiability??null,
      recallFunding:snapshot.financial?.recallFunding??null},
    excluded:['Seller personal credentials and OAuth grants','Nontransferable memberships or subscriptions','Seller-held copies of downloaded data','Unverified external assets'],
    dependencies:['Guardian upgrade authority','Trusted Sepolia settlement reporter','OutLayer availability and operating reserve','Externally granted credentials can be revoked'],
    historyComplete:snapshot.financialComplete===true,projectAgreement:snapshot.projectAgreement===true,
    note:'Current finalized views are observations, not a guarantee of future revenue or a legal company transfer.'};
}
