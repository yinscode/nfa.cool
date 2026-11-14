#!/usr/bin/env node
// Live direct NEP-141 checkout acceptance. Private keys and the resumable journal stay in deployments/.
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {transactions,utils} from 'near-api-js';
import {NfaSdk} from '@nfa/sdk';
import {testnet,pause} from './testnet-lib.mjs';
import {quoteService,prepareServiceStart} from '../services/api/service-runtime.mjs';
import {PaymentCheckout} from '../services/api/payment-checkout.mjs';

const token='3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af';
const registryHash='b733b54b7ea955c6f95042f3ecbe27ad2391dbaa83409416d2dc9cdc790295b4';
const keyPath='deployments/checkout-merchant.key.json';
const mode=process.argv[2];
if(!['setup','accept'].includes(mode))throw Error('Use setup or accept');
await mkdir('deployments',{recursive:true,mode:0o700});
try{await readFile(keyPath)}catch(e){
  if(e.code!=='ENOENT')throw e;
  const {publicKey,privateKey}=generateKeyPairSync('ed25519');
  const pub=publicKey.export({format:'der',type:'spki'}).subarray(-32);
  await writeFile(keyPath,JSON.stringify({network:'testnet',account_id:pub.toString('hex'),
    public_key:'ed25519:'+utils.serialize.base_encode(pub),
    private_key_pkcs8_pem:privateKey.export({format:'pem',type:'pkcs8'})}),{flag:'wx',mode:0o600});
}
const ctx=await testnet('deployments/ft-checkout-acceptance.json');
const funder=await ctx.signer('studio-funder'),payer=await ctx.signer('t008-bob'),
  merchant=await ctx.signer('checkout-merchant'),owner=await ctx.signer('t006-alice'),
  registry=await ctx.signer('t006-registry');
const sdk=new NfaSdk({registryAccountId:registry.id,rpcUrl:ctx.rpcUrl});
const codeHash=Buffer.from(utils.serialize.base_decode((await ctx.account(registry.id)).code_hash)).toString('hex');
if(codeHash!==registryHash)throw Error('Unexpected registry code');
const metadata=await sdk.view(token,'ft_metadata');
assert.equal(metadata.symbol,'USDC');assert.equal(metadata.decimals,6);
const min=BigInt((await sdk.view(token,'storage_balance_bounds')).min);
const registered=id=>sdk.view(token,'storage_balance_of',{account_id:id});
const balance=id=>sdk.view(token,'ft_balance_of',{account_id:id});
const action=(label,person,receiver,method,args,deposit='1',gas=30_000_000_000_000n)=>
  ctx.send(label,person,receiver,[transactions.functionCall(method,args,gas,BigInt(deposit))]);
const sendAction=(label,person,a)=>action(label,person,a.receiverId,a.methodName,a.args,a.deposit,BigInt(a.gas));
const waitFor=async(work,check)=>{for(let i=0;i<100;i++){
  try{const value=await work();if(check(value))return value}catch{}await pause(500)
}throw Error('Expected final state unavailable; inspect private journal before retry')};

if(mode==='setup'){
  // An implicit account is created by its first NEAR transfer. Keep its private key local.
  let merchantAccount;try{merchantAccount=await ctx.account(merchant.id)}catch{}
  if(!merchantAccount)await ctx.send('fundCheckoutMerchant',funder,merchant.id,
    [transactions.transfer(8n*10n**23n)]);
  for(const [label,id] of [['merchant',merchant.id],['payer',payer.id]]){
    if(!await registered(id))await action('registerUSDC-'+label,funder,token,'storage_deposit',
      {account_id:id,registration_only:true},min.toString());
    assert.ok(await registered(id),`${label} USDC registration failed`);
  }
  const setup={checkedAt:new Date().toISOString(),network:'NEAR testnet',token,
    tokenSymbol:metadata.symbol,tokenDecimals:metadata.decimals,merchant:merchant.id,payer:payer.id,
    merchantNear:(await ctx.account(merchant.id)).amount,payerUSDC:await balance(payer.id),
    storageRegistrationYocto:min.toString(),
    transactions:Object.fromEntries(['fundCheckoutMerchant','registerUSDC-merchant','registerUSDC-payer']
      .map(name=>[name,ctx.evidence.steps[name]?.hash||null])),
    scope:'Merchant funded and merchant/payer registered for Circle testnet USDC. Payment acceptance pending faucet USDC.'};
  await writeFile('docs/evidence/ft-checkout-testnet-preflight.json',JSON.stringify(setup,null,2)+'\n');
  console.log(JSON.stringify(setup,null,2));
  process.exit(0);
}

