#!/usr/bin/env node
// One capped testnet NEAR -> USDC.e swap for the OutLayer Payment Key probe.
import {writeFile} from 'node:fs/promises';
import {transactions} from 'near-api-js';
import {NfaSdk} from '@nfa/sdk';
import {testnet} from './testnet-lib.mjs';

const purpose=process.argv[2]||'operator';
if(!['operator','vault'].includes(purpose))throw Error('Use operator or vault');
const ctx=await testnet(purpose==='operator'?'deployments/outlayer-usdc-acquisition.json':
  'deployments/vault-usdc-acquisition.json');
const payer=await ctx.signer('studio-funder');
const sdk=new NfaSdk({registryAccountId:'nfagent-registry-0e9b2a.testnet',rpcUrl:ctx.rpcUrl});
const token='usdc.fakes.testnet',wrap='wrap.testnet',ref='ref-finance-101.testnet';
const poolId=54,nearIn=purpose==='operator'?300_000_000_000_000n:200_000_000_000_000n;
const minOut=purpose==='operator'?600_000n:400_000n,target=500_000n;
const label=name=>purpose==='operator'?name:`vault${name[0].toUpperCase()+name.slice(1)}`;
const call=(label,receiver,method,args,gas,deposit)=>ctx.send(label,payer,receiver,[
  transactions.functionCall(method,Buffer.from(JSON.stringify(args)),gas,deposit)]);
const tokenBalance=async()=>BigInt(await sdk.view(token,'ft_balance_of',{account_id:payer.id}));
const deposits=async()=>sdk.view(ref,'get_deposits',{account_id:payer.id});
const evidence=async(quote)=>{
  const balance=await tokenBalance();
  const row={checkedAt:new Date().toISOString(),network:'NEAR testnet',payer:payer.id,
    token,wrap,exchange:ref,poolId,inputYoctoNear:nearIn.toString(),
    minimumOutputMicrousd:minOut.toString(),quoteMicrousd:quote?.toString()??null,
    outputBalanceMicrousd:balance.toString(),transactions:Object.fromEntries(
      Object.entries(ctx.evidence.steps).map(([name,step])=>[name,step.hash]))};
  await writeFile(purpose==='operator'?'docs/evidence/outlayer-usdc-acquisition.json':
    'docs/evidence/vault-key-usdc-prepared.json',JSON.stringify(row,null,2)+'\n');
  return balance;
};

if(await sdk.view('outlayer.testnet','get_payment_token_contract',{})!==token)
  throw Error('OutLayer testnet payment token changed');
if((await tokenBalance())>=target){console.log(JSON.stringify({ready:true,balanceMicrousd:(await evidence()).toString()}));process.exit(0)}
const pool=await sdk.view(ref,'get_pool',{pool_id:poolId});
if(pool.pool_kind!=='SIMPLE_POOL'||JSON.stringify(pool.token_account_ids)!==JSON.stringify([token,wrap]))
  throw Error('Pinned Ref pool changed');
const quote=BigInt(await sdk.view(ref,'get_return',{pool_id:poolId,token_in:wrap,
  amount_in:nearIn.toString(),token_out:token}));
if(quote<minOut||quote>1_000_000n)throw Error(`Ref quote outside bounded test range: ${quote}`);
ctx.evidence.quote={at:new Date().toISOString(),nearIn:nearIn.toString(),usdcOut:quote.toString(),minOut:minOut.toString()};
await ctx.save();

if(!(await sdk.view(wrap,'storage_balance_of',{account_id:payer.id})))
  await call(label('registerWrappedNear'),wrap,'storage_deposit',{account_id:payer.id,registration_only:true},30_000_000_000_000n,1_250_000_000_000_000_000_000n);
if(!(await sdk.view(ref,'storage_balance_of',{account_id:payer.id})))
  await call(label('registerRefExchange'),ref,'storage_deposit',{account_id:payer.id,registration_only:false},30_000_000_000_000n,10_000_000_000_000_000_000_000n);
let held=BigInt(await sdk.view(wrap,'ft_balance_of',{account_id:payer.id}));
let deposited=await deposits();
if(BigInt(deposited[token]||0)<minOut&&BigInt(deposited[wrap]||0)<nearIn){
  if(held<nearIn)await call(label('wrapNear'),wrap,'near_deposit',{},30_000_000_000_000n,nearIn-held);
  held=BigInt(await sdk.view(wrap,'ft_balance_of',{account_id:payer.id}));
  if(held<nearIn)throw Error('Wrapped NEAR balance unavailable after deposit');
  await call(label('depositWrappedNearToRef'),wrap,'ft_transfer_call',
    {receiver_id:ref,amount:nearIn.toString(),msg:''},180_000_000_000_000n,1n);
}
deposited=await deposits();
if(BigInt(deposited[token]||0)<minOut){
  if(BigInt(deposited[wrap]||0)<nearIn)throw Error('Ref did not credit the wrapped NEAR deposit');
  const freshQuote=BigInt(await sdk.view(ref,'get_return',{pool_id:poolId,token_in:wrap,
    amount_in:nearIn.toString(),token_out:token}));
  if(freshQuote<minOut)throw Error('Ref quote fell below minimum output');
  await call(label('swapWrappedNearForUsdcE'),ref,'swap',{actions:[{pool_id:poolId,
    token_in:wrap,amount_in:nearIn.toString(),token_out:token,
    min_amount_out:minOut.toString()}]},150_000_000_000_000n,1n);
}
deposited=await deposits();
if((await tokenBalance())<target){
  const available=BigInt(deposited[token]||0);
  if(available<minOut)throw Error('Ref swap output did not reach the minimum');
  await call(label('withdrawUsdcEFromRef'),ref,'withdraw',
    {token_id:token,amount:available.toString(),unregister:false},100_000_000_000_000n,1n);
}
const balance=await evidence(quote);
if(balance<target)throw Error('USDC.e did not arrive in the payer account');
console.log(JSON.stringify({ready:true,payer:payer.id,token,balanceMicrousd:balance.toString(),quoteMicrousd:quote.toString()}));
