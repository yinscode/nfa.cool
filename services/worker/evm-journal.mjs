import {randomBytes} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,open,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {keccak_256} from '@noble/hashes/sha3';
import {observeSettlement} from './settlement.mjs';

const txHash=raw=>'0x'+Buffer.from(keccak_256(Buffer.from(raw.slice(2),'hex'))).toString('hex');
const MAX_ATTEMPTS=8;
const validRaw=raw=>typeof raw==='string'&&/^0x[0-9a-fA-F]+$/.test(raw)&&raw.length%2===0;
export class EvmJournal {
  constructor(directory){this.directory=directory}
  // Attempt 0 is the original transaction (legacy file name); attempt k is the k-th
  // same-nonce replacement signed by the vault.
  path(tokenId,id,attempt=0){if(!/^nfa-[1-9][0-9]*$/.test(tokenId)||!Number.isSafeInteger(id)||id<1||
      !Number.isSafeInteger(attempt)||attempt<0||attempt>MAX_ATTEMPTS)throw Error('Invalid operation identity');
    return join(this.directory,attempt===0?`${tokenId}-${id}.json`:`${tokenId}-${id}-r${attempt}.json`)}
  async get(tokenId,id,attempt=0){try{const record=JSON.parse(await readFile(this.path(tokenId,id,attempt),'utf8'));return {attempt,...record}}
    catch(error){if(error.code==='ENOENT')return null;throw error}}
  /** Every journaled candidate for one operation, in attempt order. */
  async list(tokenId,id){const records=[];
    for(let attempt=0;attempt<=MAX_ATTEMPTS;attempt++){const record=await this.get(tokenId,id,attempt);if(!record)break;records.push(record)}
    return records}
  async write(tokenId,id,record){
    await mkdir(this.directory,{recursive:true,mode:0o700});
    const attempt=record.attempt??0;
    const target=this.path(tokenId,id,attempt),lock=target+'.lock',tmp=target+'.'+randomBytes(8).toString('hex')+'.tmp';
    const handle=await open(lock,'wx',0o600);
    try{
      const prior=await this.get(tokenId,id,attempt);
      if(prior&&(prior.hash!==record.hash||prior.nonce!==record.nonce||prior.sender!==record.sender))
        throw Error('Conflicting journal update');
      if(prior?.state==='CONFIRMED'&&record.state!=='CONFIRMED')throw Error('Cannot regress confirmed journal');
      await writeFile(tmp,JSON.stringify(record)+'\n',{mode:0o600});await rename(tmp,target);
      return record;
    }finally{await handle.close();await unlink(lock)}
  }
  async saveSigned(tokenId,id,{raw,nonce,sender},attempt=0){
    if(!validRaw(raw)||!Number.isSafeInteger(nonce)||nonce<0||!/^0x[0-9a-fA-F]{40}$/.test(sender))throw Error('Invalid signed transaction');
    const hash=txHash(raw),path=this.path(tokenId,id,attempt);
    await mkdir(this.directory,{recursive:true,mode:0o700});
    const record={attempt,hash,raw,nonce,sender,state:'SIGNED',observation:null};
    try{const handle=await open(path,'wx',0o600);
      try{await handle.writeFile(JSON.stringify(record)+'\n');await handle.sync()}finally{await handle.close()}
      return record;
    }catch(error){if(error.code!=='EEXIST')throw error}
    const prior=await this.get(tokenId,id,attempt);
    if(!prior||prior.hash!==hash||prior.nonce!==nonce||prior.sender.toLowerCase()!==sender.toLowerCase())
      throw Error('Conflicting transaction for operation');
    return prior;
  }
}

export async function submitAndObserve({journal,tokenId,id,signed,attempt=0,rpcUrl,fetchImpl=fetch,minConfirmations=3n,timeoutMs=8000}){
  const record=await journal.saveSigned(tokenId,id,signed,attempt); // durable before network side effect
  if(record.state==='CONFIRMED')return record.observation;
  const rpc=async(method,params)=>{const response=await fetchImpl(rpcUrl,{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(timeoutMs)});if(!response.ok)throw Error(`RPC HTTP ${response.status}`);
    const result=await response.json();if(result.error)throw Error(result.error.message);return result.result};
  try{
    if(await rpc('eth_chainId',[])!=='0xaa36a7')return {state:'UNCERTAIN',reason:'wrong_chain',hash:record.hash};
    const observed=await rpc('eth_getTransactionByHash',[record.hash]);
    if(!observed){const returned=await rpc('eth_sendRawTransaction',[record.raw]);
      if(returned.toLowerCase()!==record.hash.toLowerCase())throw Error('Broadcast hash mismatch')}
    await journal.write(tokenId,id,{...record,state:'BROADCAST'});
  }catch(error){return {state:'UNCERTAIN',reason:'broadcast_unknown',hash:record.hash,detail:String(error)}}
  const observation=await observeSettlement({rpcUrl,txHash:record.hash,expectedSender:record.sender,
    expectedNonce:record.nonce,minConfirmations,timeoutMs,fetchImpl});
  if(observation.state==='CONFIRMED')await journal.write(tokenId,id,{...record,state:'CONFIRMED',observation});
  return observation;
}
