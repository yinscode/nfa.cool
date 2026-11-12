import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AccessService,nep413Digest,verifyNearFullAccessKey} from '../access.mjs';
import {WorkStore} from '../work-store.mjs';
import {createScoutBrief} from '../../worker/scout.mjs';
import {ed25519} from '@noble/curves/ed25519';
import {KeyPair,KeyPairSigner,utils} from 'near-api-js';

test('work integrity and access follow the current NFT epoch',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'nfa-work-'));
  try{
    const store=new WorkStore(directory);
    const brief=createScoutBrief({question:'How does an agent retain its treasury?',sources:[
      {title:'Account',url:'https://example.org/account',text:'An agent retains its treasury in the same account after the NFT ownership changes. The new owner can operate the vault through the registry.'}]});
    const stored=await store.put(brief.artifact);
    assert.equal(stored.outputHash,brief.outputHash);
    assert.deepEqual(await store.get(stored.outputHash),brief.artifact);
    let owner='alice.testnet',epoch=0;
    const sdk={registryAccountId:'registry.testnet',get:async()=>({ownerAccountId:owner,ownerEpoch:epoch})};
    const access=new AccessService({sdk,origin:'http://localhost:3000',verifyKey:async()=>true});
    const alice=access.challenge('alice.testnet','nfa-1');
    const session=(await access.authorize({challengeId:alice.challengeId,publicKey:'test',signature:'test'})).session;
    assert.equal(await access.requireOwner(session,'nfa-1'),'alice.testnet');
    owner='bob.testnet';epoch=1;
    await assert.rejects(()=>access.requireOwner(session,'nfa-1'),/Ownership changed/);
    const bob=access.challenge('bob.testnet','nfa-1');
    const bobSession=(await access.authorize({challengeId:bob.challengeId,publicKey:'test',signature:'test'})).session;
    assert.equal(await access.requireOwner(bobSession,'nfa-1'),'bob.testnet');
    await assert.rejects(()=>access.authorize({challengeId:bob.challengeId,publicKey:'test',signature:'test'}),/used/);
  }finally{await rm(directory,{recursive:true,force:true})}
});

test('owner proof verifies NEP-413 digest and a NEAR FullAccess key',async()=>{
  const seed=new Uint8Array(32).fill(7),publicKey='ed25519:'+utils.serialize.base_encode(ed25519.getPublicKey(seed));
  const message='nfa.gent access\nnonce:known',nonce=Buffer.alloc(32,3),recipient='http://127.0.0.1:3000',
    callbackUrl=recipient+'/',signature=Buffer.from(ed25519.sign(nep413Digest({message,nonce,recipient,callbackUrl}),seed)).toString('base64');
  const seen=[];
  const fetchImpl=async (_url,options)=>{seen.push(JSON.parse(options.body).params);return {ok:true,json:async()=>({result:{permission:'FullAccess'}})}};
  const request={rpcUrl:'https://rpc.invalid',accountId:'owner.testnet',publicKey,signature,message,nonce,recipient,callbackUrl,fetchImpl};
  assert.equal(await verifyNearFullAccessKey(request),true);
  assert.equal(seen[0].request_type,'view_access_key');
  assert.equal(seen[0].public_key,publicKey);
  assert.equal(await verifyNearFullAccessKey({...request,message:message+' altered'}),false);
  assert.equal(await verifyNearFullAccessKey({...request,recipient:'https://evil.example'}),false);
  assert.equal(await verifyNearFullAccessKey({...request,fetchImpl:async()=>({ok:true,json:async()=>({result:{permission:{FunctionCall:{receiver_id:'x'}}}})})}),false);
  const nearKey=KeyPair.fromString('ed25519:'+utils.serialize.base_encode(Buffer.concat([seed,ed25519.getPublicKey(seed)])));
  const signed=await new KeyPairSigner(nearKey).signNep413Message(message,'owner.testnet',recipient,nonce,callbackUrl);
  assert.equal(Buffer.from(signed.signature).toString('base64'),signature);
});