assert.ok(await registered(merchant.id));assert.ok(await registered(payer.id));
const currentPayerBalance=BigInt(await balance(payer.id));
if(currentPayerBalance===0n)throw Error(`Payer ${payer.id} has no testnet USDC; request it from Circle faucet`);
if(!ctx.evidence.payerBalanceBeforeAtomic){
  ctx.evidence.payerBalanceBeforeAtomic=currentPayerBalance.toString();await ctx.save();
}
const payerBefore=BigInt(ctx.evidence.payerBalanceBeforeAtomic);
const target='nfa-2',state=await sdk.get(target),policy=await sdk.getServicePolicy(target,'scout');
if(state.ownerAccountId!==owner.id||state.lifecycle!=='ACTIVE'||!policy?.enabled)
  throw Error('Target owner or Scout policy changed');
const local={limits:policy.limits,marginYocto:policy.min_margin,
  maxDepositYocto:policy.max_deposit};
const checkout=new PaymentCheckout({sdk,directory:'deployments/ft-checkout-ledger',
  merchantAccountId:merchant.id,assets:{[token]:{atomicPerNear:'3000000'}}});
const input={question:'How does an NFA keep its vault after a sale?',sources:[{
  title:'NFA vault',url:'https://example.org/nfa-vault',
  text:'The same vault account remains attached to the NFA after its NFT is sold. The buyer becomes its new owner.'}]};

async function runCase(label,{cancel}){
  let id=ctx.evidence[`${label}CheckoutId`];
  if(!id){
    const quote=await quoteService({sdk,tokenId:target,service:'scout',body:{input},policy:{scout:local}});
    const created=await checkout.tokenQuote({quote,tokenContract:token,payer:payer.id});
    id=created.id;ctx.evidence[`${label}CheckoutId`]=id;await ctx.save();
  }
  const q=await checkout.get(id);
  if(!q)throw Error('Checkout journal missing');
  const paymentAction={receiverId:token,methodName:'ft_transfer',deposit:'1',gas:'30000000000000',
    args:{receiver_id:merchant.id,amount:q.amountAtomic,memo:`nfa-checkout:${id}`}};
  const paid=await sendAction(`payUSDC-${label}`,payer,paymentAction);
  const payment=await checkout.confirmToken(id,paid.hash);
  assert.ok(['PAYMENT_CONFIRMED','FUNDED','COMPLETE','REFUND_DUE','REFUNDED'].includes(payment.state));
  const funding=payment.fundingHash?null:await checkout.fundingAction(id);
  const funded=funding?await sendAction(`fundJob-${label}`,merchant,funding.unsignedAction):
    {hash:payment.fundingHash};
  const confirmed=await checkout.confirmFunding(id,funded.hash).catch(async e=>{
    const recorded=await checkout.get(id);
    if(recorded?.fundingHash===funded.hash)return recorded;
    throw e;
  });
  assert.ok(Number.isSafeInteger(confirmed.jobId));
  if(cancel){
    await action(`cancelJob-${label}`,owner,registry.id,'cancel_unstarted_job',
      {token_id:target,id:confirmed.jobId},'1',250_000_000_000_000n);
    await waitFor(()=>sdk.getServiceJob(target,confirmed.jobId),x=>x?.job?.status==='FAILED');
    const due=await checkout.reconcile(id);
    assert.ok(['REFUND_DUE','REFUNDED'].includes(due.state));
    assert.equal(due.refundDueAtomic,q.amountAtomic);
    if(due.state==='REFUND_DUE'){
      const sent=await sendAction(`refundUSDC-${label}`,merchant,await checkout.refundAction(id));
      assert.equal((await checkout.confirmRefund(id,sent.hash)).state,'REFUNDED');
    }
  }else{
    const record=await sdk.getServiceJob(target,confirmed.jobId);
    if(record?.job?.status!=='FINALIZED'){
      const start=await prepareServiceStart({sdk,tokenId:target,service:'scout',
        jobId:confirmed.jobId,inputData:JSON.stringify(input)});
      await sendAction(`startJob-${label}`,merchant,start.unsignedAction);
      await waitFor(()=>sdk.getServiceJob(target,confirmed.jobId),x=>x?.job?.status==='FINALIZED');
    }
    assert.equal((await checkout.reconcile(id)).state,'COMPLETE');
  }
  return {checkoutId:id,jobId:confirmed.jobId,state:(await checkout.get(id)).state,
    amountAtomic:q.amountAtomic,paymentHash:paid.hash,fundingHash:funded.hash,
    ...(cancel?{cancelHash:ctx.evidence.steps[`cancelJob-${label}`].hash,
      refundHash:ctx.evidence.steps[`refundUSDC-${label}`].hash}:
      {startHash:ctx.evidence.steps[`startJob-${label}`].hash})};
}

