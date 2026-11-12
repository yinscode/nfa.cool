import {NfaSdk} from '@nfa/sdk';
const registryAccountId='nfagent-registry-0e9b2a.testnet';
const sdk=new NfaSdk({registryAccountId,rpcUrl:'https://test.rpc.fastnear.com'});
const optional=async work=>{try{return await work()}catch{return null}};
export const testnetViewConfig={serverVersion:3,registryAccountId,rpcUrl:sdk.rpcUrl,network:'testnet',readOnly:true,workspace:{id:'near-testnet',persistent:true}};
export async function verifiedManifest(identity){
  const uri=new URL(identity.manifestUri);
  if(uri.protocol!=='https:'||uri.hostname!=='test.fastfs.io')throw Error('This manifest is hosted outside the public testnet artifact adapter');
  const response=await fetch(uri,{redirect:'error',signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw Error('Published manifest unavailable');
  const bytes=new Uint8Array(await response.arrayBuffer());if(bytes.length>1048576)throw Error('Manifest too large');
  const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');
  if('sha256:'+hash!==identity.manifestHash)throw Error('Manifest checksum mismatch');
  return JSON.parse(new TextDecoder().decode(bytes));
}
async function snapshot(id){
  const identity=await sdk.get(id);
  const [agent,treasury,project,services,history,chainKey,transactionPolicy,grants,pages,audit,vaultState]=await Promise.all([
    sdk.getAgentState(id),optional(()=>sdk.view(identity.vaultAccountId,'treasury')),optional(()=>sdk.getOutlayerProject(id)),optional(()=>sdk.getServiceCatalog(id)),
    Promise.resolve([]),optional(()=>sdk.getChainKey(id)),optional(()=>sdk.view(registryAccountId,'transaction_policy',{token_id:id})),
    optional(()=>sdk.view(registryAccountId,'studio_grants',{token_id:id})),optional(()=>sdk.view(registryAccountId,'studio_page',{token_id:id,from:1,limit:50})),
    optional(()=>sdk.view(registryAccountId,'studio_audit',{token_id:id,from:1,limit:50})),optional(()=>sdk.view(identity.vaultAccountId,'outlayer_status'))]);
  const hostProject=project?.project_id?await optional(()=>sdk.view('outlayer.testnet','get_project',{project_id:project.project_id})):null;
  const agreement=!!(project&&vaultState?.project?.project_uuid===project.project_uuid&&hostProject?.uuid===project.project_uuid&&hostProject?.active_version===project.version_key&&vaultState?.project?.version_key===project.version_key);
  return {identity,agent,treasury,project,services:services||[],history:history||[],chainKey,transactionPolicy,grants:grants||[],
    jobs:pages?.rows||[],audit:audit?.rows||[],vaultState,hostProject,projectAgreement:agreement,
    policies:Object.fromEntries((services||[]).map(p=>[p.service_id,p])),availability:[],financial:null,financialComplete:false,recovery:[],payout:null,
    runtimeGate:agreement?'identity_verified':'unavailable',capabilities:{writable:false},
    readOnlyReason:'Public testnet view uses your browser’s RPC connection. Owner mutations and checkout require a working testnet API.'};
}
export async function readTestnet(path){
  const url=new URL(path,location.origin),p=url.pathname;
  if(p==='/config')return testnetViewConfig;
  if(p==='/studio/discover'){
    const items=await sdk.view(registryAccountId,'nft_tokens',{from_index:url.searchParams.get('from')||'0',limit:12});
    return {items:await Promise.all(items.map(async t=>{
      const agent=await sdk.getAgentState(t.token_id),n={tokenId:t.token_id,ownerAccountId:t.owner_id,
        lifecycle:String(agent.lifecycle).toUpperCase(),vaultAccountId:agent.vault_id,manifestHash:agent.manifest_hash,manifestUri:agent.manifest_uri};
      const [project,manifest]=await Promise.all([optional(()=>sdk.getOutlayerProject(t.token_id)),optional(()=>verifiedManifest(n))]);
      return {...n,displayName:manifest?.displayName||n.tokenId,publicCharacter:manifest?.publicCharacter,
        setupStatus:project?.state==='READY'?'Runtime ready':'NFT minted · setup incomplete'};
    })),next:items.length===12?Number(url.searchParams.get('from')||0)+12:null};
  }
  if(p==='/studio/owned'){
    const rows=await sdk.view(registryAccountId,'nft_tokens_for_owner',{account_id:url.searchParams.get('owner'),from_index:'0',limit:25});
    return {items:await Promise.all(rows.map(t=>sdk.get(t.token_id)))};
  }
  if(p==='/studio/published-manifest')return verifiedManifest({manifestUri:url.searchParams.get('uri'),manifestHash:url.searchParams.get('hash')});
  const match=/^\/studio\/nfas\/(nfa-[1-9][0-9]*)(\/manifest)?$/.exec(p);
  if(match)return match[2]?verifiedManifest(await sdk.get(match[1])):snapshot(match[1]);
  const job=/^\/studio\/nfas\/(nfa-[1-9][0-9]*)\/jobs\/([1-9][0-9]*)$/.exec(p);
  if(job){const [service,paid,memory]=await Promise.all([sdk.getServiceJob(job[1],+job[2]),sdk.getPaidJob(job[1],+job[2]),sdk.getMemoryReceipt(job[1],+job[2])]);return {service,paid,memory,status:paid?.status}}
  throw Error('This operation needs the testnet API. The public testnet viewer is read-only.');
}
