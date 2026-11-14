#!/usr/bin/env node
// Upgrade exact live predecessor bytes in an isolated sandbox with paid state.
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createServer} from 'node:net';
import assert from 'node:assert/strict';
import {connect,KeyPair,keyStores} from 'near-api-js';
import {NfaSdk} from '@nfa/sdk';
import {startSandbox} from './sandbox-check.mjs';

const sha=b=>createHash('sha256').update(b).digest('hex');
const pause=ms=>new Promise(done=>setTimeout(done,ms));
const port=()=>new Promise(done=>{const s=createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>done(p))})});
const recovery=process.argv[2]==='recovery';
if(process.argv[2]&&!recovery)throw Error('Use optional recovery mode');
const old=await readFile(recovery?'releases/nfa-registry-async-f989bfe9bc179b14.wasm':
  'releases/nfa-registry-payment-key-5a6f3f0b37c0a217.wasm');
const next=await readFile(recovery?'releases/nfa-registry-async-recovery-f9c750ad48e369b7.wasm':
  'releases/nfa-registry-async-f989bfe9bc179b14.wasm');
if(sha(old)!==(recovery?'f989bfe9bc179b14b4272334f4f819663df5d5186132a88a03eb3f01de3acae4':
  '5a6f3f0b37c0a2178c65ba48018366da62f220b22881a02eac07ad8470f71fbb')||
  sha(next)!==(recovery?'f9c750ad48e369b79e65f3de6c6533602b09658c3202e389d96dbfba154c1353':
  'f989bfe9bc179b14b4272334f4f819663df5d5186132a88a03eb3f01de3acae4'))
  throw Error('Pinned registry release bytes changed');
