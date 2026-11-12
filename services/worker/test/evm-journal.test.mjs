import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EvmJournal,submitAndObserve} from '../evm-journal.mjs';

test('RPC timeout keeps exact signed tx durable for replay, with no new signature',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'nfa-evm-'));
  try{
    const journal=new EvmJournal(directory),signed={raw:'0x02c0',nonce:0,sender:'0x'+'a'.repeat(40)};
    let attempts=0;
    const result=await submitAndObserve({journal,tokenId:'nfa-1',id:1,signed,rpcUrl:'https://rpc.invalid',
      fetchImpl:async()=>{attempts++;throw Error('timeout')}});
    assert.equal(result.state,'UNCERTAIN');assert.equal(attempts,1);
    assert.equal((await journal.get('nfa-1',1)).state,'SIGNED');
    await assert.rejects(()=>journal.saveSigned('nfa-1',1,{...signed,raw:'0x02c1'}),/Conflicting/);
    assert.equal((await journal.saveSigned('nfa-1',1,signed)).hash,result.hash);
  }finally{await rm(directory,{recursive:true,force:true})}
});
