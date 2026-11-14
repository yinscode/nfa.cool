#!/usr/bin/env node
// Journaled testnet rollout; the registry phase enforces the public delay.
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {transactions,utils} from 'near-api-js';
import {NfaSdk} from '@nfa/sdk';
import {testnet,pause} from './testnet-lib.mjs';

const phase=process.argv[2];
if(!['registry','vault','issue','verify'].includes(phase))throw Error('Use registry, vault, issue or verify');
const sha=b=>createHash('sha256').update(b).digest('hex');
const oldRegistryHash='b733b54b7ea955c6f95042f3ecbe27ad2391dbaa83409416d2dc9cdc790295b4';
const newRegistryHash='5a6f3f0b37c0a2178c65ba48018366da62f220b22881a02eac07ad8470f71fbb';
const oldVaultHash='200821c58802e52ac795fbd1a594a66d6f6de8703862019972b9ee93bc33c6e7';
const newVaultHash='5a37a47242d4d38994c7849d11a227146e2816a1e09420336892c12c7a5050ce';
const registryId='nfagent-registry-0e9b2a.testnet',tokenId='nfa-2';
const newRegistry=await readFile('releases/nfa-registry-payment-key-5a6f3f0b37c0a217.wasm');
const newVault=await readFile('releases/nfa-vault-payment-key-5a37a47242d4d389.wasm');
if(sha(newRegistry)!==newRegistryHash||sha(newVault)!==newVaultHash)throw Error('Pinned release bytes changed');
const ctx=await testnet('deployments/payment-key-upgrade.json');
const operator=await ctx.signer('t004-operator'),alice=await ctx.signer('t006-alice'),funder=await ctx.signer('studio-funder');
const sdk=new NfaSdk({registryAccountId:registryId,rpcUrl:ctx.rpcUrl});
const codeHash=async id=>Buffer.from(utils.serialize.base_decode((await ctx.account(id)).code_hash)).toString('hex');
const call=(method,args,gas=80_000_000_000_000n,deposit=0n)=>transactions.functionCall(
  method,Buffer.from(JSON.stringify(args)),gas,deposit);
const until=async(work,predicate,label)=>{for(let i=0;i<90;i++){
  try{const value=await work();if(predicate(value))return value}catch{}await pause(500)
}throw Error(`${label} not observed; inspect journal, do not resend blindly`)};
const identity=await sdk.get(tokenId),vault=identity.vaultAccountId;
if(vault!==`nfa-2.${registryId}`||identity.ownerAccountId!==alice.id)throw Error('NFA owner/vault changed');

