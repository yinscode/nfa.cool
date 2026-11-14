#!/usr/bin/env node
// User-directed testnet exception: deploy the exact proposed registry bytes with its FullAccess key.
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {transactions,utils} from 'near-api-js';
import {NfaSdk} from '@nfa/sdk';
import {testnet} from './testnet-lib.mjs';

const registryId='nfagent-registry-0e9b2a.testnet',tokenId='nfa-2';
const oldHash='b733b54b7ea955c6f95042f3ecbe27ad2391dbaa83409416d2dc9cdc790295b4';
const newHash='5a6f3f0b37c0a2178c65ba48018366da62f220b22881a02eac07ad8470f71fbb';
const bytes=await readFile('releases/nfa-registry-payment-key-5a6f3f0b37c0a217.wasm');
const sha=b=>createHash('sha256').update(b).digest('hex');
if(sha(bytes)!==newHash)throw Error('Exact proposed registry bytes changed');
const ctx=await testnet('deployments/payment-key-upgrade.json');
const registry=await ctx.signer('t006-registry'),operator=await ctx.signer('t004-operator'),
  payer=await ctx.signer('studio-funder');
if(registry.id!==registryId)throw Error('Registry FullAccess signer changed');
const sdk=new NfaSdk({registryAccountId:registryId,rpcUrl:ctx.rpcUrl});
const hash=async id=>Buffer.from(utils.serialize.base_decode((await ctx.account(id)).code_hash)).toString('hex');
const [authorities,identity,agent,project,vaultStatus,ledger,paid,job26,deployed]=await Promise.all([
  sdk.view(registryId,'authorities'),sdk.get(tokenId),sdk.getAgentState(tokenId),
  sdk.getOutlayerProject(tokenId),sdk.view(`nfa-2.${registryId}`,'status'),
  sdk.view(registryId,'registry_ledger'),sdk.view(registryId,'paid_scout_ledger'),
  sdk.getServiceJob(tokenId,26),hash(registryId)]);
if(authorities.admin!==operator.id||authorities.registry_upgrade?.code_hash!==newHash||
  identity.vaultAccountId!==`nfa-2.${registryId}`||
  identity.ownerAccountId!=='nfagent-alice-fe53d8.testnet'||agent.pending_op!=null||
  agent.lifecycle!=='Active'||project.state!=='READY'||project.project_id!==`${identity.vaultAccountId}/scout`||
  vaultStatus.pending!=null||job26?.job?.status!=='FINALIZED'||
  deployed!==oldHash&&deployed!==newHash)
  throw Error('Direct deployment preflight changed');
if(deployed===newHash&&!ctx.evidence.steps.directDeployPaymentKeyRegistry?.outcome)
  throw Error('Registry already changed outside this direct-deployment journal');
const account=await ctx.account(registryId);
const available=BigInt(account.amount)-BigInt(account.storage_usage)*10n**19n-BigInt(ledger.liabilities);
if(available<0n)throw Error('Registry liabilities exceed liquid balance');
if(!ctx.evidence.before){ctx.evidence.before={identity,ledger,project,vaultStatus,paid,
  job26:{id:26,outputHash:job26.job.output_hash,status:job26.job.status}};await ctx.save()}
const before=ctx.evidence.before;
if(JSON.stringify(before.identity)!==JSON.stringify(identity)||
  before.ledger.liabilities!==ledger.liabilities||
  before.project.project_uuid!==project.project_uuid||
  before.job26?.outputHash!==job26.job.output_hash)
  throw Error('Direct-deployment snapshot changed');
if(deployed===oldHash){
  if(!ctx.evidence.steps.paymentKeyRegistryReserve?.outcome)
    await ctx.send('paymentKeyRegistryReserve',payer,registryId,[transactions.transfer(10n**24n)]);
  await ctx.send('directDeployPaymentKeyRegistry',registry,registryId,[transactions.deployContract(bytes)]);
}
if(await hash(registryId)!==newHash)throw Error('Exact registry code not deployed');
const [after,afterAgent,afterProject,afterVault,afterLedger,afterPaid,afterJob]=await Promise.all([
  sdk.get(tokenId),sdk.getAgentState(tokenId),sdk.getOutlayerProject(tokenId),
  sdk.view(identity.vaultAccountId,'status'),sdk.view(registryId,'registry_ledger'),
  sdk.view(registryId,'paid_scout_ledger'),sdk.getServiceJob(tokenId,26)]);
for(const field of ['ownerAccountId','ownerEpoch','vaultAccountId','manifestHash'])
  if(after[field]!==identity[field])throw Error(`Registry upgrade changed ${field}`);
if(after.foreignWallet.address!==identity.foreignWallet.address||
  afterAgent.pending_op!=null||afterAgent.lifecycle!=='Active'||
  afterProject.project_uuid!==project.project_uuid||afterProject.version_key!==project.version_key||
  afterVault.controller!==vaultStatus.controller||afterVault.next_operation_id!==vaultStatus.next_operation_id||
  afterLedger.liabilities!==ledger.liabilities||JSON.stringify(afterPaid)!==JSON.stringify(paid)||
  afterJob.job.output_hash!==job26.job.output_hash||afterJob.job.status!=='FINALIZED'||
  await sdk.view(registryId,'liability_migration_required')!==false)
  throw Error('Registry upgrade failed preservation checks');
if((await sdk.view(registryId,'authorities')).registry_upgrade){
  await ctx.send('cancelProposalAfterDirectDeploy',operator,registryId,[transactions.functionCall(
    'cancel_registry_upgrade',Buffer.from('{}'),30_000_000_000_000n,0n)]);
}
if((await sdk.view(registryId,'authorities')).registry_upgrade)throw Error('Stale proposal remains');
const evidence={checkedAt:new Date().toISOString(),network:'NEAR testnet',
  exception:'User-directed direct registry deployment with pre-existing FullAccess key before the two-day contract delay',
  proposedHash:newHash,oldHash,registryId,tokenId,owner:after.ownerAccountId,
  ownerEpoch:after.ownerEpoch,vault:after.vaultAccountId,projectUuid:afterProject.project_uuid,
  preserved:{identity:true,address:true,liabilities:true,paidLedger:true,job26MemoryCommitment:true,vaultState:true},
  liabilitiesYocto:afterLedger.liabilities,proposalCancelled:true,
  reserveTx:ctx.evidence.steps.paymentKeyRegistryReserve?.hash,
  deployTx:ctx.evidence.steps.directDeployPaymentKeyRegistry?.hash,
  cancelTx:ctx.evidence.steps.cancelProposalAfterDirectDeploy?.hash};
await writeFile('docs/evidence/payment-key-direct-bypass.json',JSON.stringify(evidence,null,2)+'\n');
console.log(JSON.stringify({deployed:true,hash:newHash,deployTx:evidence.deployTx,preserved:evidence.preserved,
  proposalCancelled:true}));