const completed=await runCase('completed',{cancel:false});
const refunded=await runCase('refunded',{cancel:true});
const completedJob=await sdk.getServiceJob(target,completed.jobId),
  targetProject=await sdk.getOutlayerProject(target);
if(completedJob?.job?.status!=='FINALIZED'||!completedJob.job.output_hash||
  completedJob.service_id!=='scout'||targetProject?.state!=='READY')
  throw Error('Completed Scout or stable Project identity not verified');
const cancelledJob=await sdk.getServiceJob(target,refunded.jobId);
if(cancelledJob?.job?.status!=='FAILED'||cancelledJob.service_id!=='scout')
  throw Error('Cancelled Scout status not verified');
const merchantRefundCredit=cancelledJob?.refund_credit;
if(!merchantRefundCredit||BigInt(merchantRefundCredit)<=0n)
  throw Error('Cancelled job has no native NEAR refund credit');
const merchantPayout=await sdk.view(registry.id,'payout',{seller:merchant.id});
if(BigInt(merchantPayout.available)>0n){
  assert.equal(merchantPayout.available,merchantRefundCredit);
  await action('withdrawMerchantRefund',merchant,registry.id,'withdraw_proceeds',
    {amount:merchantPayout.available},'1',250_000_000_000_000n);
}
await waitFor(()=>sdk.view(registry.id,'payout',{seller:merchant.id}),
  p=>p.available==='0'&&p.pending==null);
const payerAfter=BigInt(await balance(payer.id));
assert.equal(payerBefore-payerAfter,BigInt(completed.amountAtomic));
const ledger=await sdk.view(registry.id,'registry_ledger');
const publicEvidence={checkedAt:new Date().toISOString(),network:'NEAR testnet',token,
  tokenSymbol:metadata.symbol,tokenDecimals:metadata.decimals,merchant:merchant.id,payer:payer.id,
  registry:registry.id,registryHash,rateAtomicPerNear:'3000000',
  setupTransactions:Object.fromEntries(['fundCheckoutMerchant','registerUSDC-merchant','registerUSDC-payer']
    .map(name=>[name,ctx.evidence.steps[name]?.hash||null])),
  completed:{...completed,outputHash:completedJob.job.output_hash,projectUuid:targetProject.project_uuid},
  refunded:{...refunded,refundCreditYocto:cancelledJob.refund_credit},
  payerBalanceBeforeAtomic:payerBefore.toString(),
  payerBalanceAfterAtomic:payerAfter.toString(),merchantBalanceAtomic:await balance(merchant.id),
  merchantNativeRefundCreditYocto:merchantRefundCredit,
  merchantNativeRefundClaimHash:ctx.evidence.steps.withdrawMerchantRefund?.hash||null,
  registryLiabilitiesYocto:ledger.liabilities,
  scope:'Circle testnet USDC direct FT checkout through the operator acceptance runner; one finalized Scout and one owner-cancelled Scout with full USDC refund. The REST API was not publicly hosted. Test rate is illustrative.'};
await writeFile('docs/evidence/ft-checkout-testnet-acceptance.json',JSON.stringify(publicEvidence,null,2)+'\n');
console.log(JSON.stringify({completed,refunded,payerNetUSDCAtomic:(payerBefore-payerAfter).toString()},null,2));
