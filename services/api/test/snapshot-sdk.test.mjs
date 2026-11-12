import test from 'node:test';
import assert from 'node:assert/strict';
import {snapshotSdk} from '../snapshot-sdk.mjs';
test('page reads coalesce repeated views without carrying stale authority into another request',async()=>{
  let owner='alice.testnet',reads=0;
  const sdk={async view(account,method,args){reads++;await Promise.resolve();return {account,method,args,owner}},
    get(){return this.view('registry.testnet','nft_token',{token_id:'nfa-1'})}};
  const first=snapshotSdk(sdk),[a,b]=await Promise.all([first.get(),first.get()]);
  assert.equal(reads,1);assert.equal(a.owner,b.owner);
  owner='bob.testnet';const second=await snapshotSdk(sdk).get();assert.equal(second.owner,'bob.testnet');assert.equal(reads,2);
  assert.equal((await sdk.get()).owner,'bob.testnet');assert.equal(reads,3);
});
