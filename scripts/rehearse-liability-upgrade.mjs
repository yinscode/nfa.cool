#!/usr/bin/env node
// Upgrade the exact deployed predecessor bytes with outstanding income and credits.
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createServer} from 'node:net';
import assert from 'node:assert/strict';
import {connect,KeyPair,keyStores} from 'near-api-js';
import {NfaSdk} from '@nfa/sdk';
import {startSandbox} from './sandbox-check.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const pause=ms=>new Promise(done=>setTimeout(done,ms));
const port=()=>new Promise(done=>{const s=createServer();s.listen(0,'127.0.0.1',()=>{const value=s.address().port;s.close(()=>done(value))})});
const home=await mkdtemp(join(tmpdir(),'nfa-liability-upgrade-'));let child;
try{
  const a=await port(),b=await port();
  const sandbox=await startSandbox(process.env.NEAR_SANDBOX_BIN_PATH||'.deps/bin/near-sandbox',home,a,b);child=sandbox.child;
  const rootKey=JSON.parse(await readFile(join(home,'validator_key.json'))),keys=new keyStores.InMemoryKeyStore();
  await keys.setKey('sandbox','test.near',KeyPair.fromString(rootKey.secret_key));
  const node=await connect({networkId:'sandbox',nodeUrl:sandbox.rpcUrl,deps:{keyStore:keys}}),root=await node.account('test.near');
  const registryId='registry.test.near';
  for(const name of ['registry','alice','bob','customer','worker']){
    const id=`${name}.test.near`,key=KeyPair.fromRandom('ed25519');
    await root.createAccount(id,key.getPublicKey(),30n*10n**24n);await keys.setKey('sandbox',id,key);
  }
  const actors=Object.fromEntries(await Promise.all(['registry','alice','bob','customer','worker'].map(async n=>[n,await node.account(`${n}.test.near`)])));
  const oldCode=await readFile('releases/nfa-registry-research-3547ac6018aa2d5e.wasm');
  const newCode=await readFile('releases/nfa-registry-reviewed-0f02c8a935199f99.wasm');
  const newVault=await readFile('releases/nfa-vault-reviewed-200821c58802e52a.wasm');
  await actors.registry.deployContract(oldCode);
  const call=(who,method,args,deposit=0n)=>who.functionCall({contractId:registryId,methodName:method,args,
    gas:250_000_000_000_000n,attachedDeposit:deposit});
  await call(actors.registry,'new',{admin:registryId,guardian:registryId,reporter:registryId});
  await call(actors.alice,'create_agent',{request_id:'liability-upgrade',manifest_hash:'sha256:'+'a'.repeat(64),manifest_uri:'nfa://upgrade'},6n*10n**24n);
  const sdk=new NfaSdk({registryAccountId:registryId,rpcUrl:sandbox.rpcUrl});
  let identity;for(let i=0;i<80;i++){try{identity=await sdk.get('nfa-1');break}catch{await pause(250)}}
  assert.ok(identity,'Predecessor must mint before migration');
  const token_id='nfa-1',yocto=10n**24n;
  await call(actors.alice,'list_agent',{token_id,price:(yocto/1000n).toString()},1n);
  let listing;for(let i=0;i<40;i++){listing=await sdk.view(registryId,'listing',{token_id});if(listing)break;await pause(250)}
  assert.ok(listing,'Old listing must finalize');
  await call(actors.bob,'buy',{token_id,expected_nonce:listing.nonce},yocto/1000n);
  await call(actors.bob,'grant_delegate',{token_id,delegate:'worker.test.near',method:'SCOUT_RUN',recipient:null,
    budget:'2',expires_at_ns:Date.now()*1e6+3600e9},1n);
  const request=async(deadline)=>{
    const result=await call(actors.customer,'request_scout_job',{token_id,brief_hash:'sha256:'+'b'.repeat(64),
      source_hash:'sha256:'+'c'.repeat(64),deadline_ns:deadline,fee:(3n*yocto/100n).toString()},3n*yocto/100n);
    return Number(JSON.parse(Buffer.from(result.status.SuccessValue,'base64').toString()));
  };
  const finished=await request(Date.now()*1e6+600e9);
  await call(actors.worker,'complete_scout_job',{token_id,id:finished,expected_epoch:1,
    output_hash:'sha256:'+'d'.repeat(64),output_uri:'nfa://work/rehearsal'});
  const refunded=await request(Date.now()*1e6+3e9);
  await pause(3500);await call(actors.worker,'abort_scout_job',{token_id,id:refunded});
  await call(actors.alice,'create_agent',{request_id:'pending-escrow',manifest_hash:'sha256:'+'e'.repeat(64),manifest_uri:'nfa://escrow'},6n*yocto);
  for(let i=0;i<80;i++){try{await sdk.get('nfa-2');break}catch{await pause(250)}}
  const escrow=3n*yocto/100n;
  await call(actors.customer,'request_scout_job',{token_id:'nfa-2',brief_hash:'sha256:'+'f'.repeat(64),
    source_hash:'sha256:'+'a'.repeat(64),deadline_ns:Date.now()*1e6+600e9,fee:escrow.toString()},escrow);
  let before,income,payouts;
  for(let i=0;i<60;i++){
    before=await sdk.get(token_id);
    income=BigInt((await sdk.view(registryId,'agent_income',{token_id})).toString());
    payouts={};for(const name of ['alice.test.near','customer.test.near'])
      payouts[name]=await sdk.view(registryId,'payout',{seller:name});
    if(income>0n&&BigInt(payouts['alice.test.near'].available)>0n&&BigInt(payouts['customer.test.near'].available)>0n)break;
    await pause(250);
  }
  const payoutTotal=Object.values(payouts).reduce((sum,p)=>sum+BigInt(p.available),0n);
  assert.ok(income>0n&&BigInt(payouts['alice.test.near'].available)>0n&&BigInt(payouts['customer.test.near'].available)>0n);
  const upgrade=await actors.registry.deployContract(newCode);
  let required;for(let i=0;i<80;i++){
    try{required=await sdk.view(registryId,'liability_migration_required');break}catch{await pause(250)}
  }
  assert.equal(required,true);
  await assert.rejects(call(actors.alice,'withdraw_proceeds',{amount:'1'},1n));
  const migrated=await call(actors.registry,'migrate_liabilities',{payout_accounts:Object.keys(payouts),
    expected_payouts:payoutTotal.toString(),expected_total:(payoutTotal+income+escrow).toString()});
  let ledger;for(let i=0;i<80;i++){
    try{ledger=await sdk.view(registryId,'registry_ledger');break}catch{await pause(250)}
  }
  assert.ok(ledger,'Migration must finalize');
  assert.equal(BigInt(ledger.liabilities),payoutTotal+income+escrow);
  assert.equal(await sdk.view(registryId,'liability_migration_required'),false);
  const after=await sdk.get(token_id);
  assert.equal(after.ownerAccountId,before.ownerAccountId);assert.equal(after.ownerEpoch,before.ownerEpoch);
  assert.equal(after.vaultAccountId,before.vaultAccountId);assert.equal(after.manifestHash,before.manifestHash);
  assert.equal(after.income,before.income);
  const result={oldCodeSha256:sha(oldCode),newCodeSha256:sha(newCode),vaultCodeSha256:sha(newVault),
    localUpgradeTransaction:upgrade.transaction.hash,localMigrationTransaction:migrated.transaction.hash,
    balances:{income:income.toString(),escrow:escrow.toString(),payouts,payoutTotal:payoutTotal.toString(),liabilities:ledger.liabilities},
    preserved:{owner:after.ownerAccountId,epoch:after.ownerEpoch,vault:after.vaultAccountId,manifestHash:after.manifestHash},
    assertions:['deployed exact prior testnet registry bytes','finalized legacy work to create income',
      'expired legacy work to create a refund credit','sold NFA to create a seller credit',
      'new code blocked withdrawal before migration','one-time migration included escrow, income, refund and seller credits',
      'owner, epoch, vault, manifest and income survived registry upgrade']};
  await writeFile('docs/evidence/liability-upgrade-rehearsal.json',JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result,null,2));
}finally{if(child){child.kill();await new Promise(done=>{child.once('exit',done);setTimeout(done,3000).unref()})}
  await rm(home,{recursive:true,force:true,maxRetries:5,retryDelay:100})}
