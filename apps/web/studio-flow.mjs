export function transactionHashes(value){
  const rows=Array.isArray(value)?value:[value];
  return rows.map(row=>row?.transaction?.hash||row?.transaction_outcome?.id||row?.transactionHash)
    .filter(hash=>typeof hash==='string'&&/^[1-9A-HJ-NP-Za-km-z]{40,44}$/.test(hash));
}
export function matchingJob(snapshot,{inputHash,sender,service}){
  return (snapshot.jobs||[]).filter(row=>row.service?.service_id===service&&
    row.service.job.input_hash===inputHash&&row.service.job.requester===sender);
}
export function quoteExpired(quote,now=Date.now()){
  return !quote||BigInt(quote.deadlineNs)<=BigInt(now)*1_000_000n;
}
