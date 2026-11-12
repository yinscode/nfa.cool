import {mkdir,open,readFile,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {runResearch} from './research.mjs';
import {ResearchMemory} from './research-memory.mjs';

export async function assertResearchJob(sdk,context){
  const [identity,agent,record,project]=await Promise.all([sdk.get(context.tokenId),sdk.getAgentState(context.tokenId),
    sdk.getServiceJob(context.tokenId,context.jobId),sdk.getOutlayerProject(context.tokenId)]);
  if(identity.ownerEpoch!==context.ownerEpoch||identity.vaultAccountId!==context.vaultAccountId||
    agent.pending_op!==context.jobId||identity.lifecycle!=='ACTIVE'||record?.service_id!=='research'||
    record.job?.epoch!==context.ownerEpoch||record.job.status!=='EXECUTING'||record.job.version_key!==context.versionKey||
    project?.state!=='READY'||project.version_key!==context.versionKey||
    BigInt(record.job.deadline_ns)<=BigInt(Date.now())*1000000n)throw Error('Current research job, epoch or runtime changed');
}

export class ResearchAttempts{
  constructor(directory){this.directory=directory}
  path(c){if(!/^nfa-[1-9][0-9]*$/.test(c.tokenId)||!Number.isSafeInteger(c.jobId)||c.jobId<1||
    !/^[a-z0-9._-]{2,64}$/.test(c.registryAccountId))throw Error('Invalid inference identity');
    return join(this.directory,`${c.registryAccountId}-${c.tokenId}-${c.jobId}.json`)}
  async claim(context,inputHash,reservedCostMicrousd){
    await mkdir(this.directory,{recursive:true,mode:0o700});const path=this.path(context);
    try{const file=await open(path,'wx',0o600);try{await file.writeFile(JSON.stringify({state:'RESERVED',context,inputHash,reservedCostMicrousd,
      actualCostMicrousd:null,currency:'USD',unknownOutcomeRequiresReconciliation:true}));await file.sync()}finally{await file.close()}return true}
    catch(e){if(e.code!=='EEXIST')throw e;return false}
  }
  async complete(context,result){
    const path=this.path(context),prior=JSON.parse(await readFile(path,'utf8'));
    if(JSON.stringify(prior.context)!==JSON.stringify(context))throw Error('Inference context changed');
    await writeFile(path+'.tmp',JSON.stringify({...prior,state:'STAGED',outputHash:result.outputHash,
      pricedUsageCostMicrousd:result.artifact.inference.costMicrousd}),{mode:0o600});await rename(path+'.tmp',path);
  }
}

export function createResearchRunner({sdk,directory,config,fetchImpl=fetch}){
  const memory=new ResearchMemory({sdk,directory:join(directory,'memory')}),attempts=new ResearchAttempts(join(directory,'inference'));
  return async({input,context})=>{
    if(context.registryAccountId!==sdk.registryAccountId)throw Error('Research registry mismatch');
    const record=await sdk.getServiceJob(context.tokenId,context.jobId);
    const {createHash}=await import('node:crypto');
    const committed='sha256:'+createHash('sha256').update(JSON.stringify(input)).digest('hex');
    if(record?.job?.input_hash!==committed)throw Error('Research input is not the paid commitment');
    const result=await runResearch({input,config,context,memory,fetchImpl,
      assertCurrent:c=>assertResearchJob(sdk,c),claimInference:(...args)=>attempts.claim(...args)});
    await attempts.complete(context,result);return result;
  };
}
