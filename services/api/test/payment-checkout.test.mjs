import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PaymentCheckout,verifyIntentsDestination} from '../payment-checkout.mjs';

const encoded=value=>Buffer.from(JSON.stringify(value)).toString('base64');
const ftTx=({hash,from,contract,to,amount,memo})=>({final_execution_status:'FINAL',status:{SuccessValue:''},
  transaction:{hash,signer_id:from,receiver_id:contract,actions:[{FunctionCall:{method_name:'ft_transfer',
    deposit:'1',args:encoded({receiver_id:to,amount,memo})}}]}});
const serviceQuote=(registry,fee='130000000000000000000000')=>({service:'scout',tokenId:'nfa-1',
  feeYocto:fee,deadlineNs:Number(BigInt(Date.now()+900_000)*1_000_000n),inputData:'{"question":"hello"}',inputHash:'sha256:'+'a'.repeat(64),
  unsignedAction:{receiverId:registry,methodName:'request_reviewed_service_job',deposit:fee,
    args:{token_id:'nfa-1',service_id:'scout',input_hash:'sha256:'+'a'.repeat(64)}}});

test('token receipt funds one job and refunds the exact on-chain fraction',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'nfa-checkout-'));
  const registry='registry.testnet',merchant='a'.repeat(64),
    contract='3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af',payer='buyer.testnet';
  const txs=new Map(),job={job:{requester:merchant,status:'REQUESTED'},service_id:'scout'};
  const sdk={registryAccountId:registry,transaction:async hash=>txs.get(hash),getServiceJob:async()=>job,
    view:async()=>({total:'1'})};
  const checkout=new PaymentCheckout({sdk,directory:dir,merchantAccountId:merchant,
    assets:{[contract]:{atomicPerNear:'3000000'}},merchantAvailable:async()=>10n**24n});
  try{
    const quote=serviceQuote(registry);
    const payment=await checkout.tokenQuote({quote,tokenContract:contract,payer});
    assert.equal(payment.amountAtomic,'390000');
    assert.equal(payment.paymentAction.args.memo,`nfa-checkout:${payment.id}`);
    txs.set('pay',ftTx({hash:'pay',from:payer,contract,to:merchant,amount:'390000',memo:`nfa-checkout:${payment.id}`}));
    assert.equal((await checkout.confirmToken(payment.id,'pay')).state,'PAYMENT_CONFIRMED');
    assert.equal((await checkout.fundingAction(payment.id)).unsignedAction.deposit,quote.feeYocto);
    txs.set('fund',{final_execution_status:'FINAL',status:{SuccessValue:''},transaction:{hash:'fund',
      signer_id:merchant,receiver_id:registry,actions:[{FunctionCall:{method_name:'request_reviewed_service_job',
        deposit:quote.feeYocto,args:encoded(quote.unsignedAction.args)}}]},receipts_outcome:[{outcome:{executor_id:registry,
          logs:[`EVENT_JSON:${JSON.stringify({event:'service_job_requested',data:[{token_id:'nfa-1',id:7,
            input_hash:quote.inputHash}]})}`]}}]});
    assert.equal((await checkout.confirmFunding(payment.id,'fund')).jobId,7);
    assert.equal((await checkout.confirmFunding(payment.id,'fund')).state,'FUNDED');
    job.job.status='FAILED';job.refund_credit='65000000000000000000000';
    assert.equal((await checkout.reconcile(payment.id)).refundDueAtomic,'195000');
    const action=await checkout.refundAction(payment.id);
    assert.equal(action.args.amount,'195000');
    txs.set('refund',ftTx({hash:'refund',from:merchant,contract,to:payer,amount:'195000',memo:`nfa-refund:${payment.id}`}));
    assert.equal((await checkout.confirmRefund(payment.id,'refund')).state,'REFUNDED');
    const reopened=new PaymentCheckout({sdk,directory:dir,merchantAccountId:merchant,assets:{[contract]:{atomicPerNear:'3000000'}}});
    assert.equal((await reopened.get(payment.id)).state,'REFUNDED');
  }finally{await rm(dir,{recursive:true,force:true})}
});

