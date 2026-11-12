import {mkdir,writeFile,readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
const hash=x=>'sha256:'+createHash('sha256').update(JSON.stringify(x)).digest('hex');

/** Stable vault namespace; staged results enter context only after on-chain finalization. */
export class ResearchMemory{
  constructor({directory,sdk}){Object.assign(this,{directory,sdk})}
  path(context){
    if(!/^[a-z0-9._-]{2,64}$/.test(context.vaultAccountId)||!/^nfa-[1-9][0-9]*$/.test(context.tokenId))throw Error('Invalid memory identity');
    return join(this.directory,context.vaultAccountId);
  }
  async stage(context,value){
    if(!Number.isSafeInteger(context.jobId)||context.jobId<1||hash(value.artifact)!==value.outputHash)throw Error('Invalid staged research');
    const directory=this.path(context);await mkdir(directory,{recursive:true,mode:0o700});const path=join(directory,`${context.jobId}.json`);
    try{await writeFile(path,JSON.stringify(value),{flag:'wx',mode:0o600})}
    catch(e){if(e.code!=='EEXIST')throw e;const prior=JSON.parse(await readFile(path,'utf8'));if(prior.outputHash!==value.outputHash)throw Error('Research output already staged differently')}
  }
  async readFinalized(context,limit=3){
    const identity=await this.sdk.get(context.tokenId);
    if(identity.vaultAccountId!==context.vaultAccountId)throw Error('Memory vault does not match NFT');
    const directory=this.path(context);let files;
    try{files=await readdir(directory)}catch(e){if(e.code==='ENOENT')return [];throw e}
    const ids=files.filter(n=>/^[1-9][0-9]*\.json$/.test(n)).map(n=>Number(n.slice(0,-5)))
      .filter(n=>n<context.jobId&&Number.isSafeInteger(n)).sort((a,b)=>b-a).slice(0,50);
    const rows=[];
    for(const id of ids){
      const record=JSON.parse(await readFile(join(directory,`${id}.json`),'utf8'));
      const job=(await this.sdk.getServiceJob(context.tokenId,id))?.job;
      if(job?.status!=='FINALIZED'||job.output_hash!==record.outputHash||hash(record.artifact)!==record.outputHash)continue;
      rows.push({jobId:id,outputHash:record.outputHash,findings:record.artifact.findings});
      if(rows.length>=Math.min(3,limit))break;
    }
    return rows;
  }
}
