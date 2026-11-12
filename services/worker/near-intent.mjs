import {mkdir,open,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';

/** Signed NEAR intent is fsynced before submission. Unknown outcomes replay exact bytes. */
export class NearIntentWallet{
  constructor({directory,accountId,sign,rpc}){Object.assign(this,{directory,accountId,sign,rpc})}
  async send(label,action){
    if(!/^[a-z0-9-]{1,100}$/.test(label))throw Error('Invalid intent label');
    const commitment=createHash('sha256').update(JSON.stringify(action)).digest('hex');
    await mkdir(this.directory,{recursive:true,mode:0o700});
    const path=join(this.directory,label+'.json');let record;
    try{record=JSON.parse(await readFile(path,'utf8'))}catch(e){if(e.code!=='ENOENT')throw e}
    if(!record){
      const signed=await this.sign(action);
      const h=await open(path,'wx',0o600);
      record={commitment,accountId:this.accountId,...signed};
      try{await h.writeFile(JSON.stringify(record));await h.sync()}finally{await h.close()}
    }
    if(record.commitment!==commitment||record.accountId!==this.accountId)throw Error('Conflicting NEAR intent');
    const inspect=async()=>{
      try{const value=await this.rpc('tx',{tx_hash:record.hash,sender_account_id:this.accountId,wait_until:'FINAL'});
        if(value?.final_execution_status!=='FINAL')return null;
        if(value.status?.Failure)throw Object.assign(Error('Finalized reporter action failed; inspect the private intent'),{finalized:true});
        return {state:'FINAL',hash:record.hash};
      }catch(e){if(e.finalized)throw e;return null}
    };
    const prior=await inspect();if(prior)return prior;
    try{await this.rpc('send_tx',{signed_tx_base64:record.signedTxBase64,wait_until:'INCLUDED_FINAL'})}catch{}
    return await inspect()||{state:'UNCERTAIN',hash:record.hash};
  }
}
