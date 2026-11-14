#!/usr/bin/env node
// Sale, stale seller authority, memory recall, and preserved identity evidence.
import {readFile,writeFile} from 'node:fs/promises';
import {transactions,utils,KeyPair,keyStores,connect} from 'near-api-js';
import {NfaSdk} from '@nfa/sdk';
import {testnet,pause} from './testnet-lib.mjs';
import {OutlayerHttpsAsync,paymentKeyOwner,verifyRecallResult} from '../services/worker/outlayer-https-async.mjs';

const phase=process.argv[2];
if(!['propose','sell','regressions','recall','verify'].includes(phase))throw Error('Use propose, sell, regressions, recall or verify');
const ctx=await testnet('deployments/async-research-handover.json');
const registry=await ctx.signer('t006-registry'),seller=await ctx.signer('t006-alice'),
  buyer=await ctx.signer('t008-bob'),guardian=await ctx.signer('t004-operator'),
  customer=await ctx.signer('studio-funder');
const sdk=new NfaSdk({registryAccountId:registry.id,rpcUrl:ctx.rpcUrl}),tokenId='nfa-2';
const restricted=JSON.parse(await readFile('deployments/guardian-nfa-2.key.json'));
if(restricted.account_id!==guardian.id||restricted.receiver_id!==`nfa-2.${registry.id}`||
  JSON.stringify(restricted.method_names)!==JSON.stringify(['propose_upgrade','cancel_upgrade','emergency_upgrade']))
  throw Error('Restricted guardian key changed');
const store=new keyStores.InMemoryKeyStore();await store.setKey('testnet',guardian.id,
  KeyPair.fromString(restricted.secret_key));
const node=await connect({networkId:'testnet',nodeUrl:ctx.rpcUrl,deps:{keyStore:store}});
const limitedGuardian={id:guardian.id,account:await node.account(guardian.id)};
const first=JSON.parse(await readFile('docs/evidence/paid-async-research-seller.json'));
if(first.owner!==seller.id||!first.outputHash||first.tokenId!==tokenId)throw Error('Finalized seller Research evidence required');
const before=await sdk.get(tokenId),agent=await sdk.getAgentState(tokenId),vault=before.vaultAccountId;
const vaultCode=await readFile('releases/nfa-vault-payment-key-5a37a47242d4d389.wasm');
const vaultHash='5a37a47242d4d38994c7849d11a227146e2816a1e09420336892c12c7a5050ce';
const hash=async()=>Buffer.from(utils.serialize.base_decode((await ctx.account(vault)).code_hash)).toString('hex');
if(await hash()!==vaultHash)throw Error('Pinned vault code changed');
const until=async(work,predicate)=>{for(let i=0;i<90;i++){try{const v=await work();if(predicate(v))return v}catch{}await pause(500)}
  throw Error('Final state not observed; inspect journal')};
const action=(label,who,receiver,method,args,deposit='0',failureExpected=false)=>ctx.send(label,who,receiver,
  [transactions.functionCall(method,Buffer.from(JSON.stringify(args)),250_000_000_000_000n,BigInt(deposit))],{failureExpected});
const send=(label,who,a,options)=>ctx.send(label,who,a.receiverId,[transactions.functionCall(
  a.methodName,a.args,BigInt(a.gas),BigInt(a.deposit))],options);