if(phase==='registry'){
  const authorities=await sdk.view(registryId,'authorities');
  if(authorities.admin!==operator.id||authorities.registry_upgrade?.code_hash!==newRegistryHash)
    throw Error('Admin or public code proposal changed');
  const eligible=BigInt(authorities.registry_upgrade.proposed_at_ns)+172_800_000_000_000n;
  const block=(await ctx.rpc('block',{finality:'final'})).header;
  if(BigInt(block.timestamp_nanosec)<eligible)throw Error(`Public registry upgrade delay ends at ${new Date(Number(eligible/1_000_000n)).toISOString()}`);
  const deployed=await codeHash(registryId);
  if(deployed!==oldRegistryHash&&deployed!==newRegistryHash)throw Error('Unexpected registry code');
  if(deployed===newRegistryHash&&!ctx.evidence.before)
    throw Error('Registry changed without this rollout journal; inspect state before continuing');
  if(deployed===oldRegistryHash){
    const current=await ctx.account(registryId),ledger=await sdk.view(registryId,'registry_ledger');
    const available=BigInt(current.amount)-BigInt(current.storage_usage)*10n**19n-BigInt(ledger.liabilities);
    if(available<0n)throw Error('Registry liabilities exceed liquid balance');
    if(!ctx.evidence.before){
      ctx.evidence.before={identity,ledger,project:await sdk.getOutlayerProject(tokenId),
        vaultStatus:await sdk.view(vault,'status')};await ctx.save();
    }
    if(!ctx.evidence.steps.paymentKeyRegistryReserve?.outcome)
      await ctx.send('paymentKeyRegistryReserve',funder,registryId,[transactions.transfer(10n**24n)]);
    await ctx.send('applyPaymentKeyRegistryUpgrade',operator,registryId,[transactions.functionCall(
      'apply_registry_upgrade',newRegistry,250_000_000_000_000n,0n)]);
  }
  await until(()=>codeHash(registryId),v=>v===newRegistryHash,'Registry code');
  const after=await sdk.get(tokenId),ledger=await sdk.view(registryId,'registry_ledger');
  if(after.ownerAccountId!==identity.ownerAccountId||after.ownerEpoch!==identity.ownerEpoch||
    after.vaultAccountId!==vault||after.manifestHash!==identity.manifestHash||
    ledger.liabilities!==ctx.evidence.before.ledger.liabilities)throw Error('Registry upgrade changed identity or liabilities');
  console.log(JSON.stringify({phase,registryHash:newRegistryHash,owner:after.ownerAccountId,
    liabilities:ledger.liabilities,scope:'Registry deployed; vault still old'}));
}
if(phase==='vault'){
  if(await codeHash(registryId)!==newRegistryHash)throw Error('Upgrade registry first');
  const deployed=await codeHash(vault);
  if(deployed!==oldVaultHash&&deployed!==newVaultHash)throw Error('Unexpected vault code');
  const before=await sdk.view(vault,'status');
  const agent=await sdk.getAgentState(tokenId);
  if(agent.pending_op!=null||before.pending!=null)throw Error('Vault or NFA has unresolved operation');
  if(deployed===oldVaultHash){
    if(!ctx.evidence.steps.proposePaymentKeyVaultUpgrade?.outcome)
      await ctx.send('proposePaymentKeyVaultUpgrade',operator,vault,[call('propose_upgrade',{code_hash:newVaultHash})]);
    if(!ctx.evidence.steps.approvePaymentKeyVaultUpgrade?.outcome)
      await ctx.send('approvePaymentKeyVaultUpgrade',alice,registryId,[call('approve_vault_upgrade',
        {token_id:tokenId,code_hash:newVaultHash},80_000_000_000_000n,1n)]);
    const firstApply=ctx.evidence.steps.applyPaymentKeyVaultUpgrade;
    if(firstApply?.outcome?.failed){
      const reason=firstApply.outcome.failure?.ActionError?.kind?.FunctionCallError?.ExecutionError;
      if(reason!=='Exceeded the prepaid gas.')throw Error('First vault apply failed for another reason; inspect before retry');
      const proposal=await sdk.view(vault,'upgrade_proposal');
      if(proposal?.code_hash!==newVaultHash||proposal?.approved_at_ns==null)
        throw Error('Vault proposal or approval changed before gas retry');
      await ctx.send('applyPaymentKeyVaultUpgrade300T',operator,vault,[call('emergency_upgrade',
        {code:newVault.toString('base64')},300_000_000_000_000n)]);
    }else{
      await ctx.send('applyPaymentKeyVaultUpgrade',operator,vault,[call('emergency_upgrade',
        {code:newVault.toString('base64')},250_000_000_000_000n)]);
    }
  }
  await until(()=>codeHash(vault),v=>v===newVaultHash,'Vault code');
  const after=await sdk.view(vault,'status');
  for(const field of ['controller','reporter','guardian','next_operation_id','next_evm_nonce','pending','last_receipt'])
    if(JSON.stringify(after[field])!==JSON.stringify(before[field]))throw Error(`Vault ${field} changed`);
  if((await sdk.get(tokenId)).ownerEpoch!==identity.ownerEpoch)throw Error('NFA owner epoch changed');
  console.log(JSON.stringify({phase,vaultHash:newVaultHash,owner:identity.ownerAccountId,
    scope:'Vault upgraded; Payment Key not issued'}));
}
if(phase==='issue'){
  if(await codeHash(registryId)!==newRegistryHash||await codeHash(vault)!==newVaultHash)
    throw Error('Both code upgrades must finish first');
  const packageFile=JSON.parse(await readFile('.data/outlayer-payment-key-nfa-2.private.json','utf8'));
  const {nonce,ciphertextHash,encryptedSecretsBase64,owner,projectIds,maxPerCallMicrousd}=packageFile;
  if(owner!==vault||projectIds?.length!==1||projectIds[0]!==`${vault}/scout`||
    maxPerCallMicrousd!=='100000'||sha(Buffer.from(encryptedSecretsBase64))!==ciphertextHash)
    throw Error('Private Payment Key package mismatch');
  const nextNonce=await sdk.view('outlayer.testnet','get_next_payment_key_nonce',{account_id:vault});
  const setup=await sdk.view(registryId,'payment_key_setup',{token_id:tokenId});
  if(nextNonce!==nonce&&setup?.state!=='READY')throw Error('OutLayer Payment Key nonce changed; reconcile before issuing');
  if(setup?.state!=='READY'){
    if(setup&&setup.state!=='APPROVED')throw Error(`Payment Key setup is ${setup.state}; reconcile before retry`);
    if(!setup)await ctx.send('approveVaultPaymentKey',alice,registryId,[call('approve_payment_key',
      {token_id:tokenId,nonce,ciphertext_hash:ciphertextHash},80_000_000_000_000n,1n)]);
    const approved=await sdk.view(registryId,'payment_key_setup',{token_id:tokenId});
    if(approved?.state!=='APPROVED'||approved.ciphertext_hash!==ciphertextHash||
      approved.epoch!==identity.ownerEpoch)throw Error('Owner approval changed');
    await ctx.send('issueVaultPaymentKey',operator,registryId,[call('issue_payment_key',
      {token_id:tokenId,encrypted_secrets_base64:encryptedSecretsBase64},300_000_000_000_000n)]);
  }
  const ready=await until(()=>sdk.view(registryId,'payment_key_setup',{token_id:tokenId}),
    v=>v?.state==='READY','Payment Key READY state');
  const stored=await sdk.view('outlayer.testnet','get_secrets',{accessor:{System:'PaymentKey'},
    profile:String(nonce),owner:vault});
  if(!stored?.encrypted_secrets)throw Error('OutLayer does not show the encrypted Payment Key');
  console.log(JSON.stringify({phase,nonce,state:ready.state,owner:vault,projectId:projectIds[0],
    maxPerCallMicrousd,scope:'Key issued with zero USD balance; funding is separate'}));
}
if(phase==='verify'){
  const setup=await sdk.view(registryId,'payment_key_setup',{token_id:tokenId});
  const current=await sdk.get(tokenId),project=await sdk.getOutlayerProject(tokenId);
  if(await codeHash(registryId)!==newRegistryHash||await codeHash(vault)!==newVaultHash||
    setup?.state!=='READY'||current.ownerAccountId!==identity.ownerAccountId||
    current.ownerEpoch!==identity.ownerEpoch||project?.state!=='READY')
    throw Error('Payment Key rollout is incomplete or NFA identity changed');
  const result={checkedAt:new Date().toISOString(),network:'NEAR testnet',registryHash:await codeHash(registryId),
    vaultHash:await codeHash(vault),paymentKey:{state:setup?.state??null,nonce:setup?.nonce??null,
      ciphertextHash:setup?.ciphertext_hash??null},identity:{owner:current.ownerAccountId,
      epoch:current.ownerEpoch,vault:current.vaultAccountId,manifestHash:current.manifestHash},
    project:{id:project?.project_id,versionKey:project?.version_key,state:project?.state},
    transactions:Object.fromEntries(Object.entries(ctx.evidence.steps).map(([name,step])=>
      [name,{hash:step.hash,failed:step.outcome?.failed??null}])),
    scope:'Code, state and zero-balance key issuance only. HTTPS execution and Research acceptance are separate.'};
  await writeFile('docs/evidence/payment-key-upgrade-testnet.json',JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result));
}
