#!/usr/bin/env node
import {readFile,writeFile} from 'node:fs/promises';
import {transactions} from 'near-api-js';
import {NfaSdk} from '@nfa/sdk';
import {testnet,pause} from './testnet-lib.mjs';
import {EvmJournal} from '../services/worker/evm-journal.mjs';
import {NearIntentWallet} from '../services/worker/near-intent.mjs';
import {settleEvmTick} from '../services/worker/evm-settler.mjs';
import {utils} from 'near-api-js';

const phase=process.argv[2]||'inspect',tokenId='nfa-2';
if(!['inspect','request-first','settle-first','handover','settle-buyer','verify'].includes(phase))throw Error('Unknown M02 phase');
const ctx=await testnet('deployments/m02-public.json'),registry=await ctx.signer('t006-registry'),
  seller=await ctx.signer('t008-bob'),buyer=await ctx.signer('t006-alice'),reporter=await ctx.signer('t004-operator');
const sdk=new NfaSdk({registryAccountId:registry.id,rpcUrl:ctx.rpcUrl}),evmRpc=process.env.EVM_RPC_URL||'https://ethereum-sepolia-rpc.publicnode.com';
const action=(label,person,a,options)=>ctx.send(label,person,a.receiverId,[transactions.functionCall(a.methodName,a.args,BigInt(a.gas),BigInt(a.deposit))],options);
const until=async(work,test)=>{for(let i=0;i<80;i++){const x=await work();if(test(x))return x;await pause(500)}throw Error('Finalized state is still pending; rerun this phase')};
const identity=await sdk.get(tokenId);
if(!ctx.evidence.initial){
  const preflight=JSON.parse(await readFile('docs/evidence/m01-preflight.json','utf8'));
  if(!preflight.ready||Date.now()-Date.parse(preflight.checkedAt)>30*60_000||identity.ownerAccountId!==seller.id)throw Error('Fresh funded M01 preflight/current seller required');
  const vault=await sdk.view(identity.vaultAccountId,'status');
  if(vault.reporter!==reporter.id||vault.pending!=null)throw Error('Unexpected reporter or pending vault');
  ctx.evidence.initial={tokenId,vault:identity.vaultAccountId,address:identity.foreignWallet.address,epoch:identity.ownerEpoch,
    seller:seller.id,buyer:buyer.id,recipient:identity.foreignWallet.address,recipientMode:'self-transfer; ETH remains in the approved NFA address',startingNonce:vault.next_evm_nonce,
    projectUuid:(await sdk.getOutlayerProject(tokenId)).project_uuid};await ctx.save();
}
const initial=ctx.evidence.initial;
if(initial.recipient!==initial.address)throw Error('This acceptance runner permits only self-transfers to the user-approved NFA address');
const request=async(label,person)=>{
  const current=await sdk.get(tokenId);if(current.ownerAccountId!==person.id)throw Error('Unexpected current owner');
  const policy=await sdk.view(registry.id,'transaction_policy',{token_id:tokenId});
  if(policy&&(!policy.evm_enabled||!policy.evm_recipients.includes(initial.recipient.toLowerCase())||BigInt(policy.max_evm)<1000000000000n||policy.max_fee<10000000000))
    throw Error('Existing owner policy does not permit the bounded demo transfer; explicit policy review required');
  const sent=await action(label,person,sdk.requestEvmTransfer(tokenId,initial.recipient,'1000000000000',1000000000,10000000000));
  if(!Number.isSafeInteger(sent.value))throw Error('No assigned EVM operation ID');return sent.value;
};
async function settle(id){
  if(!Number.isSafeInteger(id))throw Error('Request phase not recorded');
  const journal=new EvmJournal('.data/m02/evm');
  const wallet=new NearIntentWallet({directory:'.data/m02/reporter',accountId:reporter.id,rpc:ctx.rpc,
    sign:async a=>{const [hash,signed]=await reporter.account.signTransaction(a.receiverId,[transactions.functionCall(a.methodName,a.args,BigInt(a.gas),0n)]);
      return {hash:utils.serialize.base_encode(hash),signedTxBase64:Buffer.from(signed.encode()).toString('base64')}}});
  for(let tick=0;tick<240;tick++){
    try{
    const current=await sdk.getAgentState(tokenId);
    if(current.pending_op==null){const op=await sdk.view(registry.id,'evm_operation',{token_id:tokenId,id});
      if(op.success!==true||!op.tx_hash)throw Error('Operation is not a successful reconciled transfer');return op}
    if(current.pending_op!==id)throw Error('Another operation is pending; inspect before continuing');
    const result=await settleEvmTick({sdk,journal,wallet,reporterId:reporter.id,tokenId,rpcUrl:evmRpc,rpcTimeoutMs:25000});
    console.log(JSON.stringify({id,...result}));await pause(5000);
    }catch(error){
      if(!/Timeout|timed out|fetch failed|aborted due to timeout|NEAR RPC HTTP (429|5\d\d)/i.test(String(error)))throw error;
      console.log(JSON.stringify({id,state:'UNCERTAIN',reason:'temporary_rpc_read_failure',journalRetained:true}));await pause(5000);
    }
  }
  throw Error('Finality/reconciliation still pending; same journal retained for the next run');
}
if(phase==='request-first'){
  if(!ctx.evidence.firstId){ctx.evidence.firstId=await request('firstRequest',seller);await ctx.save()}
  await action('pendingSaleDenied',seller,sdk.listForSale(tokenId,'1000000000000000000000',Number(BigInt(Date.now()+3600000)*1000000n)),{failureExpected:true});
  console.log(JSON.stringify({phase,operationId:ctx.evidence.firstId,pendingSaleRejected:true}));
}else if(phase==='settle-first'){
  ctx.evidence.first=await settle(ctx.evidence.firstId);await ctx.save();
}else if(phase==='handover'){
  if(!ctx.evidence.first?.success)throw Error('First transfer must reconcile before sale');
  let current=await sdk.get(tokenId);
  if(current.ownerAccountId===seller.id){
    if(!current.listing)await action('listAfterSettlement',seller,sdk.listForSale(tokenId,'1000000000000000000000',Number(BigInt(Date.now()+3600000)*1000000n)));
    current=await until(()=>sdk.get(tokenId),x=>!!x.listing);
    await action('buyNfa',buyer,sdk.buy(tokenId,current.listing.nonce,current.listing.price));
  }
  current=await until(()=>sdk.get(tokenId),x=>x.ownerAccountId===buyer.id);
  if(current.vaultAccountId!==initial.vault||current.foreignWallet.address!==initial.address||(await sdk.getOutlayerProject(tokenId)).project_uuid!==initial.projectUuid)throw Error('Handover changed agent identity');
  await action('oldSellerDenied',seller,sdk.requestEvmTransfer(tokenId,initial.recipient,'1000000000000',1000000000,10000000000),{failureExpected:true});
  if(!ctx.evidence.buyerId){ctx.evidence.buyerId=await request('buyerRequest',buyer);await ctx.save()}
  ctx.evidence.afterSale={owner:current.ownerAccountId,epoch:current.ownerEpoch,address:current.foreignWallet.address,vault:current.vaultAccountId};await ctx.save();
}else if(phase==='settle-buyer'){
  ctx.evidence.second=await settle(ctx.evidence.buyerId);await ctx.save();
}else if(phase==='verify'){
  if(!ctx.evidence.first?.success||!ctx.evidence.second?.success)throw Error('Both live transfers must settle');
  const current=await sdk.get(tokenId),vault=await sdk.view(initial.vault,'status');
  if(current.ownerAccountId!==buyer.id||current.foreignWallet.address!==initial.address||vault.next_evm_nonce!==initial.startingNonce+2||vault.pending!=null)throw Error('Final identity/nonce mismatch');
  const reporterTransactions={};
  for(const id of [ctx.evidence.firstId,ctx.evidence.buyerId])for(const stage of ['mark','report','reconcile']){
    const record=JSON.parse(await readFile(`.data/m02/reporter/${tokenId}-${id}-${stage}.json`,'utf8'));
    reporterTransactions[`${id}-${stage}`]={hash:record.hash,sender:record.accountId};
  }
  const journal=new EvmJournal('.data/m02/evm'),observations=[];
  for(const id of [ctx.evidence.firstId,ctx.evidence.buyerId]){
    const record=await journal.get(tokenId,id);if(record.state!=='CONFIRMED')throw Error('Finalized EVM journal required');
    observations.push({id,...record.observation});
  }
  const evidence={checkedAt:new Date().toISOString(),milestone:'M02',complete:true,mode:'real NEAR testnet and Sepolia',initial,
    afterSale:ctx.evidence.afterSale,first:ctx.evidence.first,second:ctx.evidence.second,
    reporterTransactions,observations,
    nearTransactions:Object.fromEntries(Object.entries(ctx.evidence.steps).map(([name,s])=>[name,{hash:s.hash,failed:s.outcome?.failed}])),
    checks:['pending sale rejected','first typed transfer finalized','NFT purchase finalized','same vault/address/Project','old seller rejected','buyer typed transfer finalized','nonce advanced twice','no pending authority']};
  await writeFile('docs/evidence/m02-handover.json',JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence,null,2));
}else console.log(JSON.stringify({phase,initial,currentOwner:identity.ownerAccountId,agent:await sdk.getAgentState(tokenId)}));
