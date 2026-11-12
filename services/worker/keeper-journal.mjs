import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';

/** Durable claim before submission. An ambiguous send is reconciled, never blindly retried. */
export class KeeperJournal {
  constructor(directory){this.directory=directory}
  path(tokenId,jobId){
    if(!/^nfa-[1-9][0-9]*$/.test(tokenId)||!Number.isSafeInteger(jobId)||jobId<1)throw Error('Invalid job key');
    return join(this.directory,`${tokenId}-${jobId}.json`);
  }
  async claim(tokenId,jobId,inputHash,service){
    await mkdir(this.directory,{recursive:true,mode:0o700});
    const path=this.path(tokenId,jobId);
    try{await writeFile(path,JSON.stringify({tokenId,jobId,inputHash,service,status:'INTENT'})+'\n',
      {flag:'wx',mode:0o600});return true}
    catch(error){if(error.code!=='EEXIST')throw error}
    const old=JSON.parse(await readFile(path,'utf8'));
    if(old.inputHash!==inputHash||old.service!==service)throw Error('Conflicting keeper intent');
    return false;
  }
  async record(tokenId,jobId,status,transaction=null){
    const path=this.path(tokenId,jobId),old=JSON.parse(await readFile(path,'utf8'));
    if(!['SUBMITTED','UNCERTAIN','OBSERVED'].includes(status))throw Error('Invalid keeper status');
    const tmp=path+'.'+randomBytes(8).toString('hex')+'.tmp';
    await writeFile(tmp,JSON.stringify({...old,status,transaction:transaction??old.transaction??null})+'\n',{mode:0o600});
    await rename(tmp,path);
  }
  async get(tokenId,jobId){return JSON.parse(await readFile(this.path(tokenId,jobId),'utf8'))}
}
