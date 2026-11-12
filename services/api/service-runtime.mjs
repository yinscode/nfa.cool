import {createHash} from 'node:crypto';
import {createScoutBrief} from '../worker/scout.mjs';
import {createCompareBrief} from '../worker/compare.mjs';
import {researchInputSchema,validateResearchInput} from '../worker/research.mjs';
import {researchConfiguration} from './research-adapter.mjs';

const NEAR_MIN_MARGIN=10n**22n;
const MAX_DEPOSIT=5n*10n**23n;
const MIN_JOB_DEPOSIT=10n**21n; // Registry floor; the live OutLayer estimate is normally above it.
const sha=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
const positive=value=>typeof value==='string'&&/^[1-9][0-9]*$/.test(value);
const validLimits=value=>value&&Number.isSafeInteger(value.max_instructions)&&value.max_instructions>0&&value.max_instructions<=2_000_000_000&&
  Number.isSafeInteger(value.max_memory_mb)&&value.max_memory_mb>0&&value.max_memory_mb<=128&&
  Number.isSafeInteger(value.max_execution_seconds)&&value.max_execution_seconds>0&&value.max_execution_seconds<=30;
const validPolicy=policy=>policy&&validLimits(policy.limits)&&positive(policy.marginYocto)&&positive(policy.maxDepositYocto)
  &&BigInt(policy.marginYocto)>=NEAR_MIN_MARGIN&&BigInt(policy.maxDepositYocto)<=MAX_DEPOSIT;
const localPolicy=(policy,id)=>policy?.[id]??(id==='scout'?policy:null);
const effectivePolicy=(policy,onchain)=>validPolicy(policy)&&onchain?{...policy,marginYocto:(BigInt(policy.marginYocto)>BigInt(onchain.min_margin)?BigInt(policy.marginYocto):BigInt(onchain.min_margin)).toString()}:policy;
const serviceInfo={scout:{name:'Scout',description:'Cited findings from supplied source text',
  inputSchema:{question:'string (5–240 characters)',sources:'1–8 title, URL, text records'}},
  compare:{name:'Compare',description:'Rank supplied options by evidence coverage',
    inputSchema:{question:'string',criteria:'1–5 criteria',sources:'2–8 option title, URL, text records'}},
  research:{name:'Research',description:'Approved-source retrieval and bounded model inference',inputSchema:{question:'string',sources:'1–3 approved title and HTTPS URL records'}}};
const permitted=(requested,maximum)=>requested.max_instructions<=maximum.max_instructions&&
  requested.max_memory_mb<=maximum.max_memory_mb&&requested.max_execution_seconds<=maximum.max_execution_seconds;
export const serviceSchemas={
  scout:{type:'object',additionalProperties:false,required:['question','sources'],properties:{
    question:{type:'string',minLength:5,maxLength:240},sources:{type:'array',minItems:1,maxItems:8,
      items:{type:'object',additionalProperties:false,required:['title','url','text'],properties:{
        title:{type:'string'},url:{type:'string',format:'uri'},text:{type:'string'}}}}}},
  compare:{type:'object',additionalProperties:false,required:['question','criteria','sources'],properties:{
    question:{type:'string',minLength:5,maxLength:240},criteria:{type:'array',minItems:1,maxItems:5,items:{type:'string'}},
    sources:{type:'array',minItems:2,maxItems:8,items:{type:'object',additionalProperties:false,
      required:['title','url','text'],properties:{title:{type:'string'},url:{type:'string',format:'uri'},text:{type:'string'}}}}}}
};
serviceSchemas.research=researchInputSchema;
export const schemaHashFor=id=>sha(JSON.stringify(serviceSchemas[id]));
export const outputSchemas={
  research:{type:'object',required:['schemaVersion','template','question','findings','sources','priorWork','configurationHash','inference'],properties:{
    schemaVersion:{const:1},template:{const:'research@1.0.0'},question:{type:'string'},
    findings:{type:'array',maxItems:5,items:{type:'object',required:['claim','sourceId','quote']}},
    sources:{type:'array',maxItems:3},priorWork:{type:'array',maxItems:3},configurationHash:{type:'string'},inference:{type:'object'}}},
  scout:{type:'object',required:['schemaVersion','template','question','findings','sources'],properties:{
    schemaVersion:{const:1},template:{const:'scout@1.0.0'},question:{type:'string'},
    findings:{type:'array',maxItems:5,items:{type:'object',required:['claim','sourceId']}},
    sources:{type:'array',maxItems:8,items:{type:'object',required:['id','title','url','contentHash']}}}},
  compare:{type:'object',required:['schemaVersion','template','question','criteria','ranking'],properties:{
    schemaVersion:{const:1},template:{const:'compare@1.0.0'},question:{type:'string'},criteria:{type:'array',maxItems:5},
    ranking:{type:'array',maxItems:8,items:{type:'object',required:['sourceId','title','url','contentHash','matchedCriteria','evidence']}}}}
};
function onchainPolicyCompatible(onchain,policy,id){
  return !!(onchain?.enabled&&policy&&BigInt(policy.marginYocto)>=BigInt(onchain.min_margin)&&
    onchain.schema_hash===schemaHashFor(id)&&BigInt(policy.maxDepositYocto)<=BigInt(onchain.max_deposit)&&permitted(policy.limits,onchain.limits));
}

