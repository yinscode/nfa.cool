import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {triggerPaidScout,triggerPaidService,inspectOutlayer,reconcileKeeperIntent} from '../outlayer-keeper.mjs';
import {KeeperJournal} from '../keeper-journal.mjs';

test('keeper triggers only the committed pending input once',async()=>{
  const input=JSON.stringify({question:'What is NFA?',sources:[]});
  const hash='sha256:'+createHash('sha256').update(input).digest('hex');
  let sent=0,status='REQUESTED';
  const sdk={get:async()=>({lifecycle:'ACTIVE'}),getPaidJob:async()=>({status,input_hash:hash,
    version_key:'a'.repeat(64),deadline_ns:(BigInt(Date.now())*1_000_000n+10_000_000_000n).toString()}),
    getOutlayerProject:async()=>({state:'READY',version_key:'a'.repeat(64)}),
    startPaidScout:()=>({methodName:'start_paid_scout'})};
  const wallet={signAndSendTransaction:async action=>{assert.equal(action.methodName,'start_paid_scout');sent++;status='EXECUTING'}};
  assert.equal((await triggerPaidScout({sdk,wallet,tokenId:'nfa-1',jobId:3,inputData:input})).status,'submitted');
  assert.equal((await triggerPaidScout({sdk,wallet,tokenId:'nfa-1',jobId:3,inputData:input})).status,'skipped');
  assert.equal(sent,1);
  await assert.rejects(()=>triggerPaidScout({sdk:{...sdk,getPaidJob:async()=>({...{status:'REQUESTED',input_hash:hash,version_key:'a'.repeat(64),deadline_ns:'9999999999999999999'}})},wallet,tokenId:'nfa-1',jobId:3,inputData:input+' '}),/Pinned input/);
});

test('keeper uses the same project for a pinned Compare job',async()=>{
  const input=JSON.stringify({question:'Compare the options',criteria:['cost'],sources:[]});
  const hash='sha256:'+createHash('sha256').update(input).digest('hex');
  const job={status:'REQUESTED',input_hash:hash,version_key:'a'.repeat(64),
    deadline_ns:(BigInt(Date.now())*1_000_000n+10_000_000_000n).toString()};
  const sdk={get:async()=>({lifecycle:'ACTIVE'}),getServiceJob:async()=>({service_id:'compare',job}),
    getOutlayerProject:async()=>({state:'READY',version_key:'a'.repeat(64)}),
    startServiceJob:()=>({methodName:'start_service_job'})};
  let sent=0;
  const wallet={signAndSendTransaction:async action=>{assert.equal(action.methodName,'start_service_job');sent++}};
  assert.equal((await triggerPaidService({sdk,wallet,tokenId:'nfa-1',jobId:3,inputData:input,service:'compare'})).status,'submitted');
  assert.equal(sent,1);
  await assert.rejects(()=>triggerPaidService({sdk:{...sdk,getServiceJob:async()=>({service_id:'scout',job})},
    wallet,tokenId:'nfa-1',jobId:3,inputData:input,service:'compare'}),/Job service mismatch/);
});

test('monitor reports low runway and uncertain work without settling it',async()=>{
  const sdk={get:async()=>({ownerEpoch:2}),getOutlayerProject:async()=>({state:'READY',project_id:'vault/scout',project_uuid:'p1',version_key:'a'}),
    getTreasury:async()=>({available:'500'}),getPaidLedger:async()=>({customer_escrow:'900'}),
    getPaidJob:async()=>({id:3,status:'UNCERTAIN'})};
  const result=await inspectOutlayer({sdk,tokenId:'nfa-1',jobIds:[3]});
  assert.deepEqual(result.alerts,['vault_low_runway','job_needs_reconciliation']);
  assert.equal(result.ledger.customer_escrow,'900');
});

test('keeper journal prevents replay after an ambiguous send',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'nfa-keeper-'));
  const journal=new KeeperJournal(directory);
  const input=JSON.stringify({question:'What is NFA?',sources:[]});
  const hash='sha256:'+createHash('sha256').update(input).digest('hex');
  const sdk={get:async()=>({lifecycle:'ACTIVE'}),getServiceJob:async()=>({service_id:'scout',job:{status:'REQUESTED',
    input_hash:hash,version_key:'a'.repeat(64),deadline_ns:(BigInt(Date.now())*1_000_000n+10_000_000_000n).toString()}}),
    getOutlayerProject:async()=>({state:'READY',version_key:'a'.repeat(64)}),
    startServiceJob:()=>({methodName:'start_service_job'})};
  let sends=0;
  const wallet={signAndSendTransaction:async()=>{sends++;throw Error('RPC timed out')}};
  try{
    await assert.rejects(()=>triggerPaidService({sdk,wallet,tokenId:'nfa-1',jobId:3,inputData:input,
      service:'scout',journal}),/RPC timed out/);
    assert.equal((await journal.get('nfa-1',3)).status,'UNCERTAIN');
    assert.equal((await triggerPaidService({sdk,wallet,tokenId:'nfa-1',jobId:3,inputData:input,
      service:'scout',journal})).status,'reconcile_required');
    assert.equal(sends,1);
  }finally{await rm(directory,{recursive:true,force:true})}
});

test('keeper reconciliation observes confirmed progress and preserves unresolved work',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'nfa-keeper-reconcile-'));
  const journal=new KeeperJournal(directory),hash='sha256:'+'a'.repeat(64);
  let status='REQUESTED';
  const sdk={getServiceJob:async()=>({service_id:'compare',job:{input_hash:hash,status}})};
  try{
    await journal.claim('nfa-2',4,hash,'compare');
    await journal.record('nfa-2',4,'UNCERTAIN','tx-hash');
    assert.deepEqual(await reconcileKeeperIntent({sdk,journal,tokenId:'nfa-2',jobId:4}),
      {status:'unresolved',jobId:4,chainStatus:'REQUESTED',transaction:'tx-hash',action:'inspect_transaction_and_deadline'});
    status='RECONCILING';
    assert.equal((await reconcileKeeperIntent({sdk,journal,tokenId:'nfa-2',jobId:4})).status,'unresolved');
    status='FINALIZED';
    assert.equal((await reconcileKeeperIntent({sdk,journal,tokenId:'nfa-2',jobId:4})).status,'observed');
    assert.deepEqual(await journal.get('nfa-2',4),{tokenId:'nfa-2',jobId:4,inputHash:hash,
      service:'compare',status:'OBSERVED',transaction:'tx-hash'});
    await assert.rejects(()=>reconcileKeeperIntent({sdk:{getServiceJob:async()=>({service_id:'scout',job:{input_hash:hash,status}})},
      journal,tokenId:'nfa-2',jobId:4}),/does not match/);
  }finally{await rm(directory,{recursive:true,force:true})}
});
