export async function inspectTransaction({sdk,tokenId,hash,sender}){
  const identity=await sdk.get(tokenId),outcome=await sdk.transaction(hash,sender);
  const transaction=outcome.transaction;
  if(transaction?.signer_id!==sender||transaction.hash!==hash||
    ![sdk.registryAccountId,identity.vaultAccountId].includes(transaction.receiver_id))throw Error('Transaction does not belong to this NFA');
  const calls=(transaction.actions||[]).filter(a=>a.FunctionCall).map(a=>{
    const call=a.FunctionCall;let args;try{args=JSON.parse(Buffer.from(call.args,'base64').toString())}catch{throw Error('Invalid transaction arguments')}
    return {method:call.method_name,args};
  });
  if(transaction.receiver_id===sdk.registryAccountId&&!calls.some(call=>call.args.token_id===tokenId))throw Error('Transaction token mismatch');
  const events=(outcome.receipts_outcome||[]).flatMap(receipt=>
    receipt.outcome.executor_id===sdk.registryAccountId?(receipt.outcome.logs||[]).flatMap(log=>{
      if(!log.startsWith('EVENT_JSON:'))return [];try{const event=JSON.parse(log.slice(11));
        return event.standard==='nfa'?(event.data||[]).filter(data=>data.token_id===tokenId).map(data=>({event:event.event,data,receiptId:receipt.id})):[];
      }catch{return []}
    }):[]);
  let assignedJobId=null;
  const request=calls.find(call=>['request_service_job','request_paid_scout','request_reviewed_service_job'].includes(call.method));
  const candidate=events.find(event=>event.event==='service_job_requested')?.data.id;
  if(request&&Number.isSafeInteger(candidate)){
    const job=await sdk.getPaidJob(tokenId,candidate);
    if(job?.requester!==sender||job.input_hash!==request.args.input_hash)throw Error('Job receipt commitment mismatch');
    assignedJobId=candidate;
  }
  return {hash,sender,tokenId,finality:outcome.final_execution_status||'UNKNOWN',
    status:outcome.final_execution_status!=='FINAL'?'PENDING':outcome.status?.Failure?'FAILED':Object.hasOwn(outcome.status||{},'SuccessValue')?'SUCCEEDED':'PENDING',
    events,assignedJobId,methods:calls.map(call=>call.method)};
}
