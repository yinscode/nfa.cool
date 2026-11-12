import test from 'node:test';
import assert from 'node:assert/strict';
import {NfaSdk} from '../dist/index.js';

test('SDK binds platform fetch to the global receiver used by browsers',async()=>{
  const sdk=new NfaSdk({registryAccountId:'registry.testnet',rpcUrl:'https://rpc.invalid',fetchImpl:async function(){
    assert.equal(this,globalThis);return {ok:true,json:async()=>({result:{result:[...Buffer.from('null')]}})};
  }});
  assert.equal(await sdk.view('registry.testnet','nft_token',{token_id:'nfa-1'}),null);
});
