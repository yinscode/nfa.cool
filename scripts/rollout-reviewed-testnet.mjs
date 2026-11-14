#!/usr/bin/env node
// Journaled testnet rollout: registry funding/deploy/migration, then both vaults.
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {transactions,utils} from 'near-api-js';
import {NfaSdk} from '@nfa/sdk';
import {testnet,pause} from './testnet-lib.mjs';
const phase=process.argv[2];
if(!['registry','vaults','verify'].includes(phase))throw Error('Usage: rollout-reviewed-testnet.mjs registry|vaults|verify');
const ctx=await testnet('deployments/reviewed-rollout.json');
const registry=await ctx.signer('t006-registry'),operator=await ctx.signer('t004-operator'),funder=await ctx.signer('studio-funder');
const sdk=new NfaSdk({registryAccountId:registry.id,rpcUrl:ctx.rpcUrl});
const hash=b=>createHash('sha256').update(b).digest('hex');
const code=await readFile('releases/nfa-registry-reviewed-0f02c8a935199f99.wasm');
const vaultCode=await readFile('releases/nfa-vault-reviewed-200821c58802e52a.wasm');
if(hash(code)!=='0f02c8a935199f998922552067f92f5bfc6b2ae58edf89c5bc30bb3e034e63d0'||
  hash(vaultCode)!=='200821c58802e52ac795fbd1a594a66d6f6de8703862019972b9ee93bc33c6e7')throw Error('Release bytes changed');
const queryCode=async id=>Buffer.from(utils.serialize.base_decode((await ctx.account(id)).code_hash)).toString('hex');
async function until(work,predicate){for(let i=0;i<100;i++){try{const value=await work();if(predicate(value))return value}catch{}await pause(500)}throw Error('Final state not observed; inspect journal before retry')}
const preflight=JSON.parse(await readFile('docs/evidence/liability-migration-preflight.json','utf8'));
const ids=Object.keys(preflight.agents);
async function identities(){
  const result={};for(const token of ids){
    const n=await sdk.get(token),s=await sdk.view(n.vaultAccountId,'status'),p=await sdk.getOutlayerProject(token).catch(()=>null);
    result[token]={owner:n.ownerAccountId,epoch:n.ownerEpoch,vault:n.vaultAccountId,address:n.foreignWallet?.address??null,
      projectUuid:p?.project_uuid??null,runtime:p?.version_key??null,income:n.income,manifestHash:n.manifestHash,
      vaultStatus:s};
  }return result;
}
const stable=(row,old)=>['owner','epoch','vault','address','projectUuid','runtime','income','manifestHash'].every(k=>row[k]===old[k]);
const action=(who,receiverId,methodName,args,gas='100000000000000',deposit='0')=>
  [transactions.functionCall(methodName,Buffer.from(JSON.stringify(args)),BigInt(gas),BigInt(deposit))];
