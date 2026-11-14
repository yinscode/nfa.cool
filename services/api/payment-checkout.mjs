import {randomUUID} from 'node:crypto';
import {mkdir,open,readFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {withFileLock} from '../worker/file-lock.mjs';

const DEC=/^[1-9][0-9]*$/;
const ACCOUNT=/^[a-z0-9._-]{2,64}$/;
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?
  Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const same=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
const decode=call=>JSON.parse(Buffer.from(call.args,'base64').toString('utf8'));
const success=tx=>tx?.final_execution_status==='FINAL'&&!!tx.status&&
  Object.hasOwn(tx.status,'SuccessValue')&&!tx.status.Failure;

/** Inspect the finalized FT transaction, not a payer-supplied screenshot or balance. */
export function verifyFtReceipt(tx,{hash,tokenContract,from,to,amount,memo}){
  const actual=tx?.transaction;
  if(!success(tx)||actual?.hash!==hash||actual.signer_id!==from||
    actual.receiver_id!==tokenContract||actual.actions?.length!==1)throw Error('FT payment is not final');
  const call=actual.actions[0].FunctionCall;
  if(!call||call.method_name!=='ft_transfer'||String(call.deposit)!=='1'||
    !same(decode(call),{receiver_id:to,amount,memo}))throw Error('FT payment does not match quote');
  return true;
}

/** Confirm the 1Click-listed destination transaction actually credited the merchant FT. */
export async function verifyIntentsDestination({sdk,status,tokenContract,merchantAccountId,amount,senders}){
  const hashes=status?.swapDetails?.destinationChainTxHashes?.map(row=>row.hash)||[];
  if(!Array.isArray(senders)||!senders.length||!hashes.length)throw Error('No destination transaction to verify');
  for(const hash of hashes){
    if(typeof hash!=='string'||!hash)continue;
    for(const sender of senders){
      let tx;try{tx=await sdk.transaction(hash,sender)}catch{continue}
      if(!success(tx)||tx.transaction?.hash!==hash||tx.transaction?.signer_id!==sender)continue;
      let credited=0n;
      for(const receipt of tx.receipts_outcome||[]){
        if(receipt.outcome?.executor_id!==tokenContract)continue;
        for(const log of receipt.outcome.logs||[]){
          if(!log.startsWith('EVENT_JSON:'))continue;
          let event;try{event=JSON.parse(log.slice(11))}catch{continue}
          if(event.standard!=='nep141'||event.event!=='ft_transfer')continue;
          for(const row of event.data||[]){
            if(row.new_owner_id===merchantAccountId&&DEC.test(String(row.amount)))credited+=BigInt(row.amount);
          }
        }
      }
      if(credited>=BigInt(amount))return {final:true,hash};
    }
  }
  throw Error('Destination FT credit not final or insufficient');
}

/** Durable, single-claim checkout journal. Operators sign the returned NEAR action. */
export class PaymentCheckout{
  constructor({sdk,directory,merchantAccountId,assets,intentsClient=null,verifyIntentsDelivery=null,
    merchantAvailable=null,now=Date.now}){
    if(!ACCOUNT.test(merchantAccountId)||!directory||!assets||typeof assets!=='object')
      throw Error('Invalid checkout configuration');
    this.sdk=sdk;this.directory=directory;this.merchantAccountId=merchantAccountId;
    this.assets=assets;this.intentsClient=intentsClient;this.verifyIntentsDelivery=verifyIntentsDelivery;
    this.merchantAvailable=merchantAvailable||(()=>this.#availableFromRpc());this.now=now;
  }
  async #availableFromRpc(){
    if(!this.sdk.rpcUrl)throw Error('Merchant RPC unavailable');
    const response=await fetch(this.sdk.rpcUrl,{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({jsonrpc:'2.0',id:'checkout-reserve',method:'query',params:{request_type:'view_account',
        finality:'final',account_id:this.merchantAccountId}}),signal:AbortSignal.timeout(15_000)});
    const data=await response.json();
    if(!response.ok||data.error||!data.result?.amount)throw Error('Merchant balance unavailable');
    const free=BigInt(data.result.amount)-BigInt(data.result.storage_usage)*10n**19n-10n**23n;
    return free>0n?free:0n;
  }
  async #assertCapacity(j,tokenContract,fee){
    const registration=await this.sdk.view(tokenContract,'storage_balance_of',{account_id:this.merchantAccountId});
    if(!registration)throw Error('Merchant is not registered for the checkout token');
    const reserved=Object.values(j.quotes).filter(q=>q.state==='AWAITING_PAYMENT'||q.state==='PAYMENT_CONFIRMED')
      .filter(q=>this.now()<=q.expiresAt).reduce((sum,q)=>sum+BigInt(q.quote.feeYocto),0n);
    if(BigInt(await this.merchantAvailable())<reserved+BigInt(fee))throw Error('Merchant NEAR reserve cannot cover quote');
  }
  async #locked(work){
    await mkdir(this.directory,{recursive:true,mode:0o700});
    return withFileLock(join(this.directory,'.checkout.lock'),async()=>{
      let journal;try{journal=JSON.parse(await readFile(join(this.directory,'checkout.json'),'utf8'))}
      catch(e){if(e.code!=='ENOENT')throw e;journal={quotes:{},receipts:{},fundings:{}}}
      const result=await work(journal);
      const path=join(this.directory,`checkout.${process.pid}.${randomUUID()}.tmp`);
      const h=await open(path,'wx',0o600);
      try{await h.writeFile(JSON.stringify(journal));await h.sync()}finally{await h.close()}
      await rename(path,join(this.directory,'checkout.json'));
      return result;
    });
  }
  #asset(tokenContract){
    const asset=this.assets[tokenContract];
    if(!ACCOUNT.test(tokenContract)||!asset||!DEC.test(asset.atomicPerNear))throw Error('Unsupported checkout token');
    return asset;
  }
  #amount(quote,asset){
    if(!DEC.test(quote.feeYocto))throw Error('Invalid service fee');
    const price=(BigInt(quote.feeYocto)*BigInt(asset.atomicPerNear)+10n**24n-1n)/10n**24n;
    if(price<=0n)throw Error('Token price rounds to zero');
    return price.toString();
  }
  async tokenQuote({quote,tokenContract,payer}){
    const asset=this.#asset(tokenContract);
    if(quote?.unsignedAction?.methodName!=='request_reviewed_service_job'||!ACCOUNT.test(payer))
      throw Error('Invalid payer or checkout quote');
    const id=randomUUID(),amount=this.#amount(quote,asset),expiresAt=this.now()+300_000;
    const record={id,kind:'token',state:'AWAITING_PAYMENT',tokenContract,payer,
      merchantAccountId:this.merchantAccountId,amount,expiresAt,quote};
    await this.#locked(async j=>{await this.#assertCapacity(j,tokenContract,quote.feeYocto);j.quotes[id]=record});
    return {id,kind:'token',state:record.state,amountAtomic:amount,tokenContract,
      expiresAt,paymentAction:{receiverId:tokenContract,methodName:'ft_transfer',
        args:{receiver_id:this.merchantAccountId,amount,memo:`nfa-checkout:${id}`},
        deposit:'1',gas:'30000000000000'},service:quote.service,tokenId:quote.tokenId};
  }
  async confirmToken(id,hash){
    return this.#locked(async j=>{
      const q=j.quotes[id];if(!q||q.kind!=='token')throw Error('Unknown token quote');
      if(q.paymentHash){if(q.paymentHash!==hash)throw Error('Payment already claimed');return this.#public(q)}
      if(j.receipts[hash])throw Error('FT receipt already claimed');
      const tx=await this.sdk.transaction(hash,q.payer);
      verifyFtReceipt(tx,{hash,tokenContract:q.tokenContract,from:q.payer,to:q.merchantAccountId,
        amount:q.amount,memo:`nfa-checkout:${id}`});
      q.paymentHash=hash;q.state=this.now()>q.expiresAt?'LATE_PAYMENT':'PAYMENT_CONFIRMED';
      j.receipts[hash]=id;return this.#public(q);
    });
  }
  async intentsQuote({quote,originAsset,refundTo}){
    if(!this.intentsClient||typeof this.verifyIntentsDelivery!=='function'||
      this.sdk.registryAccountId.endsWith('.testnet')||
      !this.merchantAccountId.endsWith('.near'))throw Error('Intents checkout requires NEAR mainnet and a destination verifier');
    const [tokenContract,asset]=Object.entries(this.assets).find(([key,value])=>
      key.endsWith('.near')&&value.intentsAssetId)||[];
    if(quote?.unsignedAction?.methodName!=='request_reviewed_service_job'||!asset||
      !/^nep141:[a-z0-9._-]{2,100}$/.test(originAsset)||!refundTo)
      throw Error('Unsupported Intents route');
    const id=randomUUID(),amount=this.#amount(quote,asset),expiresAt=this.now()+180_000;
    const remote=await this.intentsClient.quote({dry:false,swapType:'EXACT_OUTPUT',
      originAsset,destinationAsset:asset.intentsAssetId,amount,
      depositType:'ORIGIN_CHAIN',recipient:this.merchantAccountId,
      recipientType:'DESTINATION_CHAIN',refundTo,refundType:'ORIGIN_CHAIN',
      slippageTolerance:100,deadline:new Date(expiresAt).toISOString()});
    const depositAddress=remote?.quote?.depositAddress;
    if(typeof depositAddress!=='string'||!depositAddress)throw Error('1Click returned no deposit address');
    const record={id,kind:'intents',state:'AWAITING_PAYMENT',tokenContract,
      merchantAccountId:this.merchantAccountId,amount,expiresAt,originAsset,refundTo,
      depositAddress,remoteQuote:remote,quote};
    await this.#locked(async j=>{await this.#assertCapacity(j,tokenContract,quote.feeYocto);j.quotes[id]=record});
    return {id,kind:'intents',state:record.state,amountAtomic:amount,originAsset,
      destinationAsset:asset.intentsAssetId,depositAddress,expiresAt,service:quote.service,tokenId:quote.tokenId};
  }
  async confirmIntents(id){
    if(typeof this.verifyIntentsDelivery!=='function')throw Error('Destination receipt verifier required');
    return this.#locked(async j=>{
      const q=j.quotes[id];if(!q||q.kind!=='intents')throw Error('Unknown Intents quote');
      if(q.state!=='AWAITING_PAYMENT')return this.#public(q);
      const status=await this.intentsClient.status(q.depositAddress);
      if(status?.status!=='SUCCESS')return {...this.#public(q),swapStatus:status?.status||'UNKNOWN'};
      const request=status.quoteResponse?.quoteRequest;
      if(!request||request.swapType!=='EXACT_OUTPUT'||request.depositType!=='ORIGIN_CHAIN'||
        request.recipientType!=='DESTINATION_CHAIN'||request.refundType!=='ORIGIN_CHAIN'||
        request.refundTo!==q.refundTo||
        status.quoteResponse?.quote?.depositAddress!==q.depositAddress||
        request.originAsset!==q.originAsset||
        request.destinationAsset!==this.assets[q.tokenContract].intentsAssetId||
        request.recipient!==q.merchantAccountId||request.amount!==q.amount||
        status.swapDetails?.amountOut==null||BigInt(status.swapDetails.amountOut)<BigInt(q.amount))
        throw Error('Intents settlement differs from quote');
      const delivery=await this.verifyIntentsDelivery({status,tokenContract:q.tokenContract,
        merchantAccountId:q.merchantAccountId,amount:q.amount});
      if(!delivery?.final||!delivery.hash||j.receipts[delivery.hash])throw Error('Destination token delivery unverified');
      q.paymentHash=delivery.hash;q.state=this.now()>q.expiresAt?'LATE_PAYMENT':'PAYMENT_CONFIRMED';
      j.receipts[delivery.hash]=id;return this.#public(q);
    });
  }
  async fundingAction(id){
    return this.#locked(j=>{
      const q=j.quotes[id];if(!q||q.state!=='PAYMENT_CONFIRMED')throw Error('Payment not ready for funding');
      if(this.now()>q.expiresAt||BigInt(q.quote.deadlineNs)<=BigInt(this.now())*1_000_000n){
        q.state='REFUND_DUE';q.refundDueAtomic=q.amount;return this.#public(q);
      }
      return {id,unsignedAction:q.quote.unsignedAction,inputData:q.quote.inputData,
        inputHash:q.quote.inputHash};
    });
  }
  async confirmFunding(id,hash){
    return this.#locked(async j=>{
      const q=j.quotes[id];if(!q||!['PAYMENT_CONFIRMED','FUNDED'].includes(q.state))throw Error('Payment not ready');
      if(q.fundingHash){if(q.fundingHash!==hash)throw Error('Funding already claimed');return this.#public(q)}
      if(j.fundings[hash])throw Error('Funding receipt already claimed');
      const tx=await this.sdk.transaction(hash,this.merchantAccountId),action=q.quote.unsignedAction;
      const actual=tx?.transaction,call=actual?.actions?.length===1?actual.actions[0].FunctionCall:null;
      if(!success(tx)||actual?.hash!==hash||actual.signer_id!==this.merchantAccountId||
        actual.receiver_id!==action.receiverId||!call||call.method_name!==action.methodName||
        String(call.deposit)!==action.deposit||!same(decode(call),action.args))
        throw Error('Registry funding receipt differs from quote');
      const event=(tx.receipts_outcome||[]).flatMap(row=>row.outcome?.executor_id===this.sdk.registryAccountId?
        (row.outcome.logs||[]):[]).filter(log=>log.startsWith('EVENT_JSON:')).map(log=>JSON.parse(log.slice(11)))
        .find(e=>e.event==='service_job_requested'&&e.data?.some(d=>d.token_id===q.quote.tokenId&&d.input_hash===q.quote.inputHash));
      const jobId=event?.data?.find(d=>d.token_id===q.quote.tokenId)?.id;
      if(!Number.isSafeInteger(jobId)||jobId<1)throw Error('No matching on-chain job event');
      const job=await this.sdk.getServiceJob(q.quote.tokenId,jobId);
      if(job?.job?.requester!==this.merchantAccountId||job.service_id!==q.quote.service)
        throw Error('Funded job identity mismatch');
      q.fundingHash=hash;q.jobId=jobId;q.state='FUNDED';j.fundings[hash]=id;
      return this.#public(q);
    });
  }
  async reconcile(id){
    return this.#locked(async j=>{
      const q=j.quotes[id];if(!q||!q.jobId)throw Error('No funded job');
      if(q.state==='REFUNDED')return this.#public(q);
      const record=await this.sdk.getServiceJob(q.quote.tokenId,q.jobId);
      if(record?.job?.status==='FINALIZED')q.state='COMPLETE';
      else if(record?.job?.status==='FAILED'){
        if(record.refund_credit==null)throw Error('Refund amount not recorded on chain');
        const credit=BigInt(record.refund_credit),fee=BigInt(q.quote.feeYocto);
        if(credit<0n||credit>fee)throw Error('Invalid on-chain refund amount');
        const refund=(BigInt(q.amount)*credit+fee-1n)/fee;
        q.refundDueAtomic=refund.toString();q.state=refund>0n?'REFUND_DUE':'COMPLETE';
      }
      return this.#public(q);
    });
  }
  async refundAction(id){
    return this.#locked(j=>{
      const q=j.quotes[id];
      if(q?.kind==='token'&&q.state==='LATE_PAYMENT'){
        q.state='REFUND_DUE';q.refundDueAtomic=q.amount;
      }
      if(!q||q.kind!=='token'||q.state!=='REFUND_DUE'||!DEC.test(q.refundDueAtomic))
        throw Error('No direct token refund ready');
      return {receiverId:q.tokenContract,methodName:'ft_transfer',deposit:'1',gas:'30000000000000',
        args:{receiver_id:q.payer,amount:q.refundDueAtomic,memo:`nfa-refund:${id}`}};
    });
  }
  async confirmRefund(id,hash){
    return this.#locked(async j=>{
      const q=j.quotes[id];if(!q||q.kind!=='token'||q.state!=='REFUND_DUE')throw Error('No direct token refund ready');
      if(j.receipts[hash])throw Error('FT receipt already claimed');
      const tx=await this.sdk.transaction(hash,this.merchantAccountId);
      verifyFtReceipt(tx,{hash,tokenContract:q.tokenContract,from:this.merchantAccountId,to:q.payer,
        amount:q.refundDueAtomic,memo:`nfa-refund:${id}`});
      q.refundHash=hash;q.state='REFUNDED';j.receipts[hash]=id;return this.#public(q);
    });
  }
  async get(id){return this.#locked(j=>{const q=j.quotes[id];return q?this.#public(q):null})}
  #public(q){return {id:q.id,kind:q.kind,state:q.state,service:q.quote.service,tokenId:q.quote.tokenId,
    tokenContract:q.tokenContract,amountAtomic:q.amount,expiresAt:q.expiresAt,
    paymentHash:q.paymentHash||null,fundingHash:q.fundingHash||null,jobId:q.jobId||null,
    refundDueAtomic:q.refundDueAtomic||null}}
}