/** Advertise only executable services; planned skills must not appear as callable. */
export async function listServices({sdk,tokenId,policy}){
  const [project,catalog,agent,treasury]=await Promise.all([sdk.getOutlayerProject(tokenId),sdk.getServiceCatalog(tokenId),
    sdk.getAgentState(tokenId),sdk.getTreasury(tokenId)]);
  const ready=project?.state==='READY'&&typeof project.version_key==='string'&&!!project.project_uuid;
  const unblocked=agent?.lifecycle==='Active'&&agent.pending_op==null;
  const funded=treasury&&BigInt(treasury.available)>0n;
  let researchReady=false;
  if(policy?.research&&ready){try{await researchConfiguration({sdk,tokenId,project});researchReady=true}catch{}}
  return {items:Object.entries(serviceInfo).filter(([id])=>id!=='research'||policy?.research).map(([id,info])=>{
    const onchain=catalog.find(p=>p.service_id===id),local=effectivePolicy(localPolicy(policy,id),onchain);
    // Paid jobs run with the owner's on-chain policy limits; no on-chain policy, no checkout.
    const available=!!((id!=='research'||researchReady)&&ready&&unblocked&&funded&&validPolicy(local)&&onchainPolicyCompatible(onchain,local,id));
    return {id,...info,version:ready?project.version_key:null,available,
      reason:id==='research'&&!researchReady?'research_release_not_ready':!ready?'project_not_ready':!unblocked?'agent_busy':!funded?'vault_low_runway':
        !validPolicy(local)?'quote_policy_not_configured':
        !onchain?'service_not_enabled':!onchainPolicyCompatible(onchain,local,id)?'service_policy_mismatch':null,
      schemaHash:schemaHashFor(id),schema:serviceSchemas[id],quotePolicy:validPolicy(local)?local:null,
      outputSchema:{outputHash:'sha256',outputUri:'nfa://work/<sha256>'}};
  })};
}