test('token checkout rejects altered receipt and expired payment becomes refundable',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'nfa-checkout-'));
  let now=1_000_000;const registry='registry.testnet',merchant='merchant.testnet',contract='usdc.testnet';
  let tx;const sdk={registryAccountId:registry,transaction:async()=>tx,view:async()=>({total:'1'})};
  const checkout=new PaymentCheckout({sdk,directory:dir,merchantAccountId:merchant,
    assets:{[contract]:{atomicPerNear:'3000000'}},merchantAvailable:async()=>10n**24n,now:()=>now});
  try{
    const payment=await checkout.tokenQuote({quote:serviceQuote(registry),tokenContract:contract,payer:'buyer.testnet'});
    tx=ftTx({hash:'pay',from:'buyer.testnet',contract,to:merchant,amount:'1',memo:`nfa-checkout:${payment.id}`});
    await assert.rejects(()=>checkout.confirmToken(payment.id,'pay'),/does not match/);
    now+=301_000;
    tx=ftTx({hash:'pay',from:'buyer.testnet',contract,to:merchant,amount:payment.amountAtomic,memo:`nfa-checkout:${payment.id}`});
    assert.equal((await checkout.confirmToken(payment.id,'pay')).state,'LATE_PAYMENT');
    assert.equal((await checkout.refundAction(payment.id)).args.amount,payment.amountAtomic);
    await assert.rejects(()=>checkout.fundingAction(payment.id),/not ready/);
  }finally{await rm(dir,{recursive:true,force:true})}
});

test('Intents quote requires mainnet and verified destination token delivery',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'nfa-checkout-'));
  const registry='registry.near',merchant='merchant.near',contract='usdc.near';
  let requested,status;
  const intentsClient={quote:async body=>{requested=body;return {quote:{depositAddress:'0xdeposit'}}},
    status:async()=>status};
  const sdk={registryAccountId:registry,view:async()=>({total:'1'})};
  const checkout=new PaymentCheckout({sdk,directory:dir,merchantAccountId:merchant,
    assets:{[contract]:{atomicPerNear:'3000000',intentsAssetId:`nep141:${contract}`}},
    intentsClient,verifyIntentsDelivery:async()=>({final:true,hash:'destination-tx'}),
    merchantAvailable:async()=>10n**24n});
  try{
    const q=serviceQuote(registry);
    const unverified=new PaymentCheckout({sdk,directory:dir,merchantAccountId:merchant,
      assets:{[contract]:{atomicPerNear:'3000000',intentsAssetId:`nep141:${contract}`}},
      intentsClient,merchantAvailable:async()=>10n**24n});
    await assert.rejects(()=>unverified.intentsQuote({quote:q,originAsset:'nep141:wrap.near',
      refundTo:'buyer.near'}),/destination verifier/);
    const payment=await checkout.intentsQuote({quote:q,originAsset:'nep141:wrap.near',refundTo:'buyer.near'});
    assert.equal(requested.swapType,'EXACT_OUTPUT');
    assert.equal(requested.recipient,merchant);
    status={status:'SUCCESS',quoteResponse:{quoteRequest:requested,quote:{depositAddress:'0xdeposit'}},
      swapDetails:{amountOut:payment.amountAtomic}};
    assert.equal((await checkout.confirmIntents(payment.id)).state,'PAYMENT_CONFIRMED');
    assert.equal((await checkout.fundingAction(payment.id)).unsignedAction.receiverId,registry);
  }finally{await rm(dir,{recursive:true,force:true})}
});

test('Intents destination verifier requires a finalized matching FT event',async()=>{
  let credit='400000';
  const sdk={transaction:async(hash,sender)=>({final_execution_status:'FINAL',status:{SuccessValue:''},
    transaction:{hash,signer_id:sender},receipts_outcome:[{outcome:{executor_id:'usdc.near',logs:[
      `EVENT_JSON:${JSON.stringify({standard:'nep141',event:'ft_transfer',data:[{old_owner_id:'solver.near',
        new_owner_id:'merchant.near',amount:credit}]})}`]}}]})};
  const args={sdk,status:{swapDetails:{destinationChainTxHashes:[{hash:'dest-tx'}]}},
    tokenContract:'usdc.near',merchantAccountId:'merchant.near',amount:'390000',senders:['solver.near']};
  assert.deepEqual(await verifyIntentsDestination(args),{final:true,hash:'dest-tx'});
  credit='1000';
  await assert.rejects(()=>verifyIntentsDestination(args),/insufficient/);
});

test('checkout refuses unregistered merchant and overcommitted NEAR reserve',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'nfa-checkout-'));
  let registered=false,available=10n**24n;
  const sdk={registryAccountId:'registry.testnet',view:async()=>registered?{total:'1'}:null};
  const checkout=new PaymentCheckout({sdk,directory:dir,merchantAccountId:'merchant.testnet',
    assets:{'usdc.testnet':{atomicPerNear:'3000000'}},merchantAvailable:async()=>available});
  const create=()=>checkout.tokenQuote({quote:serviceQuote('registry.testnet'),
    tokenContract:'usdc.testnet',payer:'buyer.testnet'});
  try{
    await assert.rejects(create(),/not registered/);
    registered=true;available=129000000000000000000000n;
    await assert.rejects(create(),/reserve cannot cover/);
    available=130000000000000000000000n;
    await create();
    await assert.rejects(create(),/reserve cannot cover/);
  }finally{await rm(dir,{recursive:true,force:true})}
});
