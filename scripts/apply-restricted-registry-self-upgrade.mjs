#!/usr/bin/env node
// Apply the already proposed exact registry bytes after the public delay.
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {KeyPair,keyStores,connect,transactions,utils} from 'near-api-js';
import {NfaSdk} from '@nfa/sdk';
import {testnet,pause} from './testnet-lib.mjs';

const registryId='nfagent-registry-0e9b2a.testnet';
const scheduled=JSON.parse(await readFile('docs/evidence/restricted-self-upgrade-scheduled.json'));
const code=await readFile('releases/nfa-registry-async-recovery-f9c750ad48e369b7.wasm');
const hash=createHash('sha256').update(code).digest('hex');
if(scheduled.registryId!==registryId||scheduled.codeHash!==hash||scheduled.applied)
  throw Error('Scheduled exact-code proposal changed or was already applied');
if(Date.now()<Date.parse(scheduled.earliestApplyUtc))
  throw Error(`Public delay has not elapsed; earliest apply ${scheduled.earliestApplyUtc}`);
const ctx=await testnet('deployments/restricted-self-upgrade-apply.json');
const sdk=new NfaSdk({registryAccountId:registryId,rpcUrl:ctx.rpcUrl});
const current=async()=>Buffer.from(utils.serialize.base_decode((await ctx.account(registryId)).code_hash)).toString('hex');
if(await current()!==hash)throw Error('Live registry code differs before apply');
const authorities=await sdk.view(registryId,'authorities');
if(authorities.registry_upgrade?.code_hash!==hash||
  authorities.registry_upgrade?.proposed_at_ns!==scheduled.proposedAtNs)
  throw Error('Scheduled proposal differs from live authorities');
const record=JSON.parse(await readFile('deployments/admin-registry.key.json'));
const methods=['propose_registry_upgrade','apply_registry_upgrade','cancel_registry_upgrade'];
if(record.receiver_id!==registryId||record.public_key!==scheduled.restrictedAdminKey||
  JSON.stringify(record.method_names)!==JSON.stringify(methods)||
  KeyPair.fromString(record.secret_key).getPublicKey().toString()!==record.public_key)
  throw Error('Restricted registry admin key changed');
const permission=(await ctx.rpc('query',{request_type:'view_access_key',finality:'final',
  account_id:record.account_id,public_key:record.public_key})).permission?.FunctionCall;
if(permission?.receiver_id!==registryId||JSON.stringify(permission.method_names)!==JSON.stringify(methods))
  throw Error('Restricted admin permission changed');
const snapshot=async()=>({
  nfas:await Promise.all(['nfa-1','nfa-2'].map(async tokenId=>({tokenId,
    nft:await sdk.get(tokenId),state:await sdk.getAgentState(tokenId),
    project:await sdk.getOutlayerProject(tokenId),treasury:await sdk.getTreasury(tokenId),
    income:await sdk.getAgentIncome(tokenId)}))),
  ledger:await sdk.view(registryId,'registry_ledger'),
  paid:await sdk.view(registryId,'paid_scout_ledger'),
  sellerResearch:await sdk.getServiceJob('nfa-2',48),
  buyerResearch:await sdk.getServiceJob('nfa-2',51)
});
const before=await snapshot();
if(before.nfas.some(n=>n.state?.pending_op!=null))throw Error('NFA has pending work');
const store=new keyStores.InMemoryKeyStore();await store.setKey('testnet',record.account_id,
  KeyPair.fromString(record.secret_key));
const near=await connect({networkId:'testnet',nodeUrl:ctx.rpcUrl,deps:{keyStore:store}});
const admin={id:record.account_id,account:await near.account(record.account_id)};
await ctx.send('applyRestrictedSelfUpgrade',admin,registryId,[transactions.functionCall(
  'apply_registry_upgrade',code,300_000_000_000_000n,0n)]);
let cleared=false;for(let i=0;i<100;i++){
  const live=await sdk.view(registryId,'authorities');
  if(await current()===hash&&live.registry_upgrade==null){cleared=true;break}
  await pause(500);
}
if(!cleared)throw Error('Exact code and cleared proposal were not observed');
const after=await snapshot();
if(JSON.stringify(before)!==JSON.stringify(after))
  throw Error('Identity, balances, paid history or liabilities changed during exact-code apply');
const evidence={checkedAt:new Date().toISOString(),network:'NEAR testnet',registryId,
  codeHash:hash,proposalTx:scheduled.proposalTx,
  applyTx:ctx.evidence.steps.applyRestrictedSelfUpgrade?.hash,
  restrictedAdminKey:record.public_key,delayedApplyPassed:true,
  identityBalancesMemoryAndLiabilitiesPreserved:true,fullAccessRemoved:false};
await writeFile('docs/evidence/restricted-self-upgrade-applied.json',JSON.stringify(evidence,null,2)+'\n');
scheduled.applied=true;scheduled.applyTx=evidence.applyTx;
await writeFile('docs/evidence/restricted-self-upgrade-scheduled.json',JSON.stringify(scheduled,null,2)+'\n');
console.log(JSON.stringify({applied:true,codeHash:hash,transaction:evidence.applyTx,
  fullAccessRemoved:false}));
