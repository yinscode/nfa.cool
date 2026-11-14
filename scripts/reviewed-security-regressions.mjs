#!/usr/bin/env node
// Two live testnet checks after the reviewed registry/vault rollout.
import {readFile,writeFile} from 'node:fs/promises';
import {transactions,utils} from 'near-api-js';
import {NfaSdk} from '@nfa/sdk';
import {testnet,pause} from './testnet-lib.mjs';
const ctx=await testnet('deployments/reviewed-regressions.json');
const registry=await ctx.signer('t006-registry'),guardian=await ctx.signer('t004-operator'),
  seller=await ctx.signer('t008-bob'),buyer=await ctx.signer('t006-alice'),customer=await ctx.signer('studio-funder');
const sdk=new NfaSdk({registryAccountId:registry.id,rpcUrl:ctx.rpcUrl});
const runtime=JSON.parse(await readFile('deployments/m06-reviewed.json','utf8'));
const preflight=JSON.parse(await readFile('docs/evidence/liability-migration-preflight.json','utf8'));
const release='200821c58802e52ac795fbd1a594a66d6f6de8703862019972b9ee93bc33c6e7';
const vaultCode=await readFile('releases/nfa-vault-reviewed-200821c58802e52a.wasm');
const token='nfa-1',before=preflight.agents[token],vault=before.vault;
const codeHash=async()=>Buffer.from(utils.serialize.base_decode((await ctx.account(vault)).code_hash)).toString('hex');
const action=(label,who,receiver,method,args,deposit='0',failureExpected=false)=>
  ctx.send(label,who,receiver,[transactions.functionCall(method,Buffer.from(JSON.stringify(args)),100_000_000_000_000n,BigInt(deposit))],{failureExpected});
if((await codeHash())!==release)throw Error('Reviewed vault is not deployed');
// A finalized failed job must not be released/refunded a second time.
const smoke=runtime.smoke;
if(!smoke?.id||smoke.result?.job?.status!=='FAILED')throw Error('Reviewed hosted smoke receipt is required');
const payoutBefore=await sdk.view(registry.id,'payout',{seller:customer.id}),ledgerBefore=await sdk.getPaidLedger();
await action('secondSmokeReleaseDenied',customer,registry.id,'release_service_job',{token_id:'nfa-2',id:smoke.id},'0',true);
const payoutAfter=await sdk.view(registry.id,'payout',{seller:customer.id}),ledgerAfter=await sdk.getPaidLedger();
if(JSON.stringify(payoutAfter)!==JSON.stringify(payoutBefore)||JSON.stringify(ledgerAfter)!==JSON.stringify(ledgerBefore))
  throw Error('Replay changed payout or escrow');
// A vault upgrade approved by a seller must not survive the sale.
if(before.owner!==seller.id)throw Error('nfa-1 seller is not the expected signer');
if((await sdk.getAgentState(token)).pending_op!=null)throw Error('nfa-1 is busy');
await action('proposeSameVaultCode',guardian,vault,'propose_upgrade',{code_hash:release});
await action('sellerApprovesUpgrade',seller,registry.id,'approve_vault_upgrade',{token_id:token,code_hash:release},'1');
if((await sdk.get(token)).ownerAccountId===seller.id){
  await action('listSecurityNfa',seller,registry.id,'list_agent',{token_id:token,price:'1000000000000000000000'},'1');
  let listing;for(let i=0;i<60;i++){listing=await sdk.view(registry.id,'listing',{token_id:token});if(listing)break;await pause(500)}
  if(!listing)throw Error('Listing not finalized');
  await action('buySecurityNfa',buyer,registry.id,'buy',{token_id:token,expected_nonce:listing.nonce},listing.price);
}
for(let i=0;i<60;i++){if((await sdk.get(token)).ownerAccountId===buyer.id)break;await pause(500)}
if((await sdk.get(token)).ownerAccountId!==buyer.id)throw Error('Sale not finalized');
const stale=await ctx.send('staleVaultUpgradeChecked',guardian,vault,
  [transactions.functionCall('emergency_upgrade',Buffer.from(JSON.stringify({code:vaultCode.toString('base64')})),300_000_000_000_000n,0n)]);
if(stale.value!==false)throw Error('Old owner approval was not rejected');
await action('oldOwnerUpgradeApprovalDenied',seller,registry.id,'approve_vault_upgrade',{token_id:token,code_hash:release},'1',true);
if((await codeHash())!==release)throw Error('Stale approval deployed code');
await action('cancelSecurityUpgrade',guardian,vault,'cancel_upgrade',{});
const after=await sdk.get(token),status=await sdk.view(vault,'status');
if(after.vaultAccountId!==before.vault||after.ownerEpoch!==before.epoch+1||status.upgrade_proposal!==null)
  throw Error('Sale or cleanup state differs');
const evidence={checkedAt:new Date().toISOString(),network:'NEAR testnet',runtimeHash:runtime.upload.hash,
  smokeJobId:smoke.id,refundReplay:{payout:payoutAfter,ledger:ledgerAfter},
  staleUpgrade:{oldOwner:seller.id,newOwner:buyer.id,oldEpoch:before.epoch,newEpoch:after.ownerEpoch,
    vault,codeHash:release,oldApprovalResult:stale.value,proposalCleared:status.upgrade_proposal===null},
  transactions:Object.fromEntries(Object.entries(ctx.evidence.steps).map(([k,v])=>[k,{hash:v.hash,failed:v.outcome?.failed,value:v.outcome?.value}])),
  scope:'Replay of a failed hosted job and stale owner upgrade approval; local reserve refund-loop property test remains separate.'};
await writeFile('docs/evidence/reviewed-security-regressions.json',JSON.stringify(evidence,null,2)+'\n');
console.log(JSON.stringify({passed:true,smokeJobId:smoke.id,oldEpoch:before.epoch,newEpoch:after.ownerEpoch},null,2));
