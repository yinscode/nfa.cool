import test from 'node:test';
import assert from 'node:assert/strict';
import {nearAmount,nextLaunchStep,DEFAULT_LIMITS} from '../launch-state.mjs';
const plan={owner:'alice.test.near',serviceIds:['scout','compare'],marginYocto:nearAmount('0.02'),reserveYocto:nearAmount('0.2'),maxDepositYocto:nearAmount('0.5'),release:{versionKey:'a'.repeat(64)}};
const skills=[{id:'scout',schemaHash:'scout-hash'},{id:'compare',schemaHash:'compare-hash'}];
const policy=id=>({enabled:true,schema_hash:id+'-hash',min_margin:plan.marginYocto,max_deposit:plan.maxDepositYocto,limits:DEFAULT_LIMITS});
const snapshot=()=>({identity:{ownerAccountId:plan.owner,lifecycle:'ACTIVE'},agent:{pending_op:null},project:{state:'READY',version_key:plan.release.versionKey},policies:{scout:policy('scout'),compare:policy('compare')},treasury:{available:nearAmount('0.3')}});
test('launch advances from confirmed state, preserves uncertainty and distinguishes minted from ready',()=>{
  assert.equal(nextLaunchStep(plan,{},null,skills).id,'mint');
  assert.equal(nextLaunchStep({...plan,pending:{step:'mint'}},{},null,skills).id,'reconcile');
  assert.equal(nextLaunchStep(plan,{tokenId:'nfa-1',minted:false},null,skills).waiting,true);
  const s=snapshot();s.project=null;assert.equal(nextLaunchStep(plan,{minted:true},s,skills).id,'project');
  s.project={state:'READY',version_key:plan.release.versionKey};delete s.policies.compare;
  assert.equal(nextLaunchStep(plan,{minted:true},s,skills).id,'policy:compare');
  s.policies.compare=policy('compare');s.treasury.available=nearAmount('0.1');
  assert.equal(nextLaunchStep(plan,{minted:true},s,skills).amount,nearAmount('0.1'));
  s.treasury.available=nearAmount('0.3');assert.equal(nextLaunchStep(plan,{minted:true},s,skills).ready,true);
  s.agent.pending_op=8;assert.equal(nextLaunchStep(plan,{minted:true},s,skills).waiting,true);
  s.agent.pending_op=null;s.identity.ownerAccountId='bob.test.near';assert.equal(nextLaunchStep(plan,{minted:true},s,skills).blocked,true);
});
test('NEAR inputs retain exact precision and reject exponential or excessive decimals',()=>{
  assert.equal(nearAmount('0.000000000000000000000001'),'1');
  assert.equal(nearAmount('2.01'),'2010000000000000000000000');
  for(const invalid of ['1e4','-1','0.0000000000000000000000001','NaN'])assert.throws(()=>nearAmount(invalid));
});

test('restored launches recheck approved code and funding bounds before another wallet action',async()=>{
  const {validateLaunchPlan}=await import('../launch-state.mjs');
  const reviewed={...plan.release,url:'https://example.org/reviewed.wasm',hostedStatus:'verified',services:['scout','compare']};
  const restored={...plan,release:reviewed};assert.doesNotThrow(()=>validateLaunchPlan(restored,[reviewed]));
  assert.throws(()=>validateLaunchPlan({...restored,reserveYocto:nearAmount('100')},[reviewed]),/limits/);
  assert.throws(()=>validateLaunchPlan({...restored,release:{...reviewed,url:'https://example.org/unreviewed.wasm'}},[reviewed]),/catalog/);
});
test('RPC errors containing rejected do not discard an unresolved payment intent',async()=>{
  const {walletCanceled}=await import('../launch-state.mjs');
  assert.equal(walletCanceled({code:4001}),true);assert.equal(walletCanceled({message:'User rejected the request'}),true);
  assert.equal(walletCanceled({message:'RPC rejected response after broadcast; outcome unknown'}),false);
});
