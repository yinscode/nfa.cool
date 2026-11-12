import test from 'node:test';
import assert from 'node:assert/strict';
import {NfaSdk} from '../dist/index.js';

const view={nft_token:{owner_id:'alice.testnet'},agent:{vault_id:'nfa-1.registry.testnet',epoch:2,
  lifecycle:'Active',manifest_hash:'sha256:'+'a'.repeat(64),manifest_uri:'nfa://manifest',next_op_id:2},
  agent_income:'100',listing:null,derived_wallet:null,operation:{id:1,epoch:2,kind:'JOB',status:'Finalized',
    requested_by:'customer.testnet',recipient:'nfa-1.registry.testnet',amount:'100'}};
const fetchImpl=async(_url,init)=>{
  const {params}=JSON.parse(init.body);
  const value=view[params.method_name];
  return {ok:true,json:async()=>({result:{result:[...Buffer.from(JSON.stringify(value))]}})};
};
test('SDK maps views and prepares wallet-signed actions without custody',async()=>{
  const sent=[];
  const sdk=new NfaSdk({registryAccountId:'registry.testnet',rpcUrl:'https://rpc.invalid',fetchImpl,
    wallet:{signAndSendTransaction:async action=>{sent.push(action);return {ok:true}}}});
  assert.equal((await sdk.get('nfa-1')).ownerAccountId,'alice.testnet');
  assert.equal((await sdk.getHistory('nfa-1'))[0].status,'FINALIZED');
  const buy=sdk.buy('nfa-1',3,'100');
  assert.equal(buy.deposit,'100');assert.equal(buy.args.expected_nonce,3);
  const job=sdk.runJob('nfa-1','sha256:'+'a'.repeat(64),'sha256:'+'b'.repeat(64),'10000000000000000000000',Date.now()*1e6+1e12);
  assert.equal(job.methodName,'request_scout_job');
  await sdk.send(buy);assert.equal(sent.length,1);
});
test('SDK requires a wallet for writes and rejects malformed sale input',async()=>{
  const sdk=new NfaSdk({registryAccountId:'registry.testnet',rpcUrl:'https://rpc.invalid',fetchImpl});
  assert.throws(()=>sdk.buy('nfa-1',0,'100'),/nonce/);
  assert.throws(()=>sdk.buy('nfa-1',1,'1.2'),/decimal/);
  await assert.rejects(()=>sdk.send(sdk.prepareTransfer('nfa-1','bob.testnet')),/Wallet required/);
});
