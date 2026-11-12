import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApiServer} from '../server.mjs';
import {AccessService} from '../access.mjs';
import {WorkStore} from '../work-store.mjs';
import {AvatarRenderer} from '../render.mjs';
import {NfaSdk} from '@nfa/sdk';
import {InputStore} from '../../worker/input-store.mjs';

test('API prepares unsigned purchase and protects work after sale',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'nfa-api-'));
  let owner='alice.testnet',epoch=0;
  const sdk=new NfaSdk({registryAccountId:'registry.testnet',rpcUrl:'https://rpc.invalid'});
  sdk.get=async()=>({ownerAccountId:owner,ownerEpoch:epoch,tokenId:'nfa-1',listing:{nonce:1,price:'100'},lifecycle:'LISTED'});
  const store=new WorkStore(directory);
  const artifact={hello:'owned work'};const saved=await store.put(artifact);
  sdk.getJob=async()=>({status:'FINALIZED',output_hash:saved.outputHash});
  const access=new AccessService({sdk,origin:'http://127.0.0.1',verifyKey:async()=>true});
  const server=createApiServer({sdk,store,access,templateLoader:async()=>'{"id":"scout","status":"available"}'});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  const post=(path,body)=>fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  try{
    const page=await fetch(base+'/');assert.equal(page.status,200);
    assert.match(await page.text(),/Give your agent a job/);
    const studio=await fetch(base+'/studio');assert.equal(studio.status,200);
    assert.match(await studio.text(),/Your agents, ready for work/);
    const config=await (await fetch(base+'/config')).json();
    assert.equal(config.registryAccountId,'registry.testnet');
    const asset=(await (await fetch(base+'/')).text()).match(/src="(\/assets\/[^"]+\.js)"/);
    assert.ok(asset,'Wallet UI bundle is served');
    assert.equal((await fetch(base+asset[1])).status,200);
    const prepared=await (await post('/prepare',{kind:'buy',tokenId:'nfa-1',nonce:1,price:'100'})).json();
    assert.equal(prepared.unsignedAction.deposit,'100');
    assert.equal(prepared.unsignedAction.methodName,'buy');
    assert.equal((await fetch(base+'/nfas/nfa-1/work/1')).status,401);
    const challenge=await (await post('/auth/challenge',{accountId:'alice.testnet',tokenId:'nfa-1'})).json();
    const {session}=await (await post('/auth/session',{challengeId:challenge.challengeId,publicKey:'test',signature:'test'})).json();
    const headers={authorization:`Bearer ${session}`};
    assert.deepEqual((await (await fetch(base+'/nfas/nfa-1/work/1',{headers})).json()).artifact,artifact);
    owner='bob.testnet';epoch=1;
    assert.equal((await fetch(base+'/nfas/nfa-1/work/1',{headers})).status,401);
  }finally{await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true})}
});

test('paid-job inputs are persisted for a worker and returned as commitments',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'nfa-job-input-'));
  const inputs=new InputStore(join(directory,'inputs'));
  const server=createApiServer({sdk:{registryAccountId:'registry.testnet'},store:new WorkStore(join(directory,'work')),
    access:{},inputs});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  const supplied={question:'How does the agent retain its treasury?',sources:[{title:'Account',url:'https://example.org/account',
    text:'The agent retains its treasury in the same NEAR account after the NFT changes hands.'}]};
  try{
    const response=await fetch(base+'/job-inputs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(supplied)});
    assert.equal(response.status,200);
    const result=await response.json();
    assert.equal(result.minFeeYocto,'10000000000000000000000');
    assert.deepEqual(await new InputStore(join(directory,'inputs')).get(result.briefHash,result.sourceHash),supplied);
  }finally{await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true})}
});

test('template preview is the exact image committed in the creation manifest',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'nfa-creation-'));
  const sdk={registryAccountId:'registry.testnet'};
  const server=createApiServer({sdk,store:new WorkStore(join(directory,'work')),
    access:{},renderer:new AvatarRenderer(join(directory,'render')),
    manifests:new WorkStore(join(directory,'manifests'))});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  const post=(path,body)=>fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  try{
    const preview=await (await post('/preview',{seed:'scout-avatar',traits:{body:'sphere',eyewear:'round-wire'}})).json();
    const response=await post('/manifests',{previewKey:preview.key,displayName:'Scout One'});
    assert.equal(response.status,200);
    const created=await response.json();
    assert.equal(created.manifest.publicCharacter.imageHash,preview.imageHash);
    const image=await fetch(base+preview.imageUrl);
    assert.equal(image.headers.get('content-type'),'image/png');
    assert.ok((await image.arrayBuffer()).byteLength>1000);
    const saved=await (await fetch(base+'/manifests/'+created.manifestHash.slice(7))).json();
    assert.deepEqual(saved,created.manifest);
  }finally{await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true})}
});

test('development shutdown requires a private control token and never exposes it in configuration',async()=>{
  let stopped=false;
  const secret='local-control-fixture';
  const sdk=new NfaSdk({registryAccountId:'registry.test.near',rpcUrl:'http://127.0.0.1:9'});
  const server=createApiServer({sdk,localWallet:{accounts:['alice.test.near'],instanceId:'public-instance'},
    localControl:{token:secret,stop:()=>{stopped=true}},workspace:{persistent:true,id:'persistent-fixture'}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
  try{
    const config=await (await fetch(base+'/config')).text();assert.ok(!config.includes(secret));
    assert.equal((await fetch(base+'/dev/server/stop',{method:'POST'})).status,403);assert.equal(stopped,false);
    assert.equal((await fetch(base+'/dev/server/stop',{method:'POST',headers:{'x-nfa-dev-control':secret}})).status,202);
    await new Promise(resolve=>setTimeout(resolve,150));assert.equal(stopped,true);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
});
