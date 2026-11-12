import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
const run=promisify(execFile);

/** Private S3 object storage. Credentials use the AWS credential provider chain. */
export class S3Objects{
  constructor({bucket,endpoint,region='us-east-1',prefix='nfa',env=process.env,binary='aws'}){
    if(!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)||!/^[-a-zA-Z0-9/]*$/.test(prefix))throw Error('Invalid object store');
    if(endpoint){const url=new URL(endpoint);if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['127.0.0.1','localhost'].includes(url.hostname)))throw Error('Object endpoint requires HTTPS')}
    Object.assign(this,{bucket,endpoint,region,prefix:prefix.replace(/\/$/,''),env,binary});
  }
  key(key){if(!/^(images|manifests|work)\/[0-9a-f]{64}\.(png|json)$/.test(key))throw Error('Invalid object key');return `${this.prefix}/${key}`}
  async command(args){
    const common=['--no-cli-pager','--region',this.region,...(this.endpoint?['--endpoint-url',this.endpoint]:[])];
    try{return await run(this.binary,[...common,'s3api',...args],{env:this.env,timeout:30_000,maxBuffer:64_000})}
    catch{throw Error('Durable object storage unavailable; check server storage configuration')}
  }
  async put(key,bytes,type){
    const dir=await mkdtemp(join(tmpdir(),'nfa-object-'));const file=join(dir,'body');
    try{await writeFile(file,bytes,{mode:0o600});
      await this.command(['put-object','--bucket',this.bucket,'--key',this.key(key),'--body',file,
        '--content-type',type,'--checksum-sha256',createHash('sha256').update(bytes).digest('base64')]);
    }finally{await rm(dir,{recursive:true,force:true})}
  }
  async get(key){
    const dir=await mkdtemp(join(tmpdir(),'nfa-object-'));const file=join(dir,'body');
    try{await this.command(['get-object','--bucket',this.bucket,'--key',this.key(key),file]);return await readFile(file)}
    finally{await rm(dir,{recursive:true,force:true})}
  }
}
export function configuredObjects(env=process.env){
  return env.NFA_S3_BUCKET?new S3Objects({bucket:env.NFA_S3_BUCKET,endpoint:env.NFA_S3_ENDPOINT,
    region:env.NFA_S3_REGION,prefix:env.NFA_S3_PREFIX||'nfa',env}):null;
}
