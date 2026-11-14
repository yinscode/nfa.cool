#!/usr/bin/env node
// Journaled registry-only testnet upgrade for capped NFA hiring and refund views.
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {transactions,utils} from 'near-api-js';
import {NfaSdk} from '@nfa/sdk';
import {testnet,pause} from './testnet-lib.mjs';

const oldHash='0f02c8a935199f998922552067f92f5bfc6b2ae58edf89c5bc30bb3e034e63d0';
const newHash='b733b54b7ea955c6f95042f3ecbe27ad2391dbaa83409416d2dc9cdc790295b4';
const code=await readFile('releases/nfa-registry-hiring-b733b54b7ea955c6.wasm');
if(createHash('sha256').update(code).digest('hex')!==newHash)throw Error('Pinned hiring WASM changed');
const preflight=JSON.parse(await readFile('docs/evidence/hiring-upgrade-preflight.json'));
if(preflight.oldCodeSha256!==oldHash||preflight.newCodeSha256!==newHash||
  Date.now()-Date.parse(preflight.checkedAt)>600_000)throw Error('Run a fresh hiring upgrade preflight');
const ctx=await testnet('deployments/hiring-rollout.json');
const registry=await ctx.signer('t006-registry'),funder=await ctx.signer('studio-funder');
if(registry.id!==preflight.registry)throw Error('Registry account mismatch');
const sdk=new NfaSdk({registryAccountId:registry.id,rpcUrl:ctx.rpcUrl});
const ids=Object.keys(preflight.agents);
const currentHash=async()=>Buffer.from(utils.serialize.base_decode((await ctx.account(registry.id)).code_hash)).toString('hex');
async function identities(){
  const rows={};for(const token of ids){
    const n=await sdk.get(token),agent=await sdk.getAgentState(token);
    const [status,project]=await Promise.all([sdk.view(n.vaultAccountId,'status'),sdk.getOutlayerProject(token)]);
    rows[token]={owner:n.ownerAccountId,epoch:n.ownerEpoch,vault:n.vaultAccountId,
      address:n.foreignWallet?.address??null,projectUuid:project?.project_uuid??null,
      runtime:project?.version_key??null,income:n.income,manifestHash:n.manifestHash,
      vaultStatus:status,pendingOp:agent.pending_op};
  }return rows;
}
const same=(left,right)=>JSON.stringify(left)===JSON.stringify(right);
const until=async(work,predicate)=>{for(let i=0;i<100;i++){
  try{const value=await work();if(predicate(value))return value}catch{}await pause(500)
}throw Error('Final state not observed; inspect journal before retry')};
let deployed=await currentHash();
if(deployed!==oldHash&&deployed!==newHash)throw Error(`Unexpected registry code ${deployed}`);
if(!ctx.evidence.before){
  if(deployed!==oldHash)throw Error('Pre-deploy identity snapshot missing');
  const before=await identities();
  for(const token of ids){
    const {pendingOp,...row}=before[token];
    if(pendingOp!=null||!same(row,preflight.agents[token]))throw Error(`${token} changed since preflight`);
  }
  const ledger=await sdk.view(registry.id,'registry_ledger');
  if(ledger.liabilities!==preflight.ledger.liabilities)throw Error('Liabilities changed since preflight');
  ctx.evidence.before=before;ctx.evidence.ledgerBefore=ledger;await ctx.save();
}
if(deployed===oldHash){
  const topUp=10n**23n; // 0.1 testNEAR, above the measured 0.0141 minimum.
  if(BigInt(preflight.requiredTopUpYocto)>topUp)throw Error('Required reserve top-up exceeds cap');
  await ctx.send('hiringRegistryTopUp',funder,registry.id,[transactions.transfer(topUp)]);
  await ctx.send('hiringRegistryDeploy',registry,registry.id,[transactions.deployContract(code)]);
  deployed=await until(currentHash,value=>value===newHash);
}
const after=await identities();
for(const token of ids)if(!same(after[token],ctx.evidence.before[token]))throw Error(`${token} changed on upgrade`);
const ledgerAfter=await sdk.view(registry.id,'registry_ledger');
if(ledgerAfter.liabilities!==ctx.evidence.ledgerBefore.liabilities||
  await sdk.view(registry.id,'liability_migration_required'))throw Error('Liability ledger changed on upgrade');
const account=await ctx.account(registry.id),reserve=BigInt(account.amount)-BigInt(account.storage_usage)*10n**19n-
  BigInt(ledgerAfter.liabilities);
if(reserve<10n**23n)throw Error('Registry reserve below 0.1 testNEAR after upgrade');
const evidence={checkedAt:new Date().toISOString(),network:'NEAR testnet',registry:registry.id,
  oldHash,newHash,transactions:Object.fromEntries(Object.entries(ctx.evidence.steps).map(([name,row])=>
    [name,{hash:row.hash,failed:row.outcome?.failed}])),liabilities:ledgerAfter.liabilities,
  reserveAboveLiabilitiesYocto:reserve.toString(),before:ctx.evidence.before,after,
  scope:'Registry code and state only. Token and Intents merchant payments are not live.'};
await writeFile('docs/evidence/hiring-testnet-rollout.json',JSON.stringify(evidence,null,2)+'\n');
console.log(JSON.stringify({registryHash:newHash,identitiesPreserved:ids,
  liabilities:ledgerAfter.liabilities,reserveAboveLiabilitiesYocto:reserve.toString()},null,2));
