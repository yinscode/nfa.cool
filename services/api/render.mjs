import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,mkdir,rename,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const run=promisify(execFile), root=fileURLToPath(new URL('../../',import.meta.url));
const allowed=new Set(['body','palette','expression','tool','eyewear','attachment','ornament','hat','finish','marking','background','frame']);
const digest=x=>createHash('sha256').update(x).digest('hex');
export class AvatarRenderer {
  constructor(directory){this.directory=directory;this.inflight=new Map()}
  async render({seed,traits={}}){
    if(typeof seed!=='string'||!/^[a-zA-Z0-9_-]{1,64}$/.test(seed)||!traits||typeof traits!=='object'||Array.isArray(traits))
      throw Error('Invalid avatar seed/traits');
    const ordered=Object.fromEntries(Object.entries(traits).sort(([a],[b])=>a.localeCompare(b)));
    for(const [key,value] of Object.entries(ordered))
      if(!allowed.has(key)||typeof value!=='string'||!/^[a-z-]{1,32}$/.test(value))throw Error('Invalid avatar trait');
    const catalog=await readFile(join(root,'assets/catalog.json'));
    const key=digest(JSON.stringify({renderer:'2.0.0',assetCatalog:digest(catalog),seed,traits:ordered}));
    if(this.inflight.has(key))return this.inflight.get(key);
    if(this.inflight.size>=4)throw Error('Renderer busy');
    const task=this.generate(key,seed,ordered).finally(()=>this.inflight.delete(key));
    this.inflight.set(key,task);return task;
  }
  async generate(key,seed,traits){
    const dir=join(this.directory,key);
    try{return await this.result(key,dir)}catch(error){if(error.code!=='ENOENT')throw error}
    await mkdir(this.directory,{recursive:true,mode:0o700});
    const temp=join(this.directory,key+'.'+process.pid+'.tmp');
    await rm(temp,{recursive:true,force:true});
    try{
      const args=[join(root,'generate.cjs'),'--count','1','--size','512','--seed',seed,'--out',temp];
      for(const [name,value] of Object.entries(traits))args.push('--set',`${name}=${value}`);
      await run(process.execPath,args,{cwd:root,timeout:30000,maxBuffer:1_000_000});
      await rename(temp,dir);
    }catch(error){await rm(temp,{recursive:true,force:true});if(!['EEXIST','ENOTEMPTY'].includes(error.code))throw error}
    return this.result(key,dir);
  }
  async result(key,dir){
    const metadata=JSON.parse(await readFile(join(dir,'metadata/001.json'),'utf8'));
    const image=await readFile(join(dir,'images/001.png'));
    if(digest(image)!==metadata.image_sha256)throw Error('Avatar checksum mismatch');
    const baseSeed=/^([a-zA-Z0-9_-]{1,64}):001:[0-9]+$/.exec(metadata.seed||'')?.[1];
    if(!baseSeed)throw Error('Avatar base seed unavailable');
    return {key,seed:baseSeed,metadata,imageHash:'sha256:'+metadata.image_sha256,imageUrl:`/preview/${key}.png`};
  }
  async image(key){
    if(!/^[0-9a-f]{64}$/.test(key))throw Error('Invalid preview key');
    return readFile(join(this.directory,key,'images/001.png'));
  }
  async cutout(key){
    if(!/^[0-9a-f]{64}$/.test(key))throw Error('Invalid preview key');
    return readFile(join(this.directory,key,'cutouts/001.png'));
  }
  async get(key){
    if(!/^[0-9a-f]{64}$/.test(key))throw Error('Invalid preview key');
    return this.result(key,join(this.directory,key));
  }
}