const home=await mkdtemp(join(tmpdir(),'nfa-async-upgrade-'));let child;
try{
  const sandbox=await startSandbox(process.env.NEAR_SANDBOX_BIN_PATH||'.deps/bin/near-sandbox',home,await port(),await port());child=sandbox.child;
  const rootKey=JSON.parse(await readFile(join(home,'validator_key.json'))),keys=new keyStores.InMemoryKeyStore();
  await keys.setKey('sandbox','test.near',KeyPair.fromString(rootKey.secret_key));
  const node=await connect({networkId:'sandbox',nodeUrl:sandbox.rpcUrl,deps:{keyStore:keys}}),root=await node.account('test.near');
  for(const name of ['registry','alice','bob','customer']){
    const id=`${name}.test.near`,key=KeyPair.fromRandom('ed25519');
    await root.createAccount(id,key.getPublicKey(),30n*10n**24n);await keys.setKey('sandbox',id,key);
  }
  const [registry,alice,bob,customer]=await Promise.all(['registry','alice','bob','customer'].map(n=>node.account(`${n}.test.near`)));
  const call=(account,receiver,method,args,deposit=0n,gas=250_000_000_000_000n)=>account.functionCall({
    contractId:receiver,methodName:method,args,gas,attachedDeposit:deposit});
  await registry.deployContract(old);
  await call(registry,registry.accountId,'new',{admin:registry.accountId,guardian:registry.accountId,reporter:registry.accountId});
  await call(alice,registry.accountId,'create_agent',{request_id:'async-upgrade',manifest_hash:'sha256:'+'a'.repeat(64),
    manifest_uri:'nfa://async-upgrade'},6n*10n**24n);
  const sdk=new NfaSdk({registryAccountId:registry.accountId,rpcUrl:sandbox.rpcUrl});
  let identity;for(let i=0;i<60;i++){try{identity=await sdk.get('nfa-1');break}catch{await pause(250)}}
  assert.ok(identity,'Predecessor must mint an NFA');
  const token_id='nfa-1',vault=identity.vaultAccountId;
  const vaultBefore=await sdk.view(vault,'status');
  await call(alice,registry.accountId,'list_agent',{token_id,price:'1000000000000000000000'},1n);
  let listing;for(let i=0;i<60;i++){listing=await sdk.view(registry.accountId,'listing',{token_id});if(listing)break;await pause(250)}
  assert.ok(listing,'Listing must finalize');
  await call(bob,registry.accountId,'buy',{token_id,expected_nonce:listing.nonce},BigInt(listing.price));
  const job=await call(customer,registry.accountId,'request_scout_job',{token_id,brief_hash:'sha256:'+'b'.repeat(64),
    source_hash:'sha256:'+'c'.repeat(64),deadline_ns:Math.trunc((Date.now()+600000)*1e6),fee:'30000000000000000000000'},
    30_000_000_000_000_000_000_000n);
  const jobId=Number(JSON.parse(Buffer.from(job.status.SuccessValue,'base64').toString()));
  let before;for(let i=0;i<60;i++){
    before={identity:await sdk.get(token_id),vaultStatus:await sdk.view(vault,'status'),
      ledger:await sdk.view(registry.accountId,'registry_ledger'),
      sellerCredit:await sdk.view(registry.accountId,'payout',{seller:alice.accountId}),
      paidJob:await sdk.getJob(token_id,jobId)};
    if(before.paidJob&&BigInt(before.ledger.liabilities)>=31_000_000_000_000_000_000_000n)break;
    await pause(250);
  }
  assert.ok(BigInt(before.ledger.liabilities)>0n&&BigInt(before.sellerCredit.available)>0n);
  await call(registry,registry.accountId,'propose_registry_upgrade',{code_hash:sha(next)});
  await assert.rejects(call(registry,registry.accountId,'apply_registry_upgrade',Buffer.alloc(0),0n,300_000_000_000_000n),
    'Public delay must reject an early apply');
  const upgrade=await registry.deployContract(next);
  if(upgrade.status?.Failure)throw Error(`Sandbox deploy failed: ${JSON.stringify(upgrade.status.Failure)}`);
  for(let i=0;i<60;i++){
    try{await sdk.view(registry.accountId,'async_research_job',{token_id,id:jobId});break}
    catch(error){if(i===59)throw error;await pause(250)}
  }
  const after={identity:await sdk.get(token_id),vaultStatus:await sdk.view(vault,'status'),
    ledger:await sdk.view(registry.accountId,'registry_ledger'),
    sellerCredit:await sdk.view(registry.accountId,'payout',{seller:alice.accountId}),
    paidJob:await sdk.getJob(token_id,jobId)};
  assert.deepEqual(after,before,'Exact predecessor owner, balances, escrow, vault and job must persist');
  assert.equal(await sdk.view(registry.accountId,'async_research_job',{token_id,id:jobId}),null);
  await call(registry,registry.accountId,'cancel_registry_upgrade',{});
  let proposal;for(let i=0;i<60;i++){
    proposal=(await sdk.view(registry.accountId,'authorities')).registry_upgrade;
    if(proposal===null)break;await pause(250);
  }
  assert.equal(proposal,null);
  const result={checkedAt:new Date().toISOString(),scope:'Local sandbox; exact testnet predecessor bytes',
    oldHash:sha(old),newHash:sha(next),preserved:{owner:before.identity.ownerAccountId,
      epoch:before.identity.ownerEpoch,vault,liabilities:before.ledger.liabilities,
      sellerCredit:before.sellerCredit.available,paidJobId:jobId},
    assertions:['old release minted the same keyless vault','seller credit and customer escrow existed before upgrade',
      'early public apply was rejected','direct sandbox deployment preserved identity, balances, vault state and paid job',
      'new async storage starts empty','stale proposal was cancelled']};
  await writeFile(recovery?'docs/evidence/async-research-recovery-upgrade-rehearsal.json':
    'docs/evidence/async-research-upgrade-rehearsal.json',JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result));
}finally{
  if(child){child.kill();await new Promise(done=>{child.once('exit',done);setTimeout(done,3000).unref()})}
  await rm(home,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