if(phase==='registry'){
  const oldHash=preflight.oldCodeSha256,newHash=hash(code),deployed=await queryCode(registry.id);
  if(deployed!==oldHash&&deployed!==newHash)throw Error(`Unexpected deployed registry ${deployed}`);
  if(!ctx.evidence.before){
    if(deployed!==oldHash)throw Error('Pre-upgrade identity snapshot was not recorded');
    const now=await identities();for(const token of ids)if(!stable(now[token],preflight.agents[token]))throw Error(`${token} changed since preflight`);
    ctx.evidence.before=now;ctx.evidence.preflight=preflight.migration;await ctx.save();
  }
  if(deployed===oldHash){
    const amount=10n**24n; // 1 testNEAR covers the measured 0.861 top-up and migration writes.
    if(BigInt(preflight.requiredTopUpYocto)>amount)throw Error('Measured registry top-up exceeds 1 testNEAR');
    if(!ctx.evidence.steps.registryStorageFunding?.outcome)
      await ctx.send('registryStorageFunding',funder,registry.id,[transactions.transfer(amount)]);
    await ctx.send('reviewedRegistryDeploy',registry,registry.id,[transactions.deployContract(code)]);
  }
  await until(()=>queryCode(registry.id),v=>v===newHash);
  if(await sdk.view(registry.id,'liability_migration_required')){
    const p=ctx.evidence.preflight;
    await ctx.send('migrateLiabilitiesByAdmin',operator,registry.id,
      action(registry,registry.id,'migrate_liabilities',p,'200000000000000'));
  }
  const ledger=await until(()=>sdk.view(registry.id,'registry_ledger'),v=>v?.liabilities===ctx.evidence.preflight.expected_total);
  const after=await identities();for(const token of ids)if(!stable(after[token],ctx.evidence.before[token]))throw Error(`${token} identity/balance changed`);
  ctx.evidence.registry={hash:newHash,ledger,before:ctx.evidence.before,after};await ctx.save();
  console.log(JSON.stringify({registryHash:newHash,liabilities:ledger.liabilities,identitiesPreserved:ids},null,2));
}else if(phase==='vaults'){
  if(!ctx.evidence.registry)throw Error('Registry migration must complete first');
  const before=ctx.evidence.registry.after;
  for(const token of ids){
    const vault=before[token].vault,deployed=await queryCode(vault);
    if(deployed===hash(vaultCode))continue;
    if(token==='nfa-1'&&!ctx.evidence.steps.firstVaultStorageFunding?.outcome)
      await ctx.send('firstVaultStorageFunding',funder,vault,[transactions.transfer(10n**24n)]);
    await ctx.send(`${token}ReviewedVaultUpgrade`,operator,vault,
      action(operator,vault,'emergency_upgrade',{code:vaultCode.toString('base64')},'100000000000000'));
    await until(()=>queryCode(vault),v=>v===hash(vaultCode));
  }
  const after=await identities();for(const token of ids){
    if(!stable(after[token],before[token]))throw Error(`${token} identity/balance changed on vault upgrade`);
    const old=before[token].vaultStatus,now=after[token].vaultStatus;
    for(const key of Object.keys(old))if(JSON.stringify(old[key])!==JSON.stringify(now[key]))throw Error(`${token} vault ${key} changed`);
    if(now.upgrade_proposal!==null||now.recovery_interface!==1||now.research_interface!==1)throw Error(`${token} missing governed vault interface`);
  }
  ctx.evidence.vaults={hash:hash(vaultCode),after};await ctx.save();
  console.log(JSON.stringify({vaultHash:hash(vaultCode),identitiesPreserved:ids},null,2));
}else{
  if(!ctx.evidence.registry||!ctx.evidence.vaults)throw Error('Rollout incomplete');
  const after=await identities();for(const token of ids)if(!stable(after[token],ctx.evidence.before[token]))throw Error(`${token} identity/balance changed`);
  const ledger=await sdk.view(registry.id,'registry_ledger');
  if(ledger.liabilities!==ctx.evidence.preflight.expected_total)throw Error('Migrated liabilities changed');
  for(const token of ids)if(await queryCode(after[token].vault)!==hash(vaultCode))throw Error(`${token} vault hash differs`);
  const publicEvidence={checkedAt:new Date().toISOString(),network:'NEAR testnet',registry:registry.id,
    registryHash:hash(code),vaultHash:hash(vaultCode),liabilities:ledger.liabilities,
    identities:after,transactions:Object.fromEntries(Object.entries(ctx.evidence.steps).map(([k,v])=>[k,{hash:v.hash,failed:v.outcome?.failed}])),
    scope:'Code and state continuity only; hosted Research acceptance and security regression receipts are separate.'};
  await writeFile('docs/evidence/reviewed-testnet-rollout.json',JSON.stringify(publicEvidence,null,2)+'\n');
  console.log(JSON.stringify({verified:true,registryHash:hash(code),vaultHash:hash(vaultCode),liabilities:ledger.liabilities},null,2));
}
