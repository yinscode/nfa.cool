import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {studioPages,finances,recoveryActions,studioAudit} from './studio-state.mjs';
import {listServices} from './service-runtime.mjs';
import {publishedManifest} from './published-artifacts.mjs';
import {businessSummary,buyerInventory} from './business.mjs';
import {snapshotSdk} from './snapshot-sdk.mjs';

const run=promisify(execFile);
const generator=fileURLToPath(new URL('../../generate.cjs',import.meta.url));
const catalogPath=fileURLToPath(new URL('../../assets/catalog.json',import.meta.url));
const releasesPath=fileURLToPath(new URL('../../releases/catalog.json',import.meta.url));
const SHA=/^sha256:[0-9a-f]{64}$/;
const TOKEN=/^nfa-[1-9][0-9]*$/;
const ACCOUNT=/^[a-z0-9._-]{2,64}$/;
const digest=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
let catalogPromise;

export function characterCatalog(){
  catalogPromise ||= Promise.all([run(process.execPath,[generator,'--list-traits'],{timeout:5000}),readFile(catalogPath)])
    .then(([traits,bytes])=>({traits:JSON.parse(traits.stdout),assetDigest:digest(bytes),rendererVersion:'2.0.0',
      rules:{oneHeadSlot:['attachment','ornament','hat'],hatBodies:['sphere','capsule']}}))
    .catch(error=>{catalogPromise=null;throw error});
  return catalogPromise;
}

export function validateTraits(traits,catalog){
  if(!traits||typeof traits!=='object'||Array.isArray(traits))throw Error('Invalid traits');
  for(const [name,value] of Object.entries(traits)){
    if(!catalog.traits[name]?.includes(value))throw Error(`Unknown ${name} trait`);
  }
  const heads=catalog.rules.oneHeadSlot.filter(name=>traits[name]&&traits[name]!=='none');
  if(heads.length>1)throw Error('Choose one attachment, ornament or hat');
  if(traits.hat&&traits.hat!=='none'&&!catalog.rules.hatBodies.includes(traits.body))
    throw Error('Fitted hats require sphere or capsule body');
  return traits;
}

export async function ownedNfas(sdk,accountId){
  if(!ACCOUNT.test(accountId))throw Error('Invalid owner account');
  const rows=[];let from=0;
  while(from<250){
    const page=await sdk.view(sdk.registryAccountId,'nft_tokens_for_owner',
      {account_id:accountId,from_index:String(from),limit:25});
    if(!Array.isArray(page))throw Error('Invalid owner token view');
    for(const token of page){if(TOKEN.test(token.token_id))rows.push((await studioNfa(sdk,token.token_id)).identity)}
    if(page.length<25)break;
    from+=page.length;
  }
  return rows;
}

