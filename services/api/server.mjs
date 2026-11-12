import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {createHash,timingSafeEqual} from 'node:crypto';
import {NfaSdk} from '@nfa/sdk';
import {AccessService,verifyNearFullAccessKey} from './access.mjs';
import {WorkStore} from './work-store.mjs';
import {AvatarRenderer} from './render.mjs';
import {InputStore} from '../worker/input-store.mjs';
import {listServices,quoteService,prepareServiceStart,serviceSchemas,schemaHashFor,outputSchemas} from './service-runtime.mjs';
import {ArtifactStore} from './artifact-store.mjs';
import {characterCatalog,ownedNfas,studioNfa,validateTraits,publishAppearance} from './studio.mjs';
import {createScoutBrief} from '../worker/scout.mjs';
import {createCompareBrief} from '../worker/compare.mjs';
import {configuredObjects} from './object-store.mjs';
import {validateTransactionPolicy,simulateTransaction} from './transaction-policy.mjs';
import {inspectTransaction} from './transaction-receipt.mjs';
import {verifyRelease} from './wasm-release.mjs';
import {materializeWork} from './materialize-work.mjs';
import {publishedBytes,publishedManifest} from './published-artifacts.mjs';
import {inspectLaunchAction} from './action-receipt.mjs';
import {studioPort,listenStudio} from './studio-listen.mjs';
import {deploymentConfig,readiness} from './deployment.mjs';
import {sepoliaHoldings} from '../worker/evm-settler.mjs';
import {reviewedPackages} from './service-package.mjs';

const templatePath=fileURLToPath(new URL('../../templates/scout/v1.json',import.meta.url));
const compareTemplatePath=fileURLToPath(new URL('../../templates/compare/v1.json',import.meta.url));
const releaseCatalogPath=fileURLToPath(new URL('../../releases/catalog.json',import.meta.url));
const webRoot=fileURLToPath(new URL('../../apps/web/dist/',import.meta.url));
const TOKEN=/^nfa-[1-9][0-9]*$/;
const send=(res,status,body)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8',
  'cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(body))};
async function input(req){
  let body='', size=0;
  for await(const chunk of req){size+=chunk.length;if(size>64_000)throw Error('Request body too large');body+=chunk}
  return JSON.parse(body||'{}');
}
function prepare(sdk,body){
  const {kind,tokenId:id}=body;
  switch(kind){
    case 'create':return sdk.create(body);
    case 'fund':return sdk.fund(body.vaultAccountId,body.yocto);
    case 'manifest':return sdk.updateManifest(id,body.manifestHash,body.manifestUri);
    case 'grant':return sdk.grant(id,body.delegate,body.method,body.recipient??null,body.budget,body.expiresAtNs);
    case 'revoke':return sdk.revoke(id,body.delegate,body.method);
    case 'near_transfer':return sdk.requestNearTransfer(id,body.recipient,body.yocto);
    case 'evm_transfer':return sdk.requestEvmTransfer(id,body.recipientHex,body.valueWei,body.priorityFee,body.maxFee);
    case 'derive_wallet':return sdk.deriveWallet(id);
    case 'job':return sdk.runJob(id,body.briefHash,body.sourceHash,body.fee,body.deadlineNs);
    case 'outlayer_provision':return sdk.provisionOutlayer(id,body.wasmUrl,body.versionKey,body.deposit);
    case 'outlayer_add_version':return sdk.addOutlayerVersion(id,body.wasmUrl,body.versionKey,body.deposit);
    case 'outlayer_activate':return sdk.activateOutlayerVersion(id);
    case 'transaction_policy':return sdk.prepare('configure_transaction_policy',{token_id:id,...validateTransactionPolicy(body)});
    case 'paid_scout':return sdk.requestPaidScout(id,body.inputHash,body.deadlineNs,body.fee,body.replenish,body.depositCap,body.limits);
    case 'service_policy':return sdk.configureService(id,body.serviceId,body.schemaHash,body.enabled,
      body.margin,body.maxDeposit,body.limits);
    case 'research_config':return sdk.configureResearch(id,body.settings);
    case 'research_verify_vault':return sdk.verifyResearchVault(id);
    case 'recall':return sdk.recallOwnerMemory(id,body.jobId,body.deposit);
    case 'claim':return sdk.claimIncome(id,body.yocto);
    case 'withdraw':return sdk.withdrawProceeds(body.yocto);
    case 'transfer':return sdk.prepareTransfer(id,body.receiverId);
    case 'list':return sdk.listForSale(id,body.price,body.expiresAtNs);
    case 'unlist':return sdk.unlist(id);
    case 'buy':return sdk.buy(id,body.nonce,body.price);
    default:throw Error('Unknown action kind');
  }
}

