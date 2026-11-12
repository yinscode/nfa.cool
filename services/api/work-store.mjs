import {createHash,randomBytes} from 'node:crypto';
import {mkdir,readFile,rename,writeFile} from 'node:fs/promises';
import {join} from 'node:path';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class WorkStore {
  constructor(directory,{objects=null,namespace='work'}={}){Object.assign(this,{directory,objects,namespace})}
  async put(artifact){
    const hash=digest(artifact), path=join(this.directory,hash+'.json');
    const bytes=Buffer.from(JSON.stringify(artifact)+'\n');
    if(this.objects)await this.objects.put(`${this.namespace}/${hash}.json`,bytes,'application/json');
    await mkdir(this.directory,{recursive:true,mode:0o700});
    const tmp=path+'.'+randomBytes(8).toString('hex')+'.tmp';
    await writeFile(tmp,bytes,{mode:0o600});
    try{await rename(tmp,path)}catch(error){throw error}
    return {outputHash:'sha256:'+hash,outputUri:'nfa://work/'+hash};
  }
  async get(outputHash){
    if(!/^sha256:[0-9a-f]{64}$/.test(outputHash))throw Error('Invalid work hash');
    let bytes;try{bytes=await readFile(join(this.directory,outputHash.slice(7)+'.json'))}
    catch(error){if(error.code!=='ENOENT'||!this.objects)throw error;
      bytes=await this.objects.get(`${this.namespace}/${outputHash.slice(7)}.json`)}
    const artifact=JSON.parse(bytes.toString('utf8'));
    if('sha256:'+digest(artifact)!==outputHash)throw Error('Stored work integrity mismatch');
    return artifact;
  }
}
