#!/usr/bin/env node
// Rehearse the exact deployed registry/vault predecessor bytes in an isolated NEAR sandbox.
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
const home=await mkdtemp(join(tmpdir(),'nfa-payment-key-upgrade-'));let child;
try{
  const sandbox=await startSandbox(process.env.NEAR_SANDBOX_BIN_PATH||'.deps/bin/near-sandbox',home,await port(),await port());child=sandbox.child;
  const rootKey=JSON.parse(await readFile(join(home,'validator_key.json'))),keys=new keyStores.InMemoryKeyStore();
  await keys.setKey('sandbox','test.near',KeyPair.fromString(rootKey.secret_key));
  const node=await connect({networkId:'sandbox',nodeUrl:sandbox.rpcUrl,deps:{keyStore:keys}}),root=await node.account('test.near');
  for(const name of ['registry','alice']){
    const id=`${name}.test.near`,key=KeyPair.fromRandom('ed25519');
    await root.createAccount(id,key.getPublicKey(),30n*10n**24n);await keys.setKey('sandbox',id,key);
  }
  const registry=await node.account('registry.test.near'),alice=await node.account('alice.test.near');
  const oldRegistry=await readFile('releases/nfa-registry-hiring-b733b54b7ea955c6.wasm');
  const oldVault=await readFile('releases/nfa-vault-reviewed-200821c58802e52a.wasm');
  const newRegistry=await readFile('judge/wasm/registry.wasm'),newVault=await readFile('judge/wasm/vault.wasm');
  await registry.deployContract(oldRegistry);
  const call=(account,receiver,method,args,deposit=0n)=>account.functionCall({contractId:receiver,methodName:method,args,
    gas:300_000_000_000_000n,attachedDeposit:deposit});
  await call(registry,registry.accountId,'new',{admin:registry.accountId,guardian:registry.accountId,reporter:registry.accountId});
  await call(alice,registry.accountId,'create_agent',{request_id:'key-upgrade',manifest_hash:'sha256:'+'a'.repeat(64),
    manifest_uri:'nfa://payment-key-upgrade'},6n*10n**24n);
  const sdk=new NfaSdk({registryAccountId:registry.accountId,rpcUrl:sandbox.rpcUrl});
  let before;for(let i=0;i<60;i++){try{before=await sdk.get('nfa-1');break}catch{await pause(250)}}
  assert.ok(before,'Old registry must mint an NFA');
  const vaultId=before.vaultAccountId;
  const beforeStatus=await sdk.view(vaultId,'status');
  const predecessorCode=await node.connection.provider.query({request_type:'view_code',account_id:vaultId,finality:'final'});
  assert.equal(sha(Buffer.from(predecessorCode.code_base64,'base64')),sha(oldVault));
  await registry.deployContract(newRegistry);
  let afterRegistry;for(let i=0;i<50;i++){try{afterRegistry=await sdk.get('nfa-1');break}catch{await pause(250)}}
  assert.equal(afterRegistry.ownerAccountId,before.ownerAccountId);
  assert.equal(afterRegistry.ownerEpoch,before.ownerEpoch);
  assert.equal(afterRegistry.vaultAccountId,vaultId);
  assert.equal(afterRegistry.manifestHash,before.manifestHash);
  assert.equal(await sdk.view(registry.accountId,'liability_migration_required'),false);
  const codeHash=sha(newVault);
  await call(registry,vaultId,'propose_upgrade',{code_hash:codeHash});
  await call(alice,registry.accountId,'approve_vault_upgrade',{token_id:'nfa-1',code_hash:codeHash},1n);
  await call(registry,vaultId,'emergency_upgrade',{code:newVault.toString('base64')});
  let upgradedCode;for(let i=0;i<60;i++){
    const row=await node.connection.provider.query({request_type:'view_code',account_id:vaultId,finality:'final'});
    upgradedCode=Buffer.from(row.code_base64,'base64');if(sha(upgradedCode)===codeHash)break;await pause(250);
  }
  assert.equal(sha(upgradedCode),codeHash,'Owner-approved vault upgrade must deploy exact bytes');
  const afterStatus=await sdk.view(vaultId,'status');
  assert.equal(afterStatus.controller,beforeStatus.controller);
  assert.equal(afterStatus.next_operation_id,beforeStatus.next_operation_id);
  assert.equal(afterStatus.pending,beforeStatus.pending);
  assert.equal(afterStatus.next_evm_nonce,beforeStatus.next_evm_nonce);
  assert.equal(afterStatus.last_receipt,beforeStatus.last_receipt);
  assert.equal((await sdk.get('nfa-1')).ownerAccountId,before.ownerAccountId);
  assert.equal(await sdk.view(registry.accountId,'payment_key_setup',{token_id:'nfa-1'}),null);
  const result={scope:'local-sandbox-upgrade-only',oldRegistryHash:sha(oldRegistry),newRegistryHash:sha(newRegistry),
    oldVaultHash:sha(oldVault),newVaultHash:codeHash,preserved:{owner:before.ownerAccountId,epoch:before.ownerEpoch,
      vault:vaultId,manifestHash:before.manifestHash,nextOperationId:beforeStatus.next_operation_id,
      nextEvmNonce:beforeStatus.next_evm_nonce},
    assertions:['deployed exact prior testnet registry and vault bytes','registry root state preserved',
      'owner-approved guardian vault upgrade deployed exact new bytes','vault identity and operation state preserved',
      'new Payment Key setup storage starts empty']};
  await writeFile('docs/evidence/payment-key-upgrade-rehearsal.json',JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result,null,2));
}finally{
  if(child){child.kill();await new Promise(done=>{child.once('exit',done);setTimeout(done,3000).unref()})}
  await rm(home,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
