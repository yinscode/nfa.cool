const TESTNET_API='https://testnet-api.outlayer.ai';
const ACCOUNT=/^[a-z0-9][a-z0-9._-]{1,63}$/;
const HASH=/^[a-f0-9]{64}$/;
const CALL=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export function paymentKeyOwner(key){
  if(typeof key!=='string')throw Error('OutLayer Payment Key required');
  const parts=key.split(':');
  if(parts.length!==3||!ACCOUNT.test(parts[0])||!/^\d+$/.test(parts[1])||parts[2].length<32)
    throw Error('Invalid OutLayer Payment Key format');
  return parts[0];
}

async function boundedJson(response){
  if(!response.body?.getReader)throw Error('OutLayer streaming response required');
  const reader=response.body.getReader(),chunks=[];let size=0;
  try{
    for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;
      if(size>64_000)throw Error('OutLayer response too large');chunks.push(value)}
  }finally{await reader.cancel().catch(()=>{})}
  const bytes=new Uint8Array(size);let offset=0;
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength}
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))}
  catch{throw Error('Invalid OutLayer JSON response')}
}

/** Testnet-only transport. A caller must separately establish paid NFA authority and settlement. */
export class OutlayerHttpsAsync{
  constructor({paymentKey,vaultId,projectId,versionKey,computeLimitMicrousd=30_000,
    executionLimitSeconds=30,fetchImpl=fetch}){
    if(!ACCOUNT.test(vaultId)||projectId!==`${vaultId}/scout`||!HASH.test(versionKey))
      throw Error('Pinned vault Project required');
    if(paymentKeyOwner(paymentKey)!==vaultId)throw Error('Payment Key owner must be the NFA vault');
    if(!Number.isSafeInteger(computeLimitMicrousd)||computeLimitMicrousd<1_000||computeLimitMicrousd>100_000)
      throw Error('Compute limit outside probe cap');
    if(!Number.isSafeInteger(executionLimitSeconds)||executionLimitSeconds<1||executionLimitSeconds>180)
      throw Error('Execution limit outside OutLayer cap');
    this.paymentKey=paymentKey;this.vaultId=vaultId;this.projectId=projectId;this.versionKey=versionKey;
    this.computeLimitMicrousd=computeLimitMicrousd;this.executionLimitSeconds=executionLimitSeconds;
    this.fetchImpl=fetchImpl;
  }

  async submitRecall({jobId,service,expectedHash}){
    if(!Number.isSafeInteger(jobId)||jobId<1||!['scout','compare','research'].includes(service)||
      !/^sha256:[a-f0-9]{64}$/.test(expectedHash))throw Error('Finalized recall commitment required');
    const input={operation:'recall',service,jobId,expectedHash};
    return this.submit(input);
  }

  /** Diagnostic only: this does not reserve or settle an NFA paid job. */
  async submitResearchDiagnostic(input,secretsRef){
    const registry=this.vaultId.slice(this.vaultId.indexOf('.')+1);
    const tokenId=this.vaultId.split('.')[0];
    if(input?.operation!=='run'||input?.service!=='research'||
      !Number.isSafeInteger(input.jobId)||input.jobId<1_000_000_000||input.jobId>1_000_000_100||
      input.context?.vaultAccountId!==this.vaultId||input.context?.registryAccountId!==registry||
      input.context?.tokenId!==tokenId||!Number.isSafeInteger(input.context?.ownerEpoch)||
      input.context?.priorWork?.length!==0||input.research?.settings?.version_key!==this.versionKey||
      input.research?.settings?.secrets_ref?.account_id!==secretsRef?.account_id||
      input.research?.settings?.secrets_ref?.profile!==secretsRef?.profile||
      typeof input.question!=='string'||input.question.length>240||
      !Array.isArray(input.sources)||input.sources.length!==1||
      input.sources[0].url!=='https://docs.near.org/protocol/accounts-contracts/access-keys'||
      JSON.stringify(input).length>8192)
      throw Error('Diagnostic Research input is outside the pinned vault, source or job range');
    return this.submit(input,secretsRef);
  }

  async submit(input,secretsRef){
    // POST is intentionally never retried: a timeout may mean a paid call was queued.
    let response;
    try{response=await this.fetchImpl(`${TESTNET_API}/call/${this.projectId}`,{
      method:'POST',headers:{'content-type':'application/json','x-payment-key':this.paymentKey,
        'x-compute-limit':String(this.computeLimitMicrousd)},
      body:JSON.stringify({input,async:true,version_key:this.versionKey,
        ...(secretsRef?{secrets_ref:secretsRef}:{}),
        resource_limits:{max_instructions:1_000_000_000,max_memory_mb:128,
          max_execution_seconds:this.executionLimitSeconds}}),
      signal:AbortSignal.timeout(15_000)})}
    catch{throw Error('Async submission outcome unknown; inspect Payment Key activity before retrying')}
    const result=await boundedJson(response);
    if(!response.ok)throw Error(`OutLayer declined async call (HTTP ${response.status}); inspect Payment Key activity before retrying`);
    if(!CALL.test(result.call_id)||!['pending','completed','failed'].includes(result.status))
      throw Error('Invalid OutLayer async admission; inspect Payment Key activity before retrying');
    return {callId:result.call_id,status:result.status,result};
  }

  async poll(callId){
    if(!CALL.test(callId))throw Error('Invalid OutLayer call ID');
    const response=await this.fetchImpl(`${TESTNET_API}/calls/${callId}`,{
      headers:{'x-payment-key':this.paymentKey},signal:AbortSignal.timeout(15_000)});
    const result=await boundedJson(response);
    if(!response.ok)throw Error(`OutLayer poll failed (HTTP ${response.status})`);
    if(result.call_id!==callId||!['pending','completed','failed'].includes(result.status))
      throw Error('Invalid OutLayer poll result');
    return result;
  }
}

export function verifyResearchDiagnostic(result,jobId){
  if(result.status!=='completed')throw Error('Diagnostic Research call has not completed');
  const output=typeof result.output==='string'?JSON.parse(result.output):result.output;
  if(output?.schemaVersion!==1||output.jobId!==jobId||output.status!=='ok'||
    output.inferenceOutcome!=='succeeded'||!/^sha256:[a-f0-9]{64}$/.test(output.outputHash||'')||
    output.outputUri!==`nfa://work/${output.outputHash.slice(7)}`||
    !Number.isSafeInteger(output.pricedUsageMicrousd)||output.pricedUsageMicrousd<1)
    throw Error('Diagnostic Research did not produce a priced model-backed result');
  return {jobId,outputHash:output.outputHash,pricedUsageMicrousd:output.pricedUsageMicrousd,
    computeCostMicrousd:result.compute_cost??null,attestationUrl:result.attestation_url??null};
}

export function verifyRecallResult(result,{jobId,expectedHash}){
  if(result.status!=='completed')throw Error('OutLayer call has not completed successfully');
  const output=typeof result.output==='string'?JSON.parse(result.output):result.output;
  if(output?.schemaVersion!==1||output.jobId!==jobId||output.status!=='ok'||
    output.outputHash!==expectedHash||output.outputUri!==`nfa://work/${expectedHash.slice(7)}`)
    throw Error('OutLayer recall differs from finalized NFA commitment');
  return {jobId,outputHash:expectedHash,callId:result.call_id,
    computeCostMicrousd:result.compute_cost??null};
}
