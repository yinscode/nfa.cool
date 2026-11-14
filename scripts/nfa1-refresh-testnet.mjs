#!/usr/bin/env node
// NFA #1 ("Sage") was the first mint: a placeholder manifest and no OutLayer Project.
// Its owner (Alice) publishes a character, gives it a Project and enables Scout + Compare
// with the same policies as NFA #2. Phased and journaled (deployments/nfa1-refresh.json).
//   node scripts/nfa1-refresh-testnet.mjs appearance|provision|services|status
import {transactions} from 'near-api-js';
import {NfaSdk} from '@nfa/sdk';
import {testnet,pause} from './testnet-lib.mjs';
import {AvatarRenderer} from '../services/api/render.mjs';
import {characterCatalog} from '../services/api/studio.mjs';
import {schemaHashFor} from '../services/api/service-runtime.mjs';
import {createHash} from 'node:crypto';

const phase=process.argv[2];if(!['appearance','provision','services','status'].includes(phase))throw Error('Use appearance|provision|services|status');
const registryId='nfagent-registry-0e9b2a.testnet',tokenId='nfa-1';
// Newest hosted-verified Scout + Compare runtime with a published URL (releases/catalog.json scout-compare-2).
const wasmHash='88b8ab0b0cdc589b46f4407e1738a15fdc8c090a1a70cd783e83d36634337a9e';
const wasmUrl=`https://test.fastfs.io/nfa-studio-mwd3mksx.testnet/outlayer.testnet/studio/${wasmHash}.wasm`;
const ctx=await testnet('deployments/nfa1-refresh.json');
const alice=await ctx.signer('t006-alice'),funder=await ctx.signer('studio-funder');
const sdk=new NfaSdk({registryAccountId:registryId,rpcUrl:ctx.rpcUrl});
const identity=await sdk.get(tokenId);
if(identity.ownerAccountId!==alice.id)throw Error('NFA #1 is not owned by Alice');
const agent=await sdk.getAgentState(tokenId);
const until=async(work,check,what)=>{for(let i=0;i<120;i++){const v=await work();if(check(v))return v;await pause(500)}throw Error(`${what} not observed`)};
const transact=(name,a)=>ctx.send(name,alice,a.receiverId,[transactions.functionCall(a.methodName,a.args,BigInt(a.gas),BigInt(a.deposit))]);
const ready=()=>{if(agent.pending_op!=null||agent.lifecycle!=='Active')throw Error('NFA #1 is busy')};

if(phase==='appearance'){
  if(!ctx.evidence.manifest){
    ready();
    const renderer=new AvatarRenderer('.data/nfa1/render'),catalog=await characterCatalog();
    const preview=await renderer.render({seed:'sage',traits:{body:'cube',palette:'cobalt',tool:'microphone',expression:'calm',eyewear:'none',frame:'passport'}});
    const image=await ctx.upload('sageImage',funder,await renderer.image(preview.key),'image/png','png');
    const cutout=await ctx.upload('sageCutout',funder,await renderer.cutout(preview.key),'image/png','png');
    const manifest={schemaVersion:2,revision:1,displayName:'Sage',template:'scout@1.0.0',
      description:'The NFA that hired Scout: it pays other NFAs from its own earnings, within a budget its owner sets.',
      publicCharacter:{collection:'nfa-v2',seed:preview.seed,renderSeed:preview.metadata.seed,traits:preview.metadata.traits,
        rendererVersion:catalog.rendererVersion,assetDigest:catalog.assetDigest,imageHash:'sha256:'+image.hash,imageUri:image.url,
        cutoutHash:'sha256:'+cutout.hash,cutoutUri:cutout.url},
      skills:[{id:'extractive-research',version:'1.0.0'}],
      services:[{id:'scout',schemaHash:schemaHashFor('scout')},{id:'compare',schemaHash:schemaHashFor('compare')}],
      previousManifestHash:identity.manifestHash,previousManifestUri:identity.manifestUri};
    const published=await ctx.upload('sageManifest',funder,Buffer.from(JSON.stringify(manifest)),'application/json','json');
    ctx.evidence.manifest={hash:'sha256:'+published.hash,url:published.url};await ctx.save();
  }
  if(identity.manifestHash!==ctx.evidence.manifest.hash){
    ready();await transact('updateSageManifest',sdk.updateManifest(tokenId,ctx.evidence.manifest.hash,ctx.evidence.manifest.url));
  }
  await until(()=>sdk.get(tokenId),i=>i.manifestHash===ctx.evidence.manifest.hash,'Updated manifest');
  console.log(JSON.stringify({phase,name:'Sage',manifest:ctx.evidence.manifest.url}));
}
if(phase==='provision'){
  if(!await sdk.getOutlayerProject(tokenId)){
    ready();
    const check=await fetch(wasmUrl,{signal:AbortSignal.timeout(20000)});
    if(!check.ok||createHash('sha256').update(Buffer.from(await check.arrayBuffer())).digest('hex')!==wasmHash)throw Error('Published runtime changed');
    await transact('provisionSageProject',sdk.provisionOutlayer(tokenId,wasmUrl,wasmHash,'100000000000000000000000'));
  }
  const project=await until(()=>sdk.getOutlayerProject(tokenId),p=>p?.state==='READY'&&p.version_key===wasmHash,'READY Project');
  console.log(JSON.stringify({phase,projectId:project.project_id,projectUuid:project.project_uuid,versionKey:project.version_key}));
}
if(phase==='services'){
  for(const id of ['scout','compare']){
    const reference=await sdk.getServicePolicy('nfa-2',id),current=await sdk.getServicePolicy(tokenId,id);
    if(reference.schema_hash!==schemaHashFor(id))throw Error(`Reference ${id} policy changed`);
    if(!current?.enabled||current.schema_hash!==reference.schema_hash||current.min_margin!==reference.min_margin||
      current.max_deposit!==reference.max_deposit||JSON.stringify(current.limits)!==JSON.stringify(reference.limits))
      await transact(`enableSage${id}`,sdk.configureService(tokenId,id,reference.schema_hash,true,reference.min_margin,reference.max_deposit,reference.limits));
    await until(()=>sdk.getServicePolicy(tokenId,id),p=>p?.enabled,`${id} policy`);
  }
  console.log(JSON.stringify({phase,enabled:['scout','compare']}));
}
if(phase==='status'){
  const [project,scout,compare,treasury]=await Promise.all([sdk.getOutlayerProject(tokenId),sdk.getServicePolicy(tokenId,'scout'),
    sdk.getServicePolicy(tokenId,'compare'),sdk.getTreasury(tokenId)]);
  console.log(JSON.stringify({manifest:identity.manifestUri,project:project?.state??null,runtime:project?.version_key??null,
    scout:!!scout?.enabled,compare:!!compare?.enabled,treasuryAvailable:treasury?.available,lifecycle:agent.lifecycle},null,2));
}