if(!ctx.evidence.before){
  if(before.ownerAccountId!==seller.id||agent.pending_op!=null||agent.lifecycle!=='Active')
    throw Error('Seller NFA not idle');
  ctx.evidence.before={identity:before,project:await sdk.getOutlayerProject(tokenId),
    vaultStatus:await sdk.view(vault,'status'),ledger:await sdk.view(registry.id,'registry_ledger'),
    income:await sdk.getAgentIncome(tokenId)};await ctx.save();
}
if(phase==='propose'){
  if(before.ownerAccountId!==seller.id)throw Error('Seller no longer owns NFA');
  await action('proposeSameVaultCode',limitedGuardian,vault,'propose_upgrade',{code_hash:vaultHash});
  await action('sellerApproveVaultUpgrade',seller,registry.id,'approve_vault_upgrade',
    {token_id:tokenId,code_hash:vaultHash},'1');
  console.log(JSON.stringify({phase,proposalBoundToEpoch:before.ownerEpoch}));process.exit(0);
}
if(phase==='sell'){
  if(!ctx.evidence.steps.sellerApproveVaultUpgrade?.outcome)throw Error('Seller approval regression setup required');
  if(before.ownerAccountId===seller.id){
    await send('listResearchNfa',seller,sdk.listForSale(tokenId,'1000000000000000000000',
      Number(BigInt(Date.now()+3600000)*1000000n)));
    const listing=(await until(()=>sdk.get(tokenId),n=>!!n.listing)).listing;
    await send('buyResearchNfa',buyer,sdk.buy(tokenId,listing.nonce,listing.price));
  }
  const after=await until(()=>sdk.get(tokenId),n=>n.ownerAccountId===buyer.id);
  if(after.ownerEpoch!==ctx.evidence.before.identity.ownerEpoch+1||
    after.vaultAccountId!==vault||after.foreignWallet.address!==ctx.evidence.before.identity.foreignWallet.address)
    throw Error('NFT sale changed persistent NFA identity');
  console.log(JSON.stringify({phase,owner:after.ownerAccountId,epoch:after.ownerEpoch,vault}));process.exit(0);
}
if(before.ownerAccountId!==buyer.id)throw Error('Buyer does not own NFA');
if(phase==='regressions'){
  const payoutBefore=await sdk.view(registry.id,'payout',{seller:customer.id});
  const ledgerBefore=await sdk.view(registry.id,'registry_ledger');
  // A previously failed job cannot be released twice, even across a registry upgrade.
  const old=JSON.parse(await readFile('deployments/m06-reviewed.json'));
  if(old.smoke?.result?.job?.status!=='FAILED')throw Error('Prior failed job receipt missing');
  await action('failedJobSecondReleaseDenied',customer,registry.id,'release_service_job',
    {token_id:tokenId,id:old.smoke.id},'0',true);
  if(JSON.stringify(await sdk.view(registry.id,'payout',{seller:customer.id}))!==JSON.stringify(payoutBefore)||
    JSON.stringify(await sdk.view(registry.id,'registry_ledger'))!==JSON.stringify(ledgerBefore))
    throw Error('Failed job replay changed balances');
  const stale=await ctx.send('staleSellerVaultUpgradeDenied',limitedGuardian,vault,
    [transactions.functionCall('emergency_upgrade',Buffer.from(JSON.stringify({code:vaultCode.toString('base64')})),
      300_000_000_000_000n,0n)]);
  if(stale.value!==false||await hash()!==vaultHash)throw Error('Old seller approved vault upgrade');
  await action('oldOwnerUpgradeApprovalDenied',seller,registry.id,'approve_vault_upgrade',
    {token_id:tokenId,code_hash:vaultHash},'1',true);
  await action('cancelStaleVaultProposal',limitedGuardian,vault,'cancel_upgrade',{});
  if((await sdk.view(vault,'status')).upgrade_proposal!==null)throw Error('Vault proposal was not cleared');
  console.log(JSON.stringify({phase,refundReplayDenied:true,staleOwnerUpgradeDenied:true}));process.exit(0);
}
if(phase==='recall'){
  await send('sellerRecallDenied',seller,sdk.recallOwnerMemory(tokenId,first.jobId,
    '10000000000000000000000'),{failureExpected:true});
  const setup=await sdk.view(registry.id,'payment_key_setup',{token_id:tokenId});
  const pkg=JSON.parse(await readFile('.data/outlayer-payment-key-nfa-2.private.json'));
  if(paymentKeyOwner(pkg.apiKey)!==vault||pkg.nonce!==setup.nonce)throw Error('Vault Payment Key changed');
  const project=await sdk.getOutlayerProject(tokenId),client=new OutlayerHttpsAsync({paymentKey:pkg.apiKey,
    vaultId:vault,projectId:project.project_id,versionKey:project.version_key});
  const journal='.data/buyer-research-recall.private.json';
  let record;try{record=JSON.parse(await readFile(journal))}catch(error){if(error.code!=='ENOENT')throw error}
  if(!record){
    await writeFile(journal,JSON.stringify({phase:'submission_unknown',jobId:first.jobId})+'\n',{flag:'wx',mode:0o600});
    const admission=await client.submitRecall({jobId:first.jobId,service:'research',expectedHash:first.outputHash});
    record={phase:'admitted',callId:admission.callId,jobId:first.jobId};
    await writeFile(journal,JSON.stringify(record,null,2)+'\n',{mode:0o600});
  }
  if(!record.callId)throw Error('Recall admission unknown; do not resubmit');
  const result=await client.poll(record.callId);
  if(result.status==='pending'){console.log(JSON.stringify({phase:'pending',callId:record.callId}));process.exit(0)}
  const verified=verifyRecallResult(result,{jobId:first.jobId,expectedHash:first.outputHash});
  record={...record,phase:'verified',...verified};
  await writeFile(journal,JSON.stringify(record,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({phase:'verified',jobId:first.jobId,outputHash:first.outputHash,callId:record.callId}));
  process.exit(0);
}
if(phase==='verify'){
  const after=await sdk.get(tokenId),project=await sdk.getOutlayerProject(tokenId),
    status=await sdk.view(vault,'status'),ledger=await sdk.view(registry.id,'registry_ledger');
  const recall=JSON.parse(await readFile('.data/buyer-research-recall.private.json'));
  if(recall.phase!=='verified'||after.ownerAccountId!==buyer.id||
    after.vaultAccountId!==ctx.evidence.before.identity.vaultAccountId||
    after.foreignWallet.address!==ctx.evidence.before.identity.foreignWallet.address||
    project.project_uuid!==ctx.evidence.before.project.project_uuid||
    status.controller!==ctx.evidence.before.vaultStatus.controller||
    BigInt(ledger.liabilities)<0n)throw Error('Handover preservation or recall failed');
  const evidence={checkedAt:new Date().toISOString(),network:'NEAR testnet',tokenId,
    seller:seller.id,buyer:buyer.id,oldEpoch:ctx.evidence.before.identity.ownerEpoch,newEpoch:after.ownerEpoch,
    vault,evmAddress:after.foreignWallet.address,projectUuid:project.project_uuid,
    firstResearchJobId:first.jobId,firstResearchOutputHash:first.outputHash,
    buyerRecallCallId:recall.callId,buyerRecallOutputHash:recall.outputHash,
    refundReplayDenied:true,staleSellerUpgradeDenied:true,sellerRecallDenied:true,
    transactions:Object.fromEntries(Object.entries(ctx.evidence.steps).map(([k,v])=>[k,{hash:v.hash,failed:v.outcome?.failed}]))};
  await writeFile('docs/evidence/async-research-handover.json',JSON.stringify(evidence,null,2)+'\n');
  console.log(JSON.stringify({phase:'verified',seller:seller.id,buyer:buyer.id,
    ownerEpoch:after.ownerEpoch,buyerRecallOutputHash:recall.outputHash}));
}
