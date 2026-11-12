#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import {transactions,utils,KeyPairSigner} from 'near-api-js';
import {NfaSdk} from '@nfa/sdk';
import {testnet,pause,sha} from './testnet-lib.mjs';
import {AvatarRenderer} from '../services/api/render.mjs';
import {characterCatalog} from '../services/api/studio.mjs';
import {quoteService,schemaHashFor} from '../services/api/service-runtime.mjs';
import {AccessService,verifyNearFullAccessKey} from '../services/api/access.mjs';
import assert from 'node:assert/strict';

const ctx=await testnet('deployments/studio-testnet-public.json');
const registry=await ctx.signer('t006-registry'),alice=await ctx.signer('t006-alice'),bob=await ctx.signer('t008-bob'),funder=await ctx.signer('studio-funder');
const sdk=new NfaSdk({registryAccountId:registry.id,rpcUrl:ctx.rpcUrl});
const near=n=>BigInt(n)*10n**24n;
const call=(label,person,method,args,deposit='1',options={})=>ctx.send(label,person,registry.id,[transactions.functionCall(method,args,250_000_000_000_000n,BigInt(deposit))],options);
const action=(label,person,a)=>ctx.send(label,person,a.receiverId,[a.methodName?transactions.functionCall(a.methodName,a.args,BigInt(a.gas),BigInt(a.deposit)):transactions.transfer(BigInt(a.deposit))]);
async function until(work,check){for(let i=0;i<180;i++){try{const value=await work();if(check(value))return value}catch{}await pause(500)}throw Error('Finalized state did not settle')}
async function upgrade(){
  const code=await readFile('contracts/registry/target/wasm32-unknown-unknown/release/nfa_registry_opt.wasm');
  const rehearsal=JSON.parse(await readFile('docs/studio-upgrade-rehearsal.json'));
  if(rehearsal.newCodeSha256!==sha(code))throw Error('Rehearse these exact registry bytes before live upgrade');
  const state=await ctx.account(registry.id),oldCode=await ctx.rpc('query',{request_type:'view_code',finality:'final',account_id:registry.id});
  const oldBytes=Buffer.from(oldCode.code_base64,'base64');
  const newHash=utils.serialize.base_encode(Buffer.from(sha(code),'hex'));
  if(!ctx.evidence.before){ctx.evidence.before={registry:{id:registry.id},codeHash:state.code_hash,
    nft:await sdk.view(registry.id,'nft_token',{token_id:'nfa-1'}),agent:await sdk.view(registry.id,'agent',{token_id:'nfa-1'})};
    await ctx.save()}
  const desired=BigInt(code.length+state.storage_usage-oldBytes.length)*10n**19n+5n*10n**23n;
  const needed=desired>BigInt(state.amount)?desired-BigInt(state.amount):0n;
  if(needed>near(5))throw Error('Registry funding requirement exceeds reviewed testnet budget');
  if(needed>0n)await ctx.send('fundRegistry-'+sha(code).slice(0,12),funder,registry.id,[transactions.transfer(needed)]);
  if(state.code_hash!==newHash)await ctx.send('upgradeRegistry-'+sha(code).slice(0,12),registry,registry.id,[transactions.deployContract(code)]);
  const identity=await until(()=>sdk.get('nfa-1'),x=>!!x);
  assert.equal(identity.ownerAccountId,ctx.evidence.before.nft.owner_id);
  assert.equal(identity.ownerEpoch,ctx.evidence.before.agent.epoch);
  assert.equal(identity.vaultAccountId,ctx.evidence.before.agent.vault_id);
  ctx.evidence.afterUpgrade={registryId:registry.id,codeSha256:sha(code),identity};await ctx.save();
}
async function character(revision,previous){
  const renderer=new AvatarRenderer('.data/studio-live/render'),catalog=await characterCatalog();
  const preview=await renderer.render({seed:'studio-live-v1',traits:{body:'sphere',eyewear:revision?'angular-sun':'round-wire',attachment:'none',ornament:'none',hat:'none'}});
  const image=await ctx.upload(`image${revision}`,funder,await renderer.image(preview.key),'image/png','png');
  const cutout=await ctx.upload(`cutout${revision}`,funder,await renderer.cutout(preview.key),'image/png','png');
  const manifest={schemaVersion:2,revision,displayName:revision?'Scout — Bob edition':'Studio Scout',template:'scout@1.0.0',
    publicCharacter:{collection:'nfa-v2',seed:preview.seed,renderSeed:preview.metadata.seed,traits:preview.metadata.traits,rendererVersion:catalog.rendererVersion,assetDigest:catalog.assetDigest,
      imageHash:'sha256:'+image.hash,imageUri:image.url,cutoutHash:'sha256:'+cutout.hash,cutoutUri:cutout.url},
    skills:[{id:'extractive-research',version:'1.0.0'}],services:[{id:'scout',schemaHash:schemaHashFor('scout')},{id:'compare',schemaHash:schemaHashFor('compare')}],
    ...(previous?{previousManifestHash:previous.hash,previousManifestUri:previous.url}:{})};
  const published=await ctx.upload(`manifest${revision}`,funder,Buffer.from(JSON.stringify(manifest)),'application/json','json');
  return {hash:'sha256:'+published.hash,url:published.url,manifest};
}
async function demo(){
  await upgrade();
  const requestId='studio-release-v1';
  let tokenId=await sdk.view(registry.id,'request_token',{owner:alice.id,request_id:requestId});
  if(!tokenId){const balance=await ctx.account(alice.id),target=63n*10n**23n;
    if(BigInt(balance.amount)<target)await ctx.send('fundMinter',funder,alice.id,[transactions.transfer(target-BigInt(balance.amount))])}
  if(!ctx.evidence.character){ctx.evidence.character=await character(0);await ctx.save()}
  if(!tokenId){await call('mintStudioNfa',alice,'create_agent',{request_id:requestId,manifest_hash:ctx.evidence.character.hash,manifest_uri:ctx.evidence.character.url},near(6).toString());
    tokenId=await until(()=>sdk.view(registry.id,'request_token',{owner:alice.id,request_id:requestId}),x=>!!x)}
  const initial=await until(()=>sdk.get(tokenId),x=>!!x);ctx.evidence.tokenId=tokenId;ctx.evidence.vaultId=initial.vaultAccountId;await ctx.save();
  const release=JSON.parse(await readFile('releases/catalog.json')).releases[0];
  if(!await sdk.getOutlayerProject(tokenId))await action('provisionNfaProject',alice,sdk.provisionOutlayer(tokenId,release.url,release.versionKey,'100000000000000000000000'));
  const project=await until(()=>sdk.getOutlayerProject(tokenId),p=>p?.state==='READY');
  const host=await sdk.view('outlayer.testnet','get_project',{project_id:project.project_id});
  assert.equal(host.uuid,project.project_uuid);assert.equal(host.owner,initial.vaultAccountId);
  ctx.evidence.project=project;await ctx.save();
  const policy={limits:{max_instructions:1_000_000_000,max_memory_mb:64,max_execution_seconds:10},marginYocto:'10000000000000000000000',maxDepositYocto:'500000000000000000000000'};
  for(const service of ['scout','compare']){
    if(!await sdk.getServicePolicy(tokenId,service))await action(`configure${service}`,alice,sdk.configureService(tokenId,service,schemaHashFor(service),true,policy.marginYocto,policy.maxDepositYocto,policy.limits));
    const input=service==='scout'?{question:'How does an NFA retain its treasury?',sources:[{title:'Vault',url:'https://example.org/vault',
      text:'An NFA retains its treasury in the same NEAR vault after its NFT transfers to a new owner. The registry gives the current owner control while the vault account remains unchanged.'}]}:
      {question:'Which option has cost and speed evidence?',criteria:['cost','speed'],sources:[{title:'A',url:'https://example.org/a',text:'The cost of option A is five units for a single run. The speed of option A is two seconds per run.'},
        {title:'B',url:'https://example.org/b',text:'The cost of option B is seven units for a single run.'}]};
    let entry=ctx.evidence[service];
    if(!entry){const quote=await quoteService({sdk,tokenId,service,body:{input},policy:{scout:policy,compare:policy}});
      const paid=await action(`pay${service}`,funder,quote.unsignedAction);
      if(!Number.isSafeInteger(paid.value))throw Error('Confirmed payment did not return a job ID');
      entry={jobId:paid.value,quote};ctx.evidence[service]=entry;await ctx.save()}
    const job=await sdk.getPaidJob(tokenId,entry.jobId);
    if(job.status==='REQUESTED'||(ctx.evidence.steps[`start${service}`]&&!ctx.evidence.steps[`start${service}`].outcome))
      await action(`start${service}`,funder,sdk.startServiceJob(tokenId,entry.jobId,entry.quote.inputData));
    entry.finalized=await until(()=>sdk.getPaidJob(tokenId,entry.jobId),j=>j?.status==='FINALIZED');
    entry.ledger=await sdk.view(registry.id,'service_ledger',{service_id:service});await ctx.save();
  }
  if(!await sdk.view(registry.id,'derived_wallet',{token_id:tokenId}))await action('deriveNfaSepolia',alice,sdk.deriveWallet(tokenId));
  const pinned=await until(()=>sdk.get(tokenId),x=>!!x.foreignWallet);ctx.evidence.pinnedAddress=pinned.foreignWallet.address;await ctx.save();
  if(!ctx.evidence.steps.recallBeforeSale)await action('recallBeforeSale',alice,sdk.recallOwnerMemory(tokenId,ctx.evidence.scout.jobId,'3000000000000000000000'));
  const access=new AccessService({sdk,origin:'http://127.0.0.1:3902',verifyKey:payload=>verifyNearFullAccessKey({...payload,rpcUrl:ctx.rpcUrl})});
  let oldSession;
  if((await sdk.get(tokenId)).ownerAccountId===alice.id){const challenge=access.challenge(alice.id,tokenId);
    const proof=await new KeyPairSigner(alice.key).signNep413Message(challenge.message,alice.id,challenge.recipient,Buffer.from(challenge.nonce,'base64'),challenge.callbackUrl);
    oldSession=(await access.authorize({challengeId:challenge.challengeId,accountId:alice.id,publicKey:proof.publicKey.toString(),signature:Buffer.from(proof.signature).toString('base64')})).session;
    if(!(await sdk.get(tokenId)).listing)await action('listNfa',alice,sdk.listForSale(tokenId,'50000000000000000000000',Number(BigInt(Date.now()+3600000)*1_000_000n)));
    const listed=await until(()=>sdk.get(tokenId),x=>!!x.listing);
    await action('buyNfa',bob,sdk.buy(tokenId,listed.listing.nonce,listed.listing.price));
  }
  const buyer=await until(()=>sdk.get(tokenId),x=>x.ownerAccountId===bob.id);
  assert.equal(buyer.vaultAccountId,initial.vaultAccountId);assert.equal(buyer.foreignWallet.address,ctx.evidence.pinnedAddress);
  assert.equal((await sdk.getOutlayerProject(tokenId)).project_uuid,project.project_uuid);
  if(oldSession){await assert.rejects(()=>access.requireOwner(oldSession,tokenId),/Ownership changed/);ctx.evidence.oldOwnerSessionRejected=true;await ctx.save()}
  if(!ctx.evidence.buyerCharacter){ctx.evidence.buyerCharacter=await character(1,ctx.evidence.character);await ctx.save()}
  if(buyer.manifestHash!==ctx.evidence.buyerCharacter.hash)await action('buyerEditCharacter',bob,sdk.updateManifest(tokenId,ctx.evidence.buyerCharacter.hash,ctx.evidence.buyerCharacter.url));
  await action('buyerRecallScout',bob,sdk.recallOwnerMemory(tokenId,ctx.evidence.scout.jobId,'3000000000000000000000'));
  await call('oldOwnerRecallDenied',alice,'recall_owner_memory',{token_id:tokenId,job_id:ctx.evidence.scout.jobId,deposit:'3000000000000000000000'},'3000000000000000000000',{failureExpected:true});
  await call('oldOwnerEditDenied',alice,'update_manifest',{token_id:tokenId,manifest_hash:ctx.evidence.character.hash,manifest_uri:ctx.evidence.character.url},'1',{failureExpected:true});
  ctx.evidence.finalIdentity=await sdk.get(tokenId);ctx.evidence.finalProject=await sdk.getOutlayerProject(tokenId);
  ctx.evidence.finalTreasury=await sdk.getTreasury(tokenId);ctx.evidence.finalLedger=await sdk.getPaidLedger();
  ctx.evidence.completedAt=new Date().toISOString();await ctx.save();console.log(JSON.stringify({tokenId,vault:initial.vaultAccountId,projectUuid:project.project_uuid,complete:true}));
}
if(process.argv[2]==='upgrade')await upgrade();else if(process.argv[2]==='demo')await demo();
else console.log(JSON.stringify({registry:await ctx.account(registry.id),alice:await ctx.account(alice.id),funder:await ctx.account(funder.id)},null,2));
