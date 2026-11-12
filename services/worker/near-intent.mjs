import {mkdir,open,readFile,rename,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {withFileLock} from './file-lock.mjs';

/** NEAR rejects a transaction whose reference block is older than about a day; 48 hours is safe. */
export const INTENT_EXPIRY_MS=48*3600_000;

/** Signed NEAR intent is fsynced before submission. Unknown outcomes replay exact bytes. */
export class NearIntentWallet{
  constructor({directory,accountId,sign,rpc,now=Date.now,lockWaitMs=30_000}){Object.assign(this,{directory,accountId,sign,rpc,now,lockWaitMs})}
  /**
   * Signing and submission for one reporter account are serialized across processes, so two
   * settlers cannot draw the same access-key nonce and strand one of their intents.
   */
  async send(label,action){
    if(!/^[a-z0-9-]{1,100}$/.test(label))throw Error('Invalid intent label');
    await mkdir(this.directory,{recursive:true,mode:0o700});
    return withFileLock(join(this.directory,`.${this.accountId}.lock`),()=>this.#send(label,action),{waitMs:this.lockWaitMs});
  }
  async #send(label,action){
    const commitment=createHash('sha256').update(JSON.stringify(action)).digest('hex');
    const path=join(this.directory,label+'.json');let record;
    try{record=JSON.parse(await readFile(path,'utf8'))}catch(e){if(e.code!=='ENOENT')throw e}
    if(record&&record.commitment===commitment&&record.accountId===this.accountId){
      // An intent that never landed and is past NEAR's validity window can never land; it
      // is retired (kept on disk) and the same action is signed again. Reporter calls are
      // state-checked on chain, so a repeat cannot apply twice.
      const created=record.createdAt??(await stat(path)).mtimeMs;
      if(this.now()-created>INTENT_EXPIRY_MS&&!(await this.#inspect(record))){
        await rename(path,join(this.directory,`${label}.expired-${Math.trunc(created)}.json`));record=null;
      }
    }
    if(!record){
      const signed=await this.sign(action);
      const h=await open(path,'wx',0o600);
      record={commitment,accountId:this.accountId,createdAt:this.now(),...signed};
      try{await h.writeFile(JSON.stringify(record));await h.sync()}finally{await h.close()}
    }
    if(record.commitment!==commitment||record.accountId!==this.accountId)throw Error('Conflicting NEAR intent');
    const inspect=()=>this.#inspect(record);
    const prior=await inspect();if(prior)return prior;
    try{await this.rpc('send_tx',{signed_tx_base64:record.signedTxBase64,wait_until:'INCLUDED_FINAL'})}catch{}
    return await inspect()||{state:'UNCERTAIN',hash:record.hash};
  }
  async #inspect(record){
    try{const value=await this.rpc('tx',{tx_hash:record.hash,sender_account_id:this.accountId,wait_until:'FINAL'});
      if(value?.final_execution_status!=='FINAL')return null;
      if(value.status?.Failure)throw Object.assign(Error('Finalized reporter action failed; inspect the private intent'),{finalized:true});
      return {state:'FINAL',hash:record.hash};
    }catch(e){if(e.finalized)throw e;return null}
  }
}