/** Wallet checkout. The returned action is unsigned; no REST handler can charge a wallet. */
export async function quoteService({sdk,tokenId,service,body,policy,now=Date.now(),allowResearchCandidate=false}){
  if(!serviceInfo[service])throw Error('Unknown service');
  let local=localPolicy(policy,service);
  if(!validPolicy(local))throw Error('Service quote policy not configured');
  const project=await sdk.getOutlayerProject(tokenId);
  if(project?.state!=='READY'||!project.project_uuid||typeof project.version_key!=='string')throw Error('Project not ready');
  const onchain=await sdk.getServicePolicy(tokenId,service);
  local=effectivePolicy(local,onchain);
  if(!onchainPolicyCompatible(onchain,local,service))throw Error('Service not enabled at quoted policy');
  // The registry requires the job limits to equal the on-chain policy exactly.
  local={...local,limits:onchain.limits};
  const source=body?.input;
  let research=null,inputData;
  if(service==='research'){
    research=await researchConfiguration({sdk,tokenId,project,allowCandidate:allowResearchCandidate});
    validateResearchInput(source,research.settings.allowed_sources.map(r=>({host:r.host,pathPrefix:r.path_prefix})));
    // `useMemory` is a quote option beside `input`, so the pinned input schema hash is unchanged.
    if(body?.useMemory!==undefined&&typeof body.useMemory!=='boolean')throw Error('useMemory must be boolean');
    inputData=JSON.stringify({question:source.question,sources:source.sources,...(body?.useMemory===false?{useMemory:false}:{})});
  }else{
  if(!source||typeof source!=='object'||Array.isArray(source)||
    Object.keys(source).sort().join(',')!==(service==='scout'?'question,sources':'criteria,question,sources'))
    throw Error('Typed service input required');
  if(!Array.isArray(source.sources)||source.sources.some(item=>!item||typeof item!=='object'||Array.isArray(item)||
    Object.keys(item).sort().join(',')!=='text,title,url'))throw Error('Typed service sources required');
  if(service==='scout')createScoutBrief(source);else createCompareBrief(source);
  inputData=JSON.stringify(service==='scout'?{question:source.question,sources:source.sources}:
    {question:source.question,criteria:source.criteria,sources:source.sources});
  }
  if(Buffer.byteLength(inputData)>7_800)throw Error('Service input exceeds on-chain limit');
  // The registry appends operation and assigned jobId later; reserve space for them.
  const estimated=await sdk.view(sdk.registryAccountId.endsWith('.test.near')?'outlayer.test.near':'outlayer.testnet','estimate_execution_cost',{
    resource_limits:local.limits,input_len:Buffer.byteLength(inputData)+(research?Buffer.byteLength(JSON.stringify(research))+1200:128)});
  const estimate=BigInt(estimated);
  if(estimate<=0n)throw Error('OutLayer estimate unavailable');
  const headroom=(estimate*6n+4n)/5n; // 20% headroom for quote drift.
  const depositCap=headroom>MIN_JOB_DEPOSIT?headroom:MIN_JOB_DEPOSIT;
  if(depositCap>BigInt(local.maxDepositYocto))throw Error('OutLayer estimate exceeds service cap');
  const [agent,treasury]=await Promise.all([sdk.getAgentState(tokenId),sdk.getTreasury(tokenId)]);
  if(agent?.lifecycle!=='Active'||agent.pending_op!=null||!treasury||BigInt(treasury.available)<depositCap)
    throw Error('Agent busy or vault lacks execution runway');
  const fee=depositCap+BigInt(local.marginYocto);
  const deadlineNs=Number(BigInt(Math.trunc(now+15*60_000))*1_000_000n);
  const inputHash=sha(inputData);
  return {service,tokenId,inputData,inputHash,versionKey:project.version_key,
    estimateYocto:estimate.toString(),feeYocto:fee.toString(),replenishYocto:depositCap.toString(),
    depositCapYocto:depositCap.toString(),limits:local.limits,deadlineNs,
    policyVersion:onchain.version,...(research?{researchConfigHash:research.configuration_hash,
      memory:{usesPriorWork:body?.useMemory!==false,detail:'Up to three earlier finalized Research jobs of this NFA are supplied as verified source quotations only; set useMemory:false to opt out. This job\'s own verified quotations may inform later jobs.'},
      modelBudget:{currency:'USD',reservationMicrousd:String(research.settings.max_input_tokens*research.settings.input_microusd_per_token+
        research.settings.max_output_tokens*research.settings.output_microusd_per_token),
        maxCostMicrousd:String(research.settings.max_cost_microusd),basis:'configured token rates, not a provider invoice'}}:{}),
    unsignedAction:sdk.requestReviewedServiceJob(tokenId,service,inputHash,deadlineNs,fee.toString(),
        depositCap.toString(),depositCap.toString(),local.limits,project.version_key,onchain.version,research?.configuration_hash)};
}
export const quoteScout=args=>quoteService({...args,service:'scout'});

export async function prepareScoutStart({sdk,tokenId,jobId,inputData}){
  return prepareServiceStart({sdk,tokenId,service:'scout',jobId,inputData,legacy:true});
}
export async function prepareServiceStart({sdk,tokenId,service,jobId,inputData,legacy=false}){
  if(!serviceInfo[service])throw Error('Unknown service');
  if(!Number.isSafeInteger(jobId)||jobId<1||typeof inputData!=='string'||Buffer.byteLength(inputData)>7_800)
    throw Error('Invalid service job input');
  const record=legacy?null:await sdk.getServiceJob(tokenId,jobId);
  const job=legacy?await sdk.getPaidJob(tokenId,jobId):record?.job;
  const project=await sdk.getOutlayerProject(tokenId);
  if(!job||(!legacy&&record?.service_id!==service)||job.status!=='REQUESTED'||project?.state!=='READY'
    ||job.input_hash!==sha(inputData)||job.version_key!==project.version_key
    ||BigInt(Date.now())*1_000_000n>=BigInt(job.deadline_ns))
    throw Error('No matching paid service request');
  return {jobId,inputHash:job.input_hash,unsignedAction:legacy?
    sdk.startPaidScout(tokenId,jobId,inputData):sdk.startServiceJob(tokenId,jobId,inputData)};
}
