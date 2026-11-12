import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {InputStore} from '../input-store.mjs';

test('paid Scout input can be reloaded after worker restart by its on-chain hashes',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'nfa-input-'));
  const input={question:'How does agent ownership retain income?',sources:[
    {title:'Income',url:'https://example.org/income',text:'The agent ownership NFT retains unclaimed income in a registry ledger. The new owner can claim that income after transfer.'}]};
  try{const first=new InputStore(directory),hashes=await first.put(input);
    assert.deepEqual(await new InputStore(directory).get(hashes.briefHash,hashes.sourceHash),input);
  }finally{await rm(directory,{recursive:true,force:true})}
});
