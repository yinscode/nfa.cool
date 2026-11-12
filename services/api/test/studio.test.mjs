import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApiServer} from '../server.mjs';
import {AvatarRenderer} from '../render.mjs';
import {ArtifactStore} from '../artifact-store.mjs';
import {WorkStore} from '../work-store.mjs';
import {characterCatalog,validateTraits} from '../studio.mjs';

test('Studio publishes content-addressed character revisions and checks owner epoch',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'nfa-studio-'));
  let owner='alice.testnet',epoch=0,manifestHash='',manifestUri='';
  const sdk={registryAccountId:'registry.testnet',
    get:async id=>({tokenId:id,ownerAccountId:owner,ownerEpoch:epoch,
      vaultAccountId:'nfa-1.registry.testnet',lifecycle:'ACTIVE',manifestHash,manifestUri,income:'0'}),
    getServiceJob:async(_id,jobId)=>jobId===7?{service_id:'compare',policy_version:2}:null,
    getPaidJob:async(_id,jobId)=>jobId===7?{status:'FINALIZED',output_hash:'sha256:'+'f'.repeat(64)}:null,
    getMemoryReceipt:async(_id,jobId)=>jobId===7?{job_id:7,output_hash:'sha256:'+'f'.repeat(64)}:null,
    view:async(_account,method)=>method==='nft_tokens_for_owner'?[{token_id:'nfa-1'}]:null};
  const server=createApiServer({sdk,store:new WorkStore(join(directory,'work')),access:{},
    renderer:new AvatarRenderer(join(directory,'render')),
    manifests:new WorkStore(join(directory,'manifests')),artifacts:new ArtifactStore(join(directory,'images'))});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  const post=(path,body)=>fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  try{
    const catalog=await (await fetch(base+'/studio/catalog')).json();
    assert.ok(catalog.traits.eyewear.includes('half-rim'));
    assert.throws(()=>validateTraits({body:'bean',hat:'beanie'},catalog),/Fitted hats/);
    assert.equal((await fetch(base+'/studio/owned?owner=alice.testnet')).status,200);
    const job=await (await fetch(base+'/studio/nfas/nfa-1/jobs/7')).json();
    assert.equal(job.status,'FINALIZED');assert.equal(job.service.service_id,'compare');
    assert.equal((await fetch(base+'/studio/nfas/nfa-1/jobs/8')).status,404);
    const invalid=await post('/preview',{seed:'new-look',traits:{body:'bean',hat:'beanie'}});
    assert.equal(invalid.status,400);
    const preview=await (await post('/preview',{seed:'new-look',traits:{body:'sphere',hat:'beanie',
      eyewear:'round-wire',expression:'curious'}})).json();
    const created=await (await post('/manifests',{previewKey:preview.key,displayName:'Scout'})).json();
    manifestHash=created.manifestHash;manifestUri=created.manifestUri;
    assert.equal(created.manifest.publicCharacter.assetDigest,catalog.assetDigest);
    assert.equal(created.manifest.publicCharacter.seed,'new-look');
    const reproduced=await (await post('/preview',{seed:created.manifest.publicCharacter.seed,traits:created.manifest.publicCharacter.traits})).json();
    assert.equal(reproduced.imageHash,created.manifest.publicCharacter.imageHash);
    const published=created.manifest.publicCharacter.imageUri.split('/').pop();
    const image=await fetch(base+'/studio/artifacts/'+published);
    assert.equal(image.status,200);assert.equal(image.headers.get('content-type'),'image/png');
    const changed=await (await post('/studio/appearance',{tokenId:'nfa-1',previewKey:preview.key,
      displayName:'Scout II',expectedOwner:'alice.testnet',expectedEpoch:0})).json();
    assert.equal(changed.manifest.previousManifestHash,created.manifestHash);
    assert.equal(changed.manifest.revision,1);
    const old=await (await fetch(base+'/manifests/'+created.manifestHash.slice(7))).json();
    assert.equal(old.displayName,'Scout');
    owner='bob.testnet';epoch=1;
    const stale=await post('/studio/appearance',{tokenId:'nfa-1',previewKey:preview.key,
      displayName:'Stale',expectedOwner:'alice.testnet',expectedEpoch:0});
    assert.equal(stale.status,401);
    const buyer=await post('/studio/appearance',{tokenId:'nfa-1',previewKey:preview.key,
      displayName:'Bob',expectedOwner:'bob.testnet',expectedEpoch:1});
    assert.equal(buyer.status,200);
  }finally{await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true})}
});

test('recovery actions offer only the matching liveness exit',async()=>{
  const {recoveryActions}=await import('../studio-state.mjs');
  const base={registryAccountId:'registry.testnet',tokenId:'nfa-1',project:{state:'READY'},resume:null,now:Date.now()};
  const methods=(rows,pending)=>recoveryActions({...base,agent:{pending_op:pending,lifecycle:'Active',next_op_id:pending+1},rows}).map(a=>a.unsignedAction.methodName);
  assert.deepEqual(methods([{id:4,service:{job:{status:'UNCERTAIN'}}}],4),['release_service_job']);
  assert.deepEqual(methods([{id:4,service:{job:{status:'EXECUTING',started_at_ns:String(BigInt(Date.now())*1_000_000n)}}}],4),[],'too early to release');
  assert.deepEqual(methods([{id:4,service:{job:{status:'REQUESTED',deadline_ns:String(BigInt(Date.now()+600_000)*1_000_000n)}}}],4),['cancel_unstarted_job']);
  assert.deepEqual(methods([{id:5,operation:{kind:'NEAR_TRANSFER',status:'Uncertain'}}],5),['reconcile_near_operation']);
  assert.deepEqual(methods([{id:6,operation:{kind:'EVM_TRANSFER',status:'Uncertain'}}],6),['recover_evm_operation','retry_evm_signature']);
  assert.deepEqual(methods([{id:7,recall:{state:'UNCERTAIN'}}],7),['release_recall']);
});
