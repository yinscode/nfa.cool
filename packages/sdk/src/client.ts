import type {NfaIdentity, NfaListing, Operation, ScoutJob, DerivedWallet} from '@nfa/shared';

export type WalletAction = Readonly<{
  receiverId:string; methodName?:string; args?:Record<string,unknown>; gas?:string; deposit:string;
}>;
export type Wallet = {signAndSendTransaction(action:WalletAction):Promise<unknown>};
export type ResearchSettings={version_key:string;secrets_ref:{account_id:string;profile:string};
  allowed_sources:Array<{host:string;path_prefix:string}>;model:string;max_input_tokens:number;max_output_tokens:number;
  input_microusd_per_token:number;output_microusd_per_token:number;max_cost_microusd:number;daily_budget_microusd:number};
export type ResearchConfig={version:number;configuration_hash:string;settings:ResearchSettings};
export type ResearchUsage={configuration_hash:string;configuration_version:number;reserved_microusd:number;
  priced_usage_microusd:number|null;state:'RESERVED'|'NOT_STARTED'|'PRICED_USAGE'|'UNKNOWN';day:number};
type Fetch = typeof fetch;
const GAS='250000000000000', ONE='1', CREATION='6000000000000000000000000';
const SHA=/^sha256:[0-9a-f]{64}$/, TOKEN=/^nfa-[1-9][0-9]*$/;
const token=(x:string)=>{if(!TOKEN.test(x))throw Error('Invalid NFA token ID');return x};
const amount=(x:string)=>{if(!/^[1-9][0-9]*$/.test(x))throw Error('Use a positive decimal integer string');return x};
const hash=(x:string)=>{if(!SHA.test(x))throw Error('Expected sha256 content hash');return x};
const wasmHash=(x:string)=>{if(!/^[0-9a-f]{64}$/.test(x))throw Error('Expected WASM SHA-256');return x};
const wasmUrl=(x:string)=>{if(!/^https:\/\/[^@#\s]{1,292}$/.test(x))throw Error('Immutable HTTPS WASM URL required');return x};
type SkillLimits={max_instructions:number;max_memory_mb:number;max_execution_seconds:number};
const limits=(x:SkillLimits)=>{if(!Number.isSafeInteger(x.max_instructions)||x.max_instructions<1||x.max_instructions>2_000_000_000||
  !Number.isSafeInteger(x.max_memory_mb)||x.max_memory_mb<1||x.max_memory_mb>128||
  !Number.isSafeInteger(x.max_execution_seconds)||x.max_execution_seconds<1||x.max_execution_seconds>30)
  throw Error('Scout resource limits exceeded');return x};
// A JS number at Unix nanosecond scale loses sub-microsecond precision; expiry
// decisions are in seconds. The contract checks the final integer against block time.
const op=(x:number)=>{if(!Number.isSafeInteger(x)||x<1)throw Error('Invalid operation ID');return x};
const fee=(x:number)=>{if(!Number.isSafeInteger(x)||x<1||x>100_000_000_000)throw Error('Invalid EVM fee');return x};
const ns=(x:number)=>{if(!Number.isFinite(x)||!Number.isInteger(x)||x<=0)throw Error('Invalid nanosecond timestamp');return x};

/** Read-only RPC plus wallet-owned writes. The SDK holds no private keys. */
export class NfaSdk {
  readonly registryAccountId:string;
  readonly rpcUrl:string;
  private readonly wallet?:Wallet;
  private readonly fetchImpl:Fetch;
  constructor({registryAccountId,rpcUrl,wallet,fetchImpl=fetch}:{registryAccountId:string;rpcUrl:string;wallet?:Wallet;fetchImpl?:Fetch}) {
    if(!/^[a-z0-9._-]{2,64}$/.test(registryAccountId)||!/^https?:\/\//.test(rpcUrl))throw Error('Invalid registry/RPC');
    this.registryAccountId=registryAccountId;this.rpcUrl=rpcUrl;this.wallet=wallet;this.fetchImpl=fetchImpl.bind(globalThis);
  }
  async view<T>(accountId:string,methodName:string,args:Record<string,unknown>={}):Promise<T> {
    const input=new TextEncoder().encode(JSON.stringify(args));
    const args_base64=btoa(Array.from(input,b=>String.fromCharCode(b)).join(''));
    const body={jsonrpc:'2.0',id:'nfa',method:'query',params:{request_type:'call_function',finality:'final',
      account_id:accountId,method_name:methodName,args_base64}};
    const response=await this.fetchImpl(this.rpcUrl,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw Error(`NEAR RPC HTTP ${response.status}`);
    const result=await response.json();
    if(result.error)throw Error(`NEAR RPC: ${result.error.message||JSON.stringify(result.error)}`);
    if(!Array.isArray(result.result?.result))throw Error(`NEAR RPC returned no result for ${accountId}.${methodName}: ${JSON.stringify(result.result?.error||result.error||result.result?.status||'invalid response')}`);
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(result.result.result))) as T;
  }
  async get(id:string):Promise<NfaIdentity & {income:string;listing:NfaListing|null;foreignWallet:DerivedWallet|null}> {
    token(id);
    const [nft,agent,income,listing,foreignWallet]=await Promise.all([
      this.view<{owner_id:string}|null>(this.registryAccountId,'nft_token',{token_id:id}),
      this.view<{vault_id:string;epoch:number;lifecycle:string;manifest_hash:string;manifest_uri:string}|null>(this.registryAccountId,'agent',{token_id:id}),
      this.view<string>(this.registryAccountId,'agent_income',{token_id:id}),
      this.view<NfaListing|null>(this.registryAccountId,'listing',{token_id:id}),
      this.view<DerivedWallet|null>(this.registryAccountId,'derived_wallet',{token_id:id})]);
    if(!nft||!agent)throw Error('NFA not found');
    const states:Record<string,NfaIdentity['lifecycle']>={Active:'ACTIVE',Draining:'DRAINING',Listed:'LISTED',TransferCallPending:'TRANSFER_CALL_PENDING'};
    if(!states[agent.lifecycle])throw Error('Unknown lifecycle');
    return {registryAccountId:this.registryAccountId,tokenId:id,vaultAccountId:agent.vault_id,
      ownerAccountId:nft.owner_id,ownerEpoch:agent.epoch,lifecycle:states[agent.lifecycle],
      manifestHash:agent.manifest_hash,manifestUri:agent.manifest_uri,income,listing,foreignWallet};
  }
  async transaction(txHash:string,sender:string):Promise<Record<string,any>>{
    if(!/^[1-9A-HJ-NP-Za-km-z]{40,44}$/.test(txHash)||!/^[a-z0-9._-]{2,64}$/.test(sender))throw Error('Invalid transaction lookup');
    const response=await this.fetchImpl(this.rpcUrl,{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({jsonrpc:'2.0',id:'studio-tx',method:'tx',params:{tx_hash:txHash,
        sender_account_id:sender,wait_until:'FINAL'}}),signal:AbortSignal.timeout(15000)});
    const data=await response.json();if(!response.ok||data.error||!data.result)throw Error('Transaction not finalized or RPC unavailable');
    return data.result;
  }
  async getHistory(id:string,from=1,limit=20):Promise<Operation[]> {
    token(id);
    if(!Number.isSafeInteger(from)||from<1||!Number.isSafeInteger(limit)||limit<1||limit>50)throw Error('Invalid pagination');
    const agent=await this.view<{vault_id:string;next_op_id:number}|null>(this.registryAccountId,'agent',{token_id:id});
    if(!agent)throw Error('NFA not found');
    const ids=Array.from({length:Math.min(limit,Math.max(0,agent.next_op_id-from))},(_,i)=>from+i);
    const rows=await Promise.all(ids.map(n=>this.view<Record<string,unknown>|null>(this.registryAccountId,'operation',{token_id:id,id:n})));
    const states:Record<string,Operation['status']>={Requested:'REQUESTED',Submitted:'SUBMITTED',Finalized:'FINALIZED',Failed:'FAILED',Uncertain:'UNCERTAIN'};
    return rows.filter((x):x is Record<string,unknown>=>!!x).map(x=>({id:Number(x.id),tokenId:id,ownerEpoch:Number(x.epoch),
      kind:x.kind as Operation['kind'],status:states[String(x.status)],vaultAccountId:agent.vault_id,
      requestedBy:String(x.requested_by),recipient:String(x.recipient),amount:String(x.amount)}));
  }
  getJob(id:string,jobId:number){return this.view<ScoutJob|null>(this.registryAccountId,'scout_job',{token_id:token(id),id:jobId})}
  getOutlayerProject(id:string){return this.view<Record<string,unknown>|null>(this.registryAccountId,'outlayer_project',{token_id:token(id)})}
  getChainKey(id:string,chain:'eth-sepolia'='eth-sepolia'){
    return this.view<Record<string,unknown>|null>(this.registryAccountId,'chain_key',{token_id:token(id),chain});
  }
  getPaidJob(id:string,jobId:number){return this.view<Record<string,unknown>|null>(this.registryAccountId,'paid_scout_job',{token_id:token(id),id:jobId})}
  getServiceJob(id:string,jobId:number){return this.view<Record<string,unknown>|null>(this.registryAccountId,'service_job',{token_id:token(id),id:jobId})}
  getServiceCatalog(id:string){return this.view<Array<Record<string,unknown>>>(this.registryAccountId,'service_catalog',{token_id:token(id)})}
  getServicePolicy(id:string,serviceId:'scout'|'compare'|'research'){
    return this.view<Record<string,unknown>|null>(this.registryAccountId,'service_policy',{token_id:token(id),service_id:serviceId})
  }
  getAgentState(id:string){return this.view<{lifecycle:string;pending_op:number|null}>(this.registryAccountId,'agent',{token_id:token(id)})}
  getPaidLedger(){return this.view<Record<string,string>>(this.registryAccountId,'paid_scout_ledger')}
  getMemoryReceipt(id:string,jobId:number){return this.view<Record<string,unknown>|null>(this.registryAccountId,'owner_memory_receipt',{token_id:token(id),id:jobId})}
  async getTreasury(id:string){const agent=await this.get(id);return this.view<Record<string,string>>(agent.vaultAccountId,'treasury')}
  prepare(methodName:string,args:Record<string,unknown>,deposit=ONE,gas=GAS):WalletAction {
    if(!/^(0|[1-9][0-9]*)$/.test(deposit))throw Error('Invalid deposit');
    return {receiverId:this.registryAccountId,methodName,args,deposit,gas};
  }
  async send(action:WalletAction){if(!this.wallet)throw Error('Wallet required for writes');return this.wallet.signAndSendTransaction(action)}
  create({requestId,manifestHash,manifestUri}:{requestId:string;manifestHash:string;manifestUri:string}){
    if(!requestId||requestId.length>64||!manifestUri||manifestUri.length>256)throw Error('Invalid creation input');
    return this.prepare('create_agent',{request_id:requestId,manifest_hash:hash(manifestHash),manifest_uri:manifestUri},CREATION);
  }
  fund(vaultAccountId:string,yocto:string):WalletAction{return {receiverId:vaultAccountId,deposit:amount(yocto)}}
  updateManifest(id:string,manifestHash:string,manifestUri:string){
    if(!manifestUri||manifestUri.length>256)throw Error('Invalid manifest URI');
    return this.prepare('update_manifest',{token_id:token(id),manifest_hash:hash(manifestHash),manifest_uri:manifestUri});
  }
  grant(id:string,delegate:string,method:'NEAR_TRANSFER'|'SCOUT_RUN',recipient:string|null,budget:string,expiresAtNs:number){
    return this.prepare('grant_delegate',{token_id:token(id),delegate,method,recipient,budget:amount(budget),expires_at_ns:ns(expiresAtNs)});
  }
  revoke(id:string,delegate:string,method:'NEAR_TRANSFER'|'SCOUT_RUN'){
    return this.prepare('revoke_delegate',{token_id:token(id),delegate,method});
  }
  requestNearTransfer(id:string,recipient:string,yocto:string){
    return this.prepare('request_near_transfer',{token_id:token(id),recipient,amount:amount(yocto)});
  }
  requestEvmTransfer(id:string,recipientHex:string,valueWei:string,priorityFee:number,maxFee:number){
    if(!/^0x[0-9a-fA-F]{40}$/.test(recipientHex))throw Error('Invalid EVM address');
    return this.prepare('request_evm_transfer',{token_id:token(id),recipient_hex:recipientHex,
      value_wei:amount(valueWei),priority_fee:priorityFee,max_fee:maxFee});
  }
  /** Owner: same-nonce EVM replacement with >=10% higher fees, or a zero-value self-send that cancels. */
  replaceEvmTransfer(id:string,operationId:number,priorityFee:number,maxFee:number,cancel=false){
    return this.prepare('replace_evm_transfer',{token_id:token(id),id:op(operationId),priority_fee:fee(priorityFee),max_fee:fee(maxFee),cancel});
  }
  /** Owner or reporter: ask the signer again for the same digest after an uncertain signer result. */
  retryEvmSignature(id:string,operationId:number){return this.prepare('retry_evm_signature',{token_id:token(id),id:op(operationId)},'0')}
  /** Permissionless recovery that reads vault state; none can grant a new authority. */
  recoverEvmOperation(id:string,operationId:number){return this.prepare('recover_evm_operation',{token_id:token(id),id:op(operationId)},'0')}
  reconcileNearOperation(id:string,operationId:number){return this.prepare('reconcile_near_operation',{token_id:token(id),id:op(operationId)},'0')}
  releaseServiceJob(id:string,jobId:number){return this.prepare('release_service_job',{token_id:token(id),id:op(jobId)},'0')}
  retryJobAck(id:string,jobId:number){return this.prepare('retry_job_ack',{token_id:token(id),id:op(jobId)},'0')}
  /** Owner: cancel a job that has not started, refunding the customer in full. */
  cancelUnstartedJob(id:string,jobId:number){return this.prepare('cancel_unstarted_job',{token_id:token(id),id:op(jobId)})}
  getRegistryLedger(){return this.view<{liabilities:string;storage_fees:string;job_storage_fee:string;start_window_ns:string}>(this.registryAccountId,'registry_ledger')}
  deriveWallet(id:string){return this.prepare('derive_wallet',{token_id:token(id)},'0')}
  runJob(id:string,briefHash:string,sourceHash:string,fee:string,deadlineNs:number){
    return this.prepare('request_scout_job',{token_id:token(id),brief_hash:hash(briefHash),
      source_hash:hash(sourceHash),deadline_ns:ns(deadlineNs),fee:amount(fee)},fee);
  }
  provisionOutlayer(id:string,url:string,versionKey:string,deposit:string){
    return this.prepare('provision_outlayer',{token_id:token(id),wasm_url:wasmUrl(url),version_key:wasmHash(versionKey),deposit:amount(deposit)});
  }
  addOutlayerVersion(id:string,url:string,versionKey:string,deposit:string){
    return this.prepare('add_outlayer_version',{token_id:token(id),wasm_url:wasmUrl(url),version_key:wasmHash(versionKey),deposit:amount(deposit)});
  }
  activateOutlayerVersion(id:string){return this.prepare('activate_outlayer_version',{token_id:token(id)})}
  configureService(id:string,serviceId:'scout'|'compare'|'research',schemaHash:string,enabled:boolean,
    margin:string,maxDeposit:string,resourceLimits:SkillLimits){
    return this.prepare('configure_service',{token_id:token(id),service_id:serviceId,schema_hash:hash(schemaHash),
      enabled,min_margin:amount(margin),max_deposit:amount(maxDeposit),limits:limits(resourceLimits)});
  }
  getResearchConfig(id:string){return this.view<ResearchConfig|null>(this.registryAccountId,'research_config',{token_id:token(id)})}
  configureResearch(id:string,settings:ResearchSettings){return this.prepare('configure_research',{token_id:token(id),settings})}
  verifyResearchVault(id:string){return this.prepare('verify_research_vault',{token_id:token(id)})}
  startServiceJob(id:string,jobId:number,inputData:string){
    if(!Number.isSafeInteger(jobId)||jobId<1||new TextEncoder().encode(inputData).length>8192)
      throw Error('Invalid service input');
    return this.prepare('start_service_job',{token_id:token(id),id:jobId,input_data:inputData},'0');
  }
  requestReviewedServiceJob(id:string,serviceId:'scout'|'compare'|'research',inputHash:string,deadlineNs:number,
    fee:string,replenish:string,depositCap:string,resourceLimits:SkillLimits,versionKey:string,policyVersion:number,researchConfigHash?:string){
    if(!Number.isSafeInteger(policyVersion)||policyVersion<0||!['scout','compare','research'].includes(serviceId))throw Error('Invalid reviewed quote');
    if(serviceId==='research'&&!researchConfigHash)throw Error('Pinned research configuration required');
    return this.prepare('request_reviewed_service_job',{token_id:token(id),service_id:serviceId,input_hash:hash(inputHash),
      deadline_ns:ns(deadlineNs),fee:amount(fee),replenish:amount(replenish),deposit_cap:amount(depositCap),
      limits:limits(resourceLimits),expected_version:wasmHash(versionKey),expected_policy_version:policyVersion,
      ...(serviceId==='research'?{expected_research_config:hash(researchConfigHash!)}:{})},fee);
  }
  startPaidScout(id:string,jobId:number,inputData:string){
    if(!Number.isSafeInteger(jobId)||jobId<1||inputData.length>8192)throw Error('Invalid paid Scout input');
    return this.prepare('start_paid_scout',{token_id:token(id),id:jobId,input_data:inputData},'0');
  }
  recallOwnerMemory(id:string,jobId:number,deposit:string){
    if(!Number.isSafeInteger(jobId)||jobId<1)throw Error('Invalid finalized job ID');
    return this.prepare('recall_owner_memory',{token_id:token(id),job_id:jobId,deposit:amount(deposit)},deposit);
  }
  claimIncome(id:string,yocto:string){return this.prepare('claim_income',{token_id:token(id),amount:amount(yocto)})}
  withdrawProceeds(yocto:string){return this.prepare('withdraw_proceeds',{amount:amount(yocto)})}
  prepareTransfer(id:string,receiverId:string){return this.prepare('nft_transfer',{receiver_id:receiverId,token_id:token(id)})}
  listForSale(id:string,price:string,expiresAtNs:number){
    return this.prepare('create_listing',{token_id:token(id),price:amount(price),expires_at_ns:ns(expiresAtNs)});
  }
  unlist(id:string){return this.prepare('unlist_agent',{token_id:token(id)})}
  buy(id:string,nonce:number,price:string){
    if(!Number.isSafeInteger(nonce)||nonce<=0)throw Error('Invalid listing nonce');
    return this.prepare('buy',{token_id:token(id),expected_nonce:nonce},amount(price));
  }
}
