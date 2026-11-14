#!/usr/bin/env node
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:net';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {connect,KeyPair,keyStores} from 'near-api-js';
import {NfaSdk} from '@nfa/sdk';
import {startSandbox} from './sandbox-check.mjs';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const port=()=>new Promise(resolve=>{const server=createServer();server.listen(0,'127.0.0.1',()=>{const p=server.address().port;server.close(()=>resolve(p))})});
const home=await mkdtemp(join(tmpdir(),'nfa-upgrade-'));let child;
try{
  const {child:running,rpcUrl}=await startSandbox(process.env.NEAR_SANDBOX_BIN_PATH,home,await port(),await port());child=running;
  const rootKey=JSON.parse(await readFile(join(home,'validator_key.json'))),keys=new keyStores.InMemoryKeyStore();
  await keys.setKey('sandbox','test.near',KeyPair.fromString(rootKey.secret_key));
  const node=await connect({networkId:'sandbox',nodeUrl:rpcUrl,deps:{keyStore:keys}}),root=await node.account('test.near');
  const registryId='registry.test.near',aliceId='alice.test.near';
  for(const [id,balance] of [[registryId,30n],[aliceId,20n]]){const key=KeyPair.fromRandom('ed25519');
    await root.createAccount(id,key.getPublicKey(),balance*10n**24n);await keys.setKey('sandbox',id,key)}
  const registry=await node.account(registryId),alice=await node.account(aliceId);
  const oldCode=await readFile(resolve(process.env.NFA_PREVIOUS_REGISTRY_WASM||'releases/nfa-registry-before-studio-253e5b15693b624b.wasm'));
  const newCode=await readFile(resolve(process.env.NFA_NEW_REGISTRY_WASM||'contracts/registry/target/wasm32-unknown-unknown/release/nfa_registry_opt.wasm'));
  const newVault=resolve(process.env.NFA_NEW_VAULT_WASM||'contracts/vault-v2/target/wasm32-unknown-unknown/release/nfa_vault_opt.wasm');
  await registry.deployContract(oldCode);
  const call=(who,method,args,deposit=0n)=>who.functionCall({contractId:registryId,methodName:method,args,gas:250_000_000_000_000n,attachedDeposit:deposit});
  await call(registry,'new',{admin:registryId,guardian:registryId,reporter:registryId});
  await call(alice,'create_agent',{request_id:'old-state',manifest_hash:'sha256:'+'a'.repeat(64),manifest_uri:'nfa://manifest/old-state'},6n*10n**24n);
  const sdk=new NfaSdk({registryAccountId:registryId,rpcUrl});let before;
  for(let i=0;i<50;i++){before=await sdk.view(registryId,'agent',{token_id:'nfa-1'});if(before)break;await pause(200)}
  assert.ok(before,'Old contract must mint before upgrade');
  const nft=await sdk.view(registryId,'nft_token',{token_id:'nfa-1'});
  const upgraded=await registry.deployContract(newCode);let after;
  for(let i=0;i<50;i++){
    try{if(await sdk.view(registryId,'liability_migration_required'))break}catch{}
    await pause(200);
  }
  await call(registry,'migrate_liabilities',{payout_accounts:[],expected_payouts:'0',expected_total:'0'});
  for(let i=0;i<50;i++){try{after=await sdk.get('nfa-1');break}catch{await pause(200)}}
  assert.equal(after.ownerAccountId,nft.owner_id);assert.equal(after.ownerEpoch,before.epoch);
  assert.equal(after.vaultAccountId,before.vault_id);assert.equal(after.manifestHash,before.manifest_hash);
  const researchSupported=await sdk.view(registryId,'research_vault_capable',{token_id:'nfa-1'}).catch(()=>null);
  if(researchSupported!==null)assert.equal(researchSupported,false,'Old vault must not silently gain research capability');
  let vaultUpgrade;
  if(researchSupported!==null){
    const oldStatus=await sdk.view(after.vaultAccountId,'status');
    assert.equal(oldStatus.research_interface,undefined);
    await call(alice,'verify_research_vault',{token_id:'nfa-1'},1n);
    assert.equal(await sdk.view(registryId,'research_vault_capable',{token_id:'nfa-1'}),false);
    const vaultCode=await readFile(newVault);
    vaultUpgrade=await registry.functionCall({contractId:after.vaultAccountId,methodName:'emergency_upgrade',
      args:{code:vaultCode.toString('base64')},gas:100_000_000_000_000n,attachedDeposit:0n});
    // Views read final state, which can trail the executed deployment by a block or two.
    let newStatus;for(let i=0;i<50;i++){newStatus=await sdk.view(after.vaultAccountId,'status');if(newStatus.research_interface!=null)break;await pause(200)}
    assert.equal(newStatus.research_interface,1);
    // Fields added by newer vault code are new views of separate storage, not migrated state.
    const {research_interface,recovery_interface,last_near,upgrade_proposal,...preserved}=newStatus;assert.deepEqual(preserved,oldStatus);
    assert.equal(last_near??null,null);assert.equal(upgrade_proposal??null,null);
    await call(alice,'verify_research_vault',{token_id:'nfa-1'},1n);
    let capable=false;for(let i=0;i<50&&!capable;i++){capable=await sdk.view(registryId,'research_vault_capable',{token_id:'nfa-1'});if(!capable)await pause(200)}
    assert.equal(capable,true);
  }
  await call(alice,'create_agent',{request_id:'new-state',manifest_hash:'sha256:'+'b'.repeat(64),manifest_uri:'nfa://manifest/new-state'},6n*10n**24n);
  let second;for(let i=0;i<50;i++){try{second=await sdk.get('nfa-2');break}catch{await pause(200)}}
  assert.equal(second.ownerAccountId,aliceId);
  assert.ok(BigInt((await sdk.getTreasury('nfa-2')).available)>0n);
  if(researchSupported!==null)assert.equal(await sdk.view(registryId,'research_vault_capable',{token_id:'nfa-2'}),true);
  const result={oldCodeSha256:createHash('sha256').update(oldCode).digest('hex'),newCodeSha256:createHash('sha256').update(newCode).digest('hex'),
    localUpgradeTransaction:upgraded.transaction.hash,localVaultUpgradeTransaction:vaultUpgrade?.transaction.hash,
    vaultCodeSha256:createHash('sha256').update(await readFile(newVault)).digest('hex'),
    oldToken:{owner:after.ownerAccountId,vault:after.vaultAccountId,epoch:after.ownerEpoch},
    assertions:['deployed actual prior testnet WASM','minted old contract state','upgraded without state migration','preserved old NFT owner, epoch, manifest and vault',
      'old vault research probe denied','guardian upgraded old vault and preserved all status fields','owner verified upgraded vault interface','minted funded new vault after upgrade']};
  await writeFile(process.env.NFA_REHEARSAL_OUTPUT||'docs/studio-upgrade-rehearsal.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
}finally{if(child){child.kill();await new Promise(resolve=>{child.once('exit',resolve);setTimeout(resolve,3000).unref()})}await rm(home,{recursive:true,force:true,maxRetries:5,retryDelay:100})}
