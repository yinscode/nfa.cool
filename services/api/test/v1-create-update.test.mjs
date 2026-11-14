import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApiServer} from '../server.mjs';
import {WorkStore} from '../work-store.mjs';
import {AvatarRenderer} from '../render.mjs';
import {ArtifactStore} from '../artifact-store.mjs';
import {NfaSdk} from '@nfa/sdk';

async function harness(t,{views={},identity}={}){
  const directory=await mkdtemp(join(tmpdir(),'nfa-v1-'));
  const sdk=new NfaSdk({registryAccountId:'registry.testnet',rpcUrl:'https://rpc.invalid'});
  sdk.view=async(_account,method)=>views[method]??null;
  sdk.get=async tokenId=>({tokenId,ownerAccountId:'alice.testnet',ownerEpoch:2,vaultAccountId:`${tokenId}.registry.testnet`,manifestUri:'',manifestHash:null,...identity});
  const server=createApiServer({sdk,store:new WorkStore(join(directory,'work')),access:{},
    renderer:new AvatarRenderer(join(directory,'render')),manifests:new WorkStore(join(directory,'manifests')),
    artifacts:new ArtifactStore(join(directory,'artifacts'))});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true})});
  const base=`http://127.0.0.1:${server.address().port}`;
  return async(path,body)=>{const response=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    return {status:response.status,body:await response.json()}};
}

test('an agent starts a launch: character, manifest and the unsigned mint for the owner',async t=>{
  const post=await harness(t);
  const {status,body}=await post('/v1/launches',{owner:'alice.testnet',name:'Agent Scout',purpose:'both',seed:'agent-scout'});
  assert.equal(status,200,JSON.stringify(body));
  assert.equal(body.step.id,'mint');
  assert.equal(body.signer,'alice.testnet');
  assert.match(body.launch.requestId,/^launch-[0-9a-f]{16}$/);
  assert.deepEqual(body.launch.serviceIds,['scout','compare']);
  assert.equal(body.launch.marginYocto,'10000000000000000000000');
  assert.equal(body.unsignedAction.methodName,'create_agent');
  assert.equal(body.unsignedAction.args.request_id,body.launch.requestId);
  assert.match(body.previewUrl,/^\/preview\/[0-9a-f]{64}\.png$/);
  // Calling next before the mint lands returns the same mint, not a duplicate launch.
  const next=await post('/v1/launches/next',{launch:body.launch});
  assert.equal(next.status,200);
  assert.equal(next.body.step.id,'mint');
  assert.equal(next.body.unsignedAction.args.request_id,body.launch.requestId);
});

test('launch input is validated and a tampered runtime is refused',async t=>{
  const post=await harness(t);
  assert.equal((await post('/v1/launches',{owner:'Not An Account',name:'x'})).status,400);
  assert.equal((await post('/v1/launches',{owner:'alice.testnet',name:'x',marginNear:'0.001'})).status,400);
  const {body}=await post('/v1/launches',{owner:'alice.testnet',name:'Scout'});
  const tampered=await post('/v1/launches/next',{launch:{...body.launch,release:{...body.launch.release,url:'https://evil.example/x.wasm'}}});
  assert.equal(tampered.status,400);
  assert.match(tampered.body.error,/reviewed release catalog/);
});

test('owner actions are prepared unsigned, and only allowlisted kinds',async t=>{
  const post=await harness(t);
  const list=await post('/v1/nfas/nfa-3/actions',{kind:'list',price:'1000000000000000000000000',expiresAtNs:(Date.now()+86_400_000)*1_000_000});
  assert.equal(list.status,200,JSON.stringify(list.body));
  assert.equal(list.body.tokenId,'nfa-3');
  assert.ok(list.body.unsignedAction.methodName);
  const fund=await post('/v1/nfas/nfa-3/actions',{kind:'fund',yocto:'1000'});
  assert.equal(fund.status,200,JSON.stringify(fund.body));
  assert.equal(fund.body.unsignedAction.receiverId,'nfa-3.registry.testnet');
  const refused=await post('/v1/nfas/nfa-3/actions',{kind:'outlayer_activate'});
  assert.equal(refused.status,400);
  assert.match(refused.body.error,/Unsupported action kind/);
});

test('appearance update renders, publishes the manifest and returns the unsigned update',async t=>{
  const post=await harness(t);
  const {status,body}=await post('/v1/nfas/nfa-3/appearance',{displayName:'Scout Prime',seed:'prime'});
  assert.equal(status,200,JSON.stringify(body));
  assert.equal(body.manifest.displayName,'Scout Prime');
  assert.equal(body.signer,'alice.testnet');
  assert.match(body.manifestUri,/^nfa:\/\/manifest\/[0-9a-f]{64}$/);
  assert.equal(body.unsignedAction.args.manifest_uri,body.manifestUri);
});