export function createApiServer({sdk,store,access,
  renderer=new AvatarRenderer(resolve('.data/render')),
  manifests=new WorkStore(resolve('.data/manifests')),
  artifacts=new ArtifactStore(resolve('.data/artifacts')),
  inputs=new InputStore(resolve('.data/inputs')),
  servicePolicy=null,
  localWallet=null,
  workspace=null,
  localControl=null,
  deployment=null,
  readyCheck=null,
  evmRpcUrl=null,
  templateLoader=()=>readFile(templatePath,'utf8')}){
  const hits=new Map();
  if(localWallet&&!['127.0.0.1','localhost'].includes(new URL(sdk.rpcUrl).hostname))throw Error('Local wallet bridge requires a loopback sandbox');
  if(localControl&&!localWallet)throw Error('Development control requires the local sandbox');
  return createServer(async(req,res)=>{
    try{
      const path=new URL(req.url||'/', 'http://localhost').pathname;
      if(req.method==='GET'&&path==='/healthz'){send(res,200,{ok:true});return}
      if(req.method==='GET'&&path==='/readyz'){
        const status=readyCheck?await readyCheck():{ready:true,mode:'local'};
        send(res,status.ready?200:503,status);return;
      }
      if(deployment?.production&&req.headers.origin&&req.headers.origin!==deployment.origin&&req.method!=='GET'){
        send(res,403,{error:'origin_not_allowed'});return;
      }
      const ip=req.socket.remoteAddress||'local', now=Date.now();
      if(hits.size>10000)for(const [key,value] of hits)if(now-value.start>=60_000)hits.delete(key);
      if(!hits.has(ip)&&hits.size>=10000){send(res,429,{error:'rate_limited'});return}
      const entry=hits.get(ip)||{start:now,count:0};
      if(now-entry.start>=60_000){entry.start=now;entry.count=0}
      if(++entry.count>120){send(res,429,{error:'rate_limited'});return}
      hits.set(ip,entry);
      const appPath=['/','/studio','/create'].includes(path)||/^\/nfa\/nfa-[1-9][0-9]*$/.test(path);
      if(req.method==='GET'&&(appPath||/^\/assets\/[a-zA-Z0-9._-]+\.(js|css|svg|png)$/.test(path))){
        const filename=appPath?'index.html':path.slice(1);
        const content=await readFile(resolve(webRoot,filename));
        res.writeHead(200,{'content-type':filename.endsWith('.js')?'text/javascript; charset=utf-8':
          filename.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8',
          'content-security-policy':"default-src 'self'; img-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' https://rpc.testnet.near.org https://test.rpc.fastnear.com https://test.fastfs.io; frame-src https://testnet.mynearwallet.com",
          'x-content-type-options':'nosniff'});res.end(content);return;
      }
      if(req.method==='GET'&&path==='/config'){
        send(res,200,{serverVersion:3,registryAccountId:sdk.registryAccountId,network:localWallet?'sandbox':'testnet',rpcUrl:deployment?.production?deployment.publicRpcUrl:sdk.rpcUrl,workspace,
          publicOrigin:deployment?.origin||null,
          localSandbox:localWallet?{accounts:localWallet.accounts,instanceId:localWallet.instanceId||null}:null});return;
      }
      if(req.method==='POST'&&path==='/dev/server/stop'&&localControl){
        const provided=Buffer.from(String(req.headers['x-nfa-dev-control']||'')),expected=Buffer.from(localControl.token);
        if(provided.length!==expected.length||!timingSafeEqual(provided,expected)){send(res,403,{error:'Invalid development control token'});return}
        send(res,202,{stopping:true});setTimeout(localControl.stop,100);return;
      }
      if(localWallet&&req.method==='POST'&&['/dev/wallet/transaction','/dev/wallet/message'].includes(path)){
        if(req.headers['x-nfa-local-wallet']!=='1')throw Error('Local sandbox wallet header required');
        const body=await input(req);
        send(res,200,await (path.endsWith('transaction')?localWallet.transaction(body):localWallet.message(body)));return;
      }
      if(req.method==='GET'&&path==='/templates'){send(res,200,{templates:[JSON.parse(await templateLoader()),
        JSON.parse(await readFile(compareTemplatePath,'utf8'))]});return}
      if(req.method==='GET'&&path==='/v1/service-packages'){send(res,200,{items:await reviewedPackages()});return}
      if(req.method==='GET'&&path==='/openapi.json'){
        send(res,200,JSON.parse(await readFile(new URL('../../docs/openapi.json',import.meta.url),'utf8')));return;
      }
      if(req.method==='GET'&&path==='/studio/discover'){
        const from=Number(new URL(req.url,'http://localhost').searchParams.get('from')||0);
        if(!Number.isSafeInteger(from)||from<0)throw Error('Invalid collection page');
        const tokens=await sdk.view(sdk.registryAccountId,'nft_tokens',{from_index:String(from),limit:12});
        send(res,200,{items:await Promise.all(tokens.map(async t=>{const n=await sdk.get(t.token_id);const [project,services]=await Promise.all([sdk.getOutlayerProject(t.token_id),sdk.getServiceCatalog(t.token_id)]);let manifest=null;try{manifest=await publishedManifest({hash:n.manifestHash,uri:n.manifestUri,manifests})}catch{}
          return {...n,displayName:manifest?.displayName||n.tokenId,publicCharacter:manifest?.publicCharacter,setupStatus:!project?'NFT minted · setup incomplete':project.state!=='READY'?'Runtime setup pending':services.some(s=>s.enabled)?'Services enabled':'Runtime ready · enable services'}})),next:tokens.length===12?from+12:null});return;
      }
      if(req.method==='POST'&&path==='/studio/launch/inspect'){
        send(res,200,await inspectLaunchAction({sdk,...await input(req)}));return;
      }
      if(req.method==='GET'&&path==='/studio/catalog'){
        send(res,200,await characterCatalog());return;
      }
      if(req.method==='GET'&&path==='/studio/releases'){
        send(res,200,JSON.parse(await readFile(releaseCatalogPath,'utf8')));return;
      }
      if(req.method==='GET'&&path==='/studio/skills'){
        const releases=JSON.parse(await readFile(releaseCatalogPath,'utf8')).releases;
        send(res,200,{items:['scout','compare'].map(id=>({id,schema:serviceSchemas[id],schemaHash:schemaHashFor(id),
          outputSchemaHash:'sha256:'+createHash('sha256').update(JSON.stringify(outputSchemas[id])).digest('hex'),outputSchema:outputSchemas[id],
          namespace:id==='scout'?'pending:<jobId>':'services/compare/pending:<jobId>',
          tools:['supplied-text-only'],operations:id==='scout'?['scout','recall']:['run','recall'],
          releases:releases.filter(r=>r.services.includes(id)).map(r=>({id:r.id,runtimeHash:r.versionKey,source:r.source||'skills/scout-wasi',hostedStatus:r.hostedStatus}))}))});return;
      }
      if(req.method==='POST'&&path==='/studio/releases/verify'){
        const body=await input(req),catalog=JSON.parse(await readFile(releaseCatalogPath,'utf8'));
        const release=catalog.releases.find(r=>r.versionKey===body.versionKey);if(!release)throw Error('Unknown reviewed release');
        send(res,200,await verifyRelease(release));return;
      }
      if(req.method==='GET'&&path==='/studio/storage'){
        send(res,200,{backend:artifacts.objects?'s3':'filesystem',durableConfigured:!!artifacts.objects||deployment?.durable===true,
          persistence:artifacts.objects?'private_object_store':deployment?.durable?'operator_asserted_durable_volume':'local_directory'});return;
      }
      if(req.method==='POST'&&path==='/studio/transactions/simulate'){
        const body=await input(req);if(!TOKEN.test(body.tokenId))throw Error('Invalid NFA token ID');
        send(res,200,await simulateTransaction({sdk,tokenId:body.tokenId,body}));return;
      }
      if(req.method==='POST'&&path==='/studio/transactions/inspect'){
        const body=await input(req);if(!TOKEN.test(body.tokenId))throw Error('Invalid NFA token ID');
        send(res,200,await inspectTransaction({sdk,...body}));return;
      }
      if(req.method==='POST'&&path==='/studio/recovery'){
        const {tokenId,method,id,failedJobId}=await input(req);
        const snapshot=await studioNfa(sdk,tokenId,{servicePolicy});
        const action=snapshot.recovery.find(item=>item.unsignedAction.methodName===method&&
          (item.unsignedAction.args.id??null)===(id??null)&&
          (item.unsignedAction.args.failed_job_id??null)===(failedJobId??null));
        if(!action)throw Error('Recovery action does not apply to finalized state');
        send(res,200,action);return;
      }
      if(req.method==='POST'&&path==='/studio/simulate'){
        const {service,input:source}=await input(req);
        if(!['scout','compare'].includes(service)||!source||typeof source!=='object'||Array.isArray(source))
          throw Error('Unknown service or input');
        const result=service==='scout'?createScoutBrief(source):createCompareBrief(source);
        let costEstimate=null;
        const policy=servicePolicy?.[service]??(service==='scout'?servicePolicy:null);
        if(policy?.limits){try{costEstimate={source:'OutLayer view, no payment',yocto:await sdk.view(
          sdk.registryAccountId.endsWith('.test.near')?'outlayer.test.near':'outlayer.testnet','estimate_execution_cost',
          {resource_limits:policy.limits,input_len:Buffer.byteLength(JSON.stringify(source))+128}),limits:policy.limits}}catch{}}
        send(res,200,{mode:'local_simulation',service,artifact:result.artifact,outputHash:result.outputHash,costEstimate});return;
      }
      if(req.method==='GET'&&path==='/studio/owned'){
        const owner=new URL(req.url||'/', 'http://localhost').searchParams.get('owner')||'';
        send(res,200,{items:await ownedNfas(sdk,owner)});return;
      }
      if(req.method==='GET'&&/^\/studio\/nfas\/nfa-[1-9][0-9]*$/.test(path)){
        send(res,200,await studioNfa(sdk,path.split('/')[3],{servicePolicy}));return;
      }
      if(req.method==='GET'&&/^\/studio\/nfas\/nfa-[1-9][0-9]*\/manifest$/.test(path)){
        const identity=await sdk.get(path.split('/')[3]);
        send(res,200,await publishedManifest({hash:identity.manifestHash,uri:identity.manifestUri,manifests}));return;
      }
      if(req.method==='GET'&&path==='/studio/published-manifest'){
        const params=new URL(req.url,'http://localhost').searchParams;
        send(res,200,await publishedManifest({hash:params.get('hash'),uri:params.get('uri')||'',manifests}));return;
      }
      if(req.method==='GET'&&/^\/studio\/images\/[0-9a-f]{64}$/.test(path)){
        const bytes=await publishedBytes(new URL(req.url,'http://localhost').searchParams.get('uri'));
        const hash='sha256:'+createHash('sha256').update(bytes).digest('hex');
        if(hash!=='sha256:'+path.split('/')[3]||bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')throw Error('Published image checksum mismatch');
        res.writeHead(200,{'content-type':'image/png','cache-control':'public, max-age=31536000, immutable'});res.end(bytes);return;
      }
      if(req.method==='GET'&&/^\/studio\/nfas\/nfa-[1-9][0-9]*\/jobs\/[1-9][0-9]*$/.test(path)){
        const [, , , tokenId, , rawId]=path.split('/'),jobId=Number(rawId);
        if(!Number.isSafeInteger(jobId))throw Error('Invalid job ID');
        const optional=async work=>{try{return await work()}catch{return null}};
        const [service,paid,memory]=await Promise.all([
          optional(()=>sdk.getServiceJob(tokenId,jobId)),optional(()=>sdk.getPaidJob(tokenId,jobId)),
          optional(()=>sdk.getMemoryReceipt(tokenId,jobId))]);
        send(res,service||paid?200:404,{service,paid,memory,status:paid?.status||'NOT_FOUND'});return;
      }
      if(req.method==='POST'&&path==='/studio/appearance'){
        send(res,200,await publishAppearance({sdk,renderer,manifests,artifacts,body:await input(req)}));return;
      }
      if(['GET','POST'].includes(req.method)&&/^\/studio\/nfas\/nfa-[1-9][0-9]*\/work\/[1-9][0-9]*$/.test(path)){
        const parts=path.split('/'),tokenId=parts[3],jobId=Number(parts[5]);
        if(!Number.isSafeInteger(jobId))throw Error('Invalid job ID');
        const session=/^Bearer ([0-9a-f]{64})$/.exec(req.headers.authorization||'')?.[1];
        if(!session){send(res,401,{error:'owner_session_required'});return}
        await access.requireOwner(session,tokenId);
        const record=await sdk.getServiceJob(tokenId,jobId);
        if(record?.job?.status!=='FINALIZED')throw Error('Work not finalized');
        let result;
        if(req.method==='POST'){
          const body=await input(req),releases=JSON.parse(await readFile(releaseCatalogPath,'utf8')).releases;
          result=await materializeWork({sdk,store,tokenId,jobId,startHash:body.startHash,sender:body.sender,releases});
        }else result={artifact:await store.get(record.job.output_hash),outputHash:record.job.output_hash};
        await access.requireOwner(session,tokenId);send(res,200,result);return;
      }
      if(req.method==='GET'&&/^\/studio\/artifacts\/[0-9a-f]{64}\.png$/.test(path)){
        const bytes=await artifacts.getImage(path.slice(18,-4));
        res.writeHead(200,{'content-type':'image/png','cache-control':'public, max-age=31536000, immutable',
          'x-content-type-options':'nosniff'});res.end(bytes);return;
      }
      if(req.method==='GET'&&path==='/requests'){
        const url=new URL(req.url||'/', 'http://localhost');
        const owner=url.searchParams.get('owner')||'',requestId=url.searchParams.get('requestId')||'';
        if(!/^[a-z0-9._-]{2,64}$/.test(owner)||!requestId||requestId.length>64)throw Error('Invalid request lookup');
        const tokenId=await sdk.view(sdk.registryAccountId,'request_token',{owner,request_id:requestId});
        const [nft,provision]=tokenId?await Promise.all([
          sdk.view(sdk.registryAccountId,'nft_token',{token_id:tokenId}),
          sdk.view(sdk.registryAccountId,'pending_provision',{token_id:tokenId})]):[null,null];
        send(res,200,{tokenId,minted:!!nft,owner:nft?.owner_id,provision,
          recovery:provision?.failed?'admin_verification_required':null});return;
      }
      if(req.method==='POST'&&path==='/preview'){
        const body=await input(req);validateTraits(body.traits||{},await characterCatalog());
        const result=await renderer.render(body);send(res,200,result);return;
      }
      if(req.method==='POST'&&path==='/job-inputs'){
        const hashes=await inputs.put(await input(req));
        send(res,200,{...hashes,minFeeYocto:'10000000000000000000000'});return;
      }
      if(req.method==='GET'&&/^\/preview\/[0-9a-f]{64}\.png$/.test(path)){
        const key=path.slice(9,-4),bytes=await renderer.image(key);
        res.writeHead(200,{'content-type':'image/png','cache-control':'public, max-age=31536000, immutable',
          'x-content-type-options':'nosniff'});res.end(bytes);return;
      }
      if(req.method==='POST'&&path==='/manifests'){
        const {previewKey,displayName,description='',templateId='scout'}=await input(req);
        if(!['scout','compare','both'].includes(templateId))throw Error('Unknown creation template');
        if(typeof displayName!=='string'||!displayName.trim()||displayName.length>64)throw Error('Invalid name');
        if(typeof description!=='string'||description.length>240)throw Error('Invalid description');
        const serviceIds=templateId==='both'?['scout','compare']:[templateId];
        const templates=await Promise.all(serviceIds.map(async id=>JSON.parse(id==='scout'?await templateLoader():await readFile(compareTemplatePath,'utf8'))));
        const preview=await renderer.get(previewKey),template=templates[0];
        const catalog=await characterCatalog();validateTraits(preview.metadata.traits,catalog);
        const image=await artifacts.putImage(await renderer.image(previewKey));
        const cutout=await artifacts.putImage(await renderer.cutout(previewKey));
        if(image.hash!==preview.imageHash)throw Error('Character image hash changed');
        const skillHash='sha256:'+createHash('sha256').update(JSON.stringify(template.skill)).digest('hex');
        const manifest={schemaVersion:2,revision:0,template:`${templateId}@1.0.0`,displayName:displayName.trim(),description:description.trim(),
          publicCharacter:{collection:'nfa-v2',seed:preview.seed,renderSeed:preview.metadata.seed,traits:preview.metadata.traits,
            rendererVersion:catalog.rendererVersion,assetDigest:catalog.assetDigest,
            imageHash:image.hash,imageUri:image.uri,cutoutHash:cutout.hash,cutoutUri:cutout.uri,previewKey},
          skills:templates.map(t=>({id:t.skill.id,version:t.skill.version,hash:'sha256:'+createHash('sha256').update(JSON.stringify(t.skill)).digest('hex')})),
          services:serviceIds.map(id=>({id,schemaHash:schemaHashFor(id),activation:'owner-review-required'})),
          verifiedCredentials:[],access:[{provider:'scout-workspace',transfer:'LIVE_CHECK'}]};
        const saved=await manifests.put(manifest);
        send(res,200,{manifestHash:saved.outputHash,manifestUri:`nfa://manifest/${saved.outputHash.slice(7)}`,
          manifest,previewUrl:preview.imageUrl});return;
      }
      if(req.method==='GET'&&/^\/manifests\/[0-9a-f]{64}$/.test(path)){
        send(res,200,await manifests.get('sha256:'+path.slice(11)));return;
      }
      if(req.method==='POST'&&path==='/auth/challenge'){
        const body=await input(req);send(res,200,access.challenge(body.accountId,body.tokenId,{studio:body.studio===true}));return;
      }
      if(req.method==='POST'&&path==='/auth/session'){
        send(res,200,await access.authorize(await input(req)));return;
      }
      if(req.method==='POST'&&path==='/prepare'){
        const body=await input(req);
        if(body.kind==='outlayer_activate'){
          const project=await sdk.getOutlayerProject(body.tokenId);
          const catalog=JSON.parse(await readFile(releaseCatalogPath,'utf8'));
          const release=catalog.releases.find(r=>r.versionKey===project?.candidate_version);
          if(!release||(await verifyRelease(release)).activationAllowed!==true)throw Error('Hosted Scout, Compare and recall evidence required before activation');
        }
        send(res,200,{unsignedAction:prepare(sdk,body)});return;
      }
      const parts=path.split('/').filter(Boolean);
      if(req.method==='GET'&&/^\/v1\/nfas\/nfa-[1-9][0-9]*\/research$/.test(path)){
        send(res,200,{configuration:await sdk.getResearchConfig(parts[2]),budget:await sdk.view(sdk.registryAccountId,'research_budget',{token_id:parts[2]}),
          vaultCapable:await sdk.view(sdk.registryAccountId,'research_vault_capable',{token_id:parts[2]})});return;
      }
      if(req.method==='GET'&&/^\/v1\/nfas\/nfa-[1-9][0-9]*\/(economics|inventory)$/.test(path)){
        const snapshot=await studioNfa(sdk,parts[2],{servicePolicy});
        send(res,200,parts[3]==='economics'?snapshot.economics:snapshot.inventory);return;
      }
      if(req.method==='GET'&&/^\/v1\/nfas\/nfa-[1-9][0-9]*\/holdings$/.test(path)){
        const identity=await sdk.get(parts[2]);
        send(res,200,{near:await sdk.getTreasury(parts[2]),sepolia:!identity.foreignWallet?null:!evmRpcUrl?
          {address:identity.foreignWallet.address,balanceWei:null,freshness:'rpc_not_configured'}:
          await sepoliaHoldings({address:identity.foreignWallet.address,rpcUrl:evmRpcUrl})});return;
      }
      if(parts[0]==='v1'&&parts[1]==='nfas'&&TOKEN.test(parts[2]||'')&&parts[3]==='services'){
        const id=parts[2],service=parts[4];
        if(req.method==='GET'&&parts.length===4){send(res,200,await listServices({sdk,tokenId:id,policy:servicePolicy}));return}
        if(!['scout','compare','research'].includes(service)){send(res,404,{error:'service_not_found'});return}
        if(req.method==='POST'&&parts[5]==='quotes'&&parts.length===6){
          send(res,200,await quoteService({sdk,tokenId:id,service,body:await input(req),policy:servicePolicy}));return;
        }
        if(parts[5]==='jobs'&&parts.length===7&&/^[1-9][0-9]*$/.test(parts[6])){
          const jobId=Number(parts[6]);
          if(!Number.isSafeInteger(jobId)){send(res,400,{error:'invalid_job_id'});return}
          if(req.method==='GET'){
            const record=await sdk.getServiceJob(id,jobId);
            const job=record?.service_id===service?record:null;
            send(res,job?200:404,job||{error:'not_found'});return;
          }
        }
        if(parts[5]==='jobs'&&parts.length===8&&/^[1-9][0-9]*$/.test(parts[6])&&parts[7]==='prepare-start'&&req.method==='POST'){
          send(res,200,await prepareServiceStart({sdk,tokenId:id,service,jobId:Number(parts[6]),
            inputData:(await input(req)).inputData}));return;
        }
      }
      if(req.method==='GET'&&parts[0]==='nfas'&&TOKEN.test(parts[1]||'')){
        const id=parts[1],url=new URL(req.url||'/', 'http://localhost');
        if(parts.length===2){
          const identity=await sdk.get(id);
          let treasury=null;try{treasury=await sdk.getTreasury(id)}catch{}
          send(res,200,{identity,treasury,treasuryFreshness:treasury?'finalized_near_view':'unavailable'});return;
        }
        if(parts[2]==='history'&&parts.length===3){
          const from=Number(url.searchParams.get('from')||1),limit=Number(url.searchParams.get('limit')||20);
          send(res,200,{operations:await sdk.getHistory(id,from,limit),from,limit});return;
        }
        if(parts[2]==='jobs'&&parts.length===4&&/^\d+$/.test(parts[3])){
          const job=await sdk.getJob(id,Number(parts[3]));send(res,job?200:404,job||{error:'not_found'});return;
        }
        if(parts[2]==='work'&&parts.length===4&&/^\d+$/.test(parts[3])){
          const bearer=/^Bearer ([0-9a-f]{64})$/.exec(req.headers.authorization||'');
          if(!bearer){send(res,401,{error:'owner_session_required'});return}
          await access.requireOwner(bearer[1],id);
          const job=await sdk.getJob(id,Number(parts[3]));
          if(!job||job.status!=='FINALIZED'||!job.output_hash){send(res,404,{error:'work_not_finalized'});return}
          send(res,200,{artifact:await store.get(job.output_hash),outputHash:job.output_hash});return;
        }
      }
      if(req.method==='GET'&&path==='/market'){
        const url=new URL(req.url||'/', 'http://localhost');
        const from=Number(url.searchParams.get('from')||0),limit=Number(url.searchParams.get('limit')||12);
        if(!Number.isSafeInteger(from)||from<0||!Number.isSafeInteger(limit)||limit<1||limit>25)throw Error('Invalid pagination');
        const tokens=await sdk.view(sdk.registryAccountId,'nft_tokens',{from_index:String(from),limit});
        const results=await Promise.all(tokens.map(async t=>sdk.get(t.token_id)));
        send(res,200,{items:results.filter(x=>x.listing&&x.lifecycle==='LISTED'),from,limit});return;
      }
      send(res,404,{error:'not_found'});
    }catch(error){
      const message=String(error.message||error);
      send(res,/owner|session|signature|Challenge|Ownership/.test(message)?401:400,{error:message});
    }
  });
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const registryAccountId=process.env.NFA_REGISTRY_ID||'nfagent-registry-0e9b2a.testnet';
  const rpcUrl=process.env.NEAR_RPC_URL||'https://rpc.testnet.near.org';
  const deployment=deploymentConfig(),{port,origin,host}=deployment;
  const sdk=new NfaSdk({registryAccountId,rpcUrl});
  const access=new AccessService({sdk,origin,verifyKey:args=>verifyNearFullAccessKey({...args,rpcUrl})});
  const data=resolve(deployment.data);
  const objects=configuredObjects();
  const store=new WorkStore(resolve(data,'work'),{objects});
  const servicePolicy={scout:process.env.NFA_SCOUT_POLICY_JSON?JSON.parse(process.env.NFA_SCOUT_POLICY_JSON):null,
    compare:process.env.NFA_COMPARE_POLICY_JSON?JSON.parse(process.env.NFA_COMPARE_POLICY_JSON):null,
    research:process.env.NFA_RESEARCH_POLICY_JSON?JSON.parse(process.env.NFA_RESEARCH_POLICY_JSON):null};
  const server=createApiServer({sdk,store,access,renderer:new AvatarRenderer(resolve(data,'render')),
    manifests:new WorkStore(resolve(data,'manifests'),{objects,namespace:'manifests'}),artifacts:new ArtifactStore(resolve(data,'artifacts'),{objects}),
    inputs:new InputStore(resolve(data,'inputs')),servicePolicy,deployment,readyCheck:readiness({sdk,data}),evmRpcUrl:process.env.EVM_RPC_URL});
  const stop=()=>{server.close(()=>process.exit(0));setTimeout(()=>process.exit(1),10000).unref()};
  process.once('SIGTERM',stop);process.once('SIGINT',stop);
  listenStudio(server,port,host).then(()=>console.log(`NFA API at ${origin}/studio`))
    .catch(error=>{console.error(error.message);process.exitCode=1});
}
