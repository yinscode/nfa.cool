import {createHash,randomBytes} from 'node:crypto';
import {mkdir,readFile,rename,writeFile} from 'node:fs/promises';
import {join} from 'node:path';

const hash=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
export class ArtifactStore {
  constructor(directory,{objects=null}={}){Object.assign(this,{directory,objects})}
  async putImage(bytes){
    if(!Buffer.isBuffer(bytes)||bytes.length<100||bytes.length>5_000_000||
      !bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw Error('Invalid PNG');
    const value=hash(bytes),name=value.slice(7)+'.png';
    if(this.objects)await this.objects.put(`images/${name}`,bytes,'image/png');
    await mkdir(this.directory,{recursive:true,mode:0o700});
    const tmp=join(this.directory,'.'+randomBytes(8).toString('hex')+'.tmp');
    await writeFile(tmp,bytes,{mode:0o600});
    try{await rename(tmp,join(this.directory,name))}catch(error){throw error}
    return {hash:value,uri:`nfa://image/${name}`};
  }
  async getImage(hex){
    if(!/^[0-9a-f]{64}$/.test(hex))throw Error('Invalid image hash');
    let bytes;try{bytes=await readFile(join(this.directory,hex+'.png'))}
    catch(error){if(error.code!=='ENOENT'||!this.objects)throw error;bytes=await this.objects.get(`images/${hex}.png`)}
    if(hash(bytes)!=='sha256:'+hex)throw Error('Stored image checksum mismatch');
    return bytes;
  }
}
