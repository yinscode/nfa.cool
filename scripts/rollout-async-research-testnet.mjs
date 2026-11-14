#!/usr/bin/env node
// Journaled, exact-byte registry upgrade after the local predecessor rehearsal.
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {transactions,utils} from 'near-api-js';
import {NfaSdk} from '@nfa/sdk';
import {testnet,pause} from './testnet-lib.mjs';

const oldHash='5a6f3f0b37c0a2178c65ba48018366da62f220b22881a02eac07ad8470f71fbb';
const newHash='f989bfe9bc179b14b4272334f4f819663df5d5186132a88a03eb3f01de3acae4';
const code=await readFile('releases/nfa-registry-async-f989bfe9bc179b14.wasm');
if(createHash('sha256').update(code).digest('hex')!==newHash)throw Error('Pinned async registry bytes changed');
const rehearsal=JSON.parse(await readFile('docs/evidence/async-research-upgrade-rehearsal.json'));
if(rehearsal.oldHash!==oldHash||rehearsal.newHash!==newHash||
  !rehearsal.assertions?.includes('direct sandbox deployment preserved identity, balances, vault state and paid job'))
  throw Error('Exact predecessor rehearsal is required');
const ctx=await testnet('deployments/async-research-rollout.json');
const registry=await ctx.signer('t006-registry'),funder=await ctx.signer('studio-funder');
if(registry.id!=='nfagent-registry-0e9b2a.testnet')throw Error('Unexpected registry');
const sdk=new NfaSdk({registryAccountId:registry.id,rpcUrl:ctx.rpcUrl});
const hash=async()=>Buffer.from(utils.serialize.base_decode((await ctx.account(registry.id)).code_hash)).toString('hex');
const until=async(work,check)=>{for(let i=0;i<80;i++){try{const v=await work();if(check(v))return v}catch{}await pause(500)}
  throw Error('Final state not observed; inspect private journal')};
async function snapshot(){
  const [ledger,identity1,identity2,agent1,agent2,project1,project2,job26]=await Promise.all([
    sdk.view(registry.id,'registry_ledger'),sdk.get('nfa-1'),sdk.get('nfa-2'),
    sdk.getAgentState('nfa-1'),sdk.getAgentState('nfa-2'),
    sdk.getOutlayerProject('nfa-1'),sdk.getOutlayerProject('nfa-2'),sdk.getServiceJob('nfa-2',26)]);
  const vaults={};for(const n of [identity1,identity2])vaults[n.tokenId]=await sdk.view(n.vaultAccountId,'status');
  return {ledger,identity1,identity2,agent1,agent2,project1,project2,job26,vaults};
}
let deployed=await hash();
if(![oldHash,newHash].includes(deployed))throw Error(`Unexpected live registry hash ${deployed}`);
if(!ctx.evidence.before){
  if(deployed!==oldHash)throw Error('Missing pre-deploy snapshot');
  ctx.evidence.before=await snapshot();await ctx.save();
}
const before=ctx.evidence.before;
if(before.agent1.pending_op!=null||before.agent2.pending_op!=null||
  before.job26.job.status!=='FINALIZED')throw Error('NFA operation or prior Research state changed');
if(deployed===oldHash){
  const live=await snapshot();
  if(JSON.stringify(live)!==JSON.stringify(before))throw Error('Live state changed after snapshot');
  const account=await ctx.account(registry.id);
  const oldCode=await readFile('releases/nfa-registry-payment-key-5a6f3f0b37c0a217.wasm');
  const newStorage=BigInt(account.storage_usage)+BigInt(code.length-oldCode.length);
  const required=newStorage*10n**19n+BigInt(before.ledger.liabilities)+2n*10n**23n-BigInt(account.amount);
  const topUp=required>0n?((required+10n**23n-1n)/10n**23n)*10n**23n:0n;
  if(topUp>2n*10n**24n)throw Error('Registry funding need exceeds 2 testNEAR cap');
  if(topUp>0n)await ctx.send('asyncRegistryTopUp',funder,registry.id,[transactions.transfer(topUp)]);
  await ctx.send('asyncRegistryDeploy',registry,registry.id,[transactions.deployContract(code)]);
  deployed=await until(hash,h=>h===newHash);
}
const after=await until(snapshot,s=>JSON.stringify(s.identity2)===JSON.stringify(before.identity2));
for(const key of ['identity1','identity2','agent1','agent2','project1','project2','job26','vaults'])
  if(JSON.stringify(after[key])!==JSON.stringify(before[key]))throw Error(`${key} changed on registry upgrade`);
if(after.ledger.liabilities!==before.ledger.liabilities||
  await sdk.view(registry.id,'liability_migration_required')!==false)
  throw Error('Liability preservation failed');
const account=await ctx.account(registry.id);
const reserve=BigInt(account.amount)-BigInt(account.storage_usage)*10n**19n-BigInt(after.ledger.liabilities);
if(reserve<10n**23n)throw Error('Registry reserve below 0.1 testNEAR');
const evidence={checkedAt:new Date().toISOString(),network:'NEAR testnet',oldHash,newHash,
  exception:'Direct deployment with existing FullAccess key; two-day public apply path remains to be rehearsed live',
  preserved:['both NFA identities','both vault states','Project UUIDs and runtimes','Research job 26','liabilities'],
  liabilityYocto:after.ledger.liabilities,reserveAboveLiabilitiesYocto:reserve.toString(),
  transactions:Object.fromEntries(Object.entries(ctx.evidence.steps).map(([k,v])=>[k,{hash:v.hash,failed:v.outcome?.failed}]))};
await writeFile('docs/evidence/async-research-testnet-rollout.json',JSON.stringify(evidence,null,2)+'\n');
console.log(JSON.stringify({deployed:newHash,liabilities:after.ledger.liabilities,reserveYocto:reserve.toString()}));