export async function studioNfa(sdk,id,{servicePolicy=null}={}){
  if(!TOKEN.test(id))throw Error('Invalid NFA token ID');
  sdk=snapshotSdk(sdk);
  let identity,complete=true;
  try{identity=await sdk.get(id)}catch(error){
    const [nft,agent]=await Promise.all([
      sdk.view(sdk.registryAccountId,'nft_token',{token_id:id}),
      sdk.view(sdk.registryAccountId,'agent',{token_id:id})]);
    if(!nft||!agent)throw Error('NFA not found');
    complete=false;
    identity={registryAccountId:sdk.registryAccountId,tokenId:id,vaultAccountId:agent.vault_id,
      ownerAccountId:nft.owner_id,ownerEpoch:agent.epoch,
      lifecycle:({Active:'ACTIVE',Draining:'DRAINING',Listed:'LISTED'}[agent.lifecycle]||'UNKNOWN'),
      manifestHash:agent.manifest_hash,manifestUri:agent.manifest_uri,
      income:null,listing:null,foreignWallet:null};
  }
  const optional=async work=>{try{return await work()}catch{return null}};
  const [treasury,agent,project,services,history,scoutPolicy,comparePolicy,chainKey,vaultState,transactionPolicy,
    grants,pages,audit,payout,availability,resume]=await Promise.all([
    optional(()=>sdk.getTreasury(id)),optional(()=>sdk.getAgentState(id)),
    optional(()=>sdk.getOutlayerProject(id)),optional(()=>sdk.getServiceCatalog(id)),
    optional(()=>sdk.getHistory(id,1,50)),optional(()=>sdk.getServicePolicy(id,'scout')),
    optional(()=>sdk.getServicePolicy(id,'compare')),optional(()=>sdk.getChainKey(id)),
    optional(()=>sdk.view(identity.vaultAccountId,'outlayer_status')),
    optional(()=>sdk.view(sdk.registryAccountId,'transaction_policy',{token_id:id})),
    optional(()=>sdk.view(sdk.registryAccountId,'studio_grants',{token_id:id})),
    optional(()=>studioPages(sdk,id)),optional(()=>studioAudit(sdk,id)),
    optional(()=>sdk.view(sdk.registryAccountId,'payout',{seller:identity.ownerAccountId})),
    optional(()=>listServices({sdk,tokenId:id,policy:servicePolicy})),
    optional(()=>sdk.view(sdk.registryAccountId,'service_resume',{token_id:id}))]);
  const rows=pages?.rows||[];
  const hostProject=project?.project_id?await optional(()=>sdk.view(
    sdk.registryAccountId.endsWith('.test.near')?'outlayer.test.near':'outlayer.testnet',
    'get_project',{project_id:project.project_id})):null;
  const uuid=hostProject?.uuid||hostProject?.project_uuid;
  const agreement=!!(project?.state==='READY'&&vaultState?.project?.project_uuid===project.project_uuid&&
    uuid===project.project_uuid&&hostProject?.active_version===project.version_key&&
    vaultState?.project?.version_key===project.version_key&&vaultState?.project?.project_id===project.project_id&&
    hostProject?.project_id===project.project_id&&(!hostProject.owner||hostProject.owner===identity.vaultAccountId));
  const releaseCatalog=JSON.parse(await readFile(releasesPath,'utf8')).releases;
  const snapshot={identity,capabilities:{writable:complete},treasury,agent,project,services:services||[],
    chainKey,policies:{scout:scoutPolicy,compare:comparePolicy},history:history||[],
    vaultState,transactionPolicy,grants:grants||[],jobs:rows,financial:pages?finances(rows):null,
    financialComplete:pages?.complete||false,audit:audit||[],payout,availability:availability?.items||[],
    hostProject,projectAgreement:agreement,
    recovery:recoveryActions({registryAccountId:sdk.registryAccountId,tokenId:id,project,agent,rows,resume}),
    runtimeGate:agreement&&releaseCatalog.some(r=>r.versionKey===project.version_key&&r.hostedStatus==='verified')?'verified':'hosted_execution_unverified'};
  return {...snapshot,economics:businessSummary(snapshot),inventory:buyerInventory(snapshot)};
}

export async function publishAppearance({sdk,renderer,manifests,artifacts,body}){
  const {tokenId,previewKey,displayName,expectedOwner,expectedEpoch}=body;
  if(!TOKEN.test(tokenId)||!ACCOUNT.test(expectedOwner)||!Number.isSafeInteger(expectedEpoch)||expectedEpoch<0)
    throw Error('Invalid appearance revision');
  if(typeof displayName!=='string'||!displayName.trim()||displayName.length>64)throw Error('Invalid name');
  const identity=await sdk.get(tokenId);
  if(identity.ownerAccountId!==expectedOwner||identity.ownerEpoch!==expectedEpoch)
    throw Error('Ownership changed; reload the NFA');
  const preview=await renderer.get(previewKey);
  const catalog=await characterCatalog();
  validateTraits(preview.metadata.traits,catalog);
  let previous=null;
  if(identity.manifestUri){
    previous=await publishedManifest({hash:identity.manifestHash,uri:identity.manifestUri,manifests});
    if(!previous||previous.publicCharacter?.collection!=='nfa-v2')throw Error('Unknown previous manifest');
  }
  const image=await artifacts.putImage(await renderer.image(previewKey));
  if(image.hash!==preview.imageHash)throw Error('Character image hash changed');
  const cutout=await artifacts.putImage(await renderer.cutout(previewKey));
  const manifest={...(previous||{}),schemaVersion:2,displayName:displayName.trim(),
    publicCharacter:{collection:'nfa-v2',seed:preview.seed,renderSeed:preview.metadata.seed,traits:preview.metadata.traits,
      rendererVersion:catalog.rendererVersion,assetDigest:catalog.assetDigest,
      imageHash:image.hash,imageUri:image.uri,cutoutHash:cutout.hash,cutoutUri:cutout.uri},
    previousManifestHash:identity.manifestHash,previousManifestUri:identity.manifestUri,revision:(previous?.revision||0)+1};
  const saved=await manifests.put(manifest);
  return {manifestHash:saved.outputHash,manifestUri:`nfa://manifest/${saved.outputHash.slice(7)}`,
    manifest,expectedOwner,expectedEpoch};
}
