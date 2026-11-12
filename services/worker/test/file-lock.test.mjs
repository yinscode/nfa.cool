import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,utimes,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {withFileLock} from '../file-lock.mjs';
import {EvmJournal} from '../evm-journal.mjs';
import {NearIntentWallet,INTENT_EXPIRY_MS} from '../near-intent.mjs';

const dir=()=>mkdtemp(join(tmpdir(),'nfa-lock-'));
test('a crashed writer\'s lock is reclaimed and a live holder is waited for',async()=>{
  const d=await dir();
  try{
    const lock=join(d,'x.lock');
    await writeFile(lock,JSON.stringify({pid:2147483646}));               // no such process
    assert.equal(await withFileLock(lock,async()=>'ran'),'ran');
    await writeFile(lock,'');const old=(Date.now()-120_000)/1000;await utimes(lock,old,old); // legacy empty lock, crashed
    assert.equal(await withFileLock(lock,async()=>'legacy'),'legacy');
    await writeFile(lock,JSON.stringify({pid:process.pid}));               // live holder (this process)
    await assert.rejects(()=>withFileLock(lock,async()=>'never',{waitMs:200}),/live process/);
  }finally{await rm(d,{recursive:true,force:true})}
});
test('settlement journal writes proceed after a crash left its lock behind',async()=>{
  const d=await dir();
  try{
    const journal=new EvmJournal(d),signed={raw:'0x02c0',nonce:0,sender:'0x'+'b'.repeat(40)};
    const record=await journal.saveSigned('nfa-1',1,signed);
    await writeFile(join(d,'nfa-1-1.json.lock'),JSON.stringify({pid:2147483646}));
    await journal.write('nfa-1',1,{...record,state:'BROADCAST'});
    assert.equal((await journal.get('nfa-1',1)).state,'BROADCAST');
  }finally{await rm(d,{recursive:true,force:true})}
});
test('an intent past NEAR\'s validity window is retired and signed again',async()=>{
  const d=await dir();let now=1_000_000,signed=0;
  try{
    const opts={directory:d,accountId:'reporter.testnet',now:()=>now,
      sign:async()=>({hash:`h${++signed}`,signedTxBase64:`bytes${signed}`}),rpc:async()=>{throw Error('unknown')}};
    const action={receiverId:'registry.testnet',methodName:'reconcile_evm',args:{token_id:'nfa-1',id:1},deposit:'0'};
    assert.equal((await new NearIntentWallet(opts).send('nfa-1-1-reconcile',action)).hash,'h1');
    assert.equal((await new NearIntentWallet(opts).send('nfa-1-1-reconcile',action)).hash,'h1','replays inside the window');
    now+=INTENT_EXPIRY_MS+1;
    assert.equal((await new NearIntentWallet(opts).send('nfa-1-1-reconcile',action)).hash,'h2');
    assert.ok((await readdir(d)).some(f=>f.startsWith('nfa-1-1-reconcile.expired-')),'retired intent kept for audit');
    assert.equal(signed,2);
  }finally{await rm(d,{recursive:true,force:true})}
});
