import test from 'node:test';
import assert from 'node:assert/strict';
import {nfaSummary,withHiresMade} from '../nfa-summary.mjs';

const job=(service_id,status,fee,hired_by=null)=>({service:{service_id,hired_by,job:{status,fee}}});
const snapshot=(tokenId,jobs=[])=>({
  identity:{tokenId,ownerAccountId:'bob.testnet',ownerEpoch:3,lifecycle:'ACTIVE',listing:null,vaultAccountId:`${tokenId}.registry.testnet`,
    foreignWallet:{address:'0xabc'},income:'5',manifestHash:'sha256:'+'a'.repeat(64),manifestUri:'nfa://manifest/x'},
  economics:{jobs:{finalized:2,failed:1},byService:{scout:{finalized:2}},creditedServiceEarnings:'20',withdrawableIncome:'5'},
  availability:[{id:'scout',name:'Scout',description:'Cited findings',available:true,reason:null,quotePolicy:{marginYocto:'10',maxDepositYocto:'50'}},
    {id:'compare',name:'Compare',description:'Rank options',available:false,reason:'project_not_ready'}],
  jobs,chainKey:null,agent:null});

test('summary names the NFA, its image, track record and how to get each service',()=>{
  const hash='b'.repeat(64);
  const s=nfaSummary(snapshot('nfa-2',[job('scout','FINALIZED','12'),job('scout','FINALIZED','14','nfa-1'),job('scout','FAILED','99')]),
    {displayName:' Scout ',publicCharacter:{cutoutHash:'sha256:'+hash,cutoutUri:`https://test.fastfs.io/x/${hash}.png`}});
  assert.equal(s.name,'Scout');
  assert.equal(s.image,`/studio/images/${hash}?uri=${encodeURIComponent(`https://test.fastfs.io/x/${hash}.png`)}`);
  assert.equal(s.ethereumAddress,'0xabc');
  assert.deepEqual(s.trackRecord,{finalizedJobs:2,failedJobs:1,hiredByNfas:1,hiredBy:['nfa-1'],creditedEarningsYocto:'20',withdrawableIncomeYocto:'5'});
  assert.equal(s.services[0].typicalFeeYocto,'12');
  assert.equal(s.services[0].quote,'/v1/nfas/nfa-2/services/scout/quotes');
  assert.equal(s.services[1].available,false);
  assert.equal(s.services[1].reason,'project_not_ready');
  assert.equal(s.links.profile,'/nfa/nfa-2');
});

test('summary falls back to a numbered name and rejects images off the artifact hosts',()=>{
  const s=nfaSummary(snapshot('nfa-7'),{publicCharacter:{imageHash:'sha256:'+'c'.repeat(64),imageUri:'https://evil.example/x.png'}});
  assert.equal(s.name,'NFA #7');
  assert.equal(s.image,null);
});

test('a listing credits each hire to the NFA that made it',()=>{
  const items=withHiresMade([nfaSummary(snapshot('nfa-1')),nfaSummary(snapshot('nfa-2',[job('scout','FINALIZED','12','nfa-1')]))]);
  assert.deepEqual(items[0].trackRecord.hired,['nfa-2']);
  assert.deepEqual(items[1].trackRecord.hired,[]);
});
