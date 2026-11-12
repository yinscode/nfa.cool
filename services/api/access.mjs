import {createHash,randomBytes} from 'node:crypto';
import {ed25519} from '@noble/curves/ed25519';
import {utils} from 'near-api-js';

const u32=value=>{const bytes=Buffer.alloc(4);bytes.writeUInt32LE(value);return bytes};
const borshString=value=>{const bytes=Buffer.from(value,'utf8');return Buffer.concat([u32(bytes.length),bytes])};

/** NEP-413: tag + Borsh payload, SHA-256, then Ed25519. */
export function nep413Digest({message,nonce,recipient,callbackUrl}){
  if(typeof message!=='string'||typeof recipient!=='string'||!Buffer.isBuffer(nonce)||nonce.length!==32)
    throw Error('Invalid NEP-413 payload');
  return createHash('sha256').update(Buffer.concat([u32(2**31+413),borshString(message),nonce,
    borshString(recipient),callbackUrl===undefined?Buffer.from([0]):Buffer.concat([Buffer.from([1]),borshString(callbackUrl)])])).digest();
}

export async function verifyNearFullAccessKey({rpcUrl,accountId,publicKey,signature,message,nonce,recipient,callbackUrl,fetchImpl=fetch}){
  if(!/^ed25519:[1-9A-HJ-NP-Za-km-z]+$/.test(publicKey)||typeof signature!=='string')return false;
  const bytes=utils.serialize.base_decode(publicKey.slice(8));
  if(bytes.length!==32)return false;
  const sig=Buffer.from(signature,'base64');
  if(sig.length!==64||!ed25519.verify(sig,nep413Digest({message,nonce,recipient,callbackUrl}),bytes))return false;
  const response=await fetchImpl(rpcUrl,{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:'access',method:'query',params:{request_type:'view_access_key',
      finality:'final',account_id:accountId,public_key:publicKey}})});
  if(!response.ok)return false;
  const json=await response.json();
  return !json.error&&json.result?.permission==='FullAccess';
}

/** Short-lived session checked against current NFT owner/epoch on every access. */
export class AccessService {
  constructor({sdk,origin,verifyKey,now=Date.now}){
    this.sdk=sdk;this.origin=origin;this.now=now;this.verifyKey=verifyKey;
    this.challenges=new Map();this.sessions=new Map();
  }
  challenge(accountId,tokenId,{studio=false}={}){
    if(!/^[a-z0-9._-]{2,64}$/.test(accountId)||!/^nfa-[1-9][0-9]*$/.test(tokenId))throw Error('Invalid account/token');
    const id=randomBytes(16).toString('hex'), nonce=randomBytes(32), expiresAt=this.now()+60_000;
    const message=`nfa.gent access\norigin:${this.origin}\nregistry:${this.sdk.registryAccountId}\naccount:${accountId}\ntoken:${tokenId}\nnonce:${id}\nexpires:${expiresAt}`;
    const recipient=this.origin,callbackUrl=this.origin+(studio?'/studio?token='+encodeURIComponent(tokenId):'/');
    this.challenges.set(id,{accountId,tokenId,message,nonce,recipient,callbackUrl,expiresAt});
    return {challengeId:id,message,nonce:nonce.toString('base64'),recipient,callbackUrl,expiresAt};
  }
  async authorize({challengeId,accountId,publicKey,signature,state}){
    const challenge=this.challenges.get(challengeId);
    this.challenges.delete(challengeId);
    if(!challenge||this.now()>=challenge.expiresAt)throw Error('Challenge expired or used');
    if((accountId&&accountId!==challenge.accountId)||(state&&state!==challengeId))throw Error('Challenge account/state mismatch');
    const valid=await this.verifyKey({accountId:challenge.accountId,publicKey,signature,message:challenge.message,
      nonce:challenge.nonce,recipient:challenge.recipient,callbackUrl:challenge.callbackUrl});
    if(!valid)throw Error('Invalid wallet signature/key');
    const agent=await this.sdk.get(challenge.tokenId);
    if(agent.ownerAccountId!==challenge.accountId)throw Error('Current NFT owner required');
    const session=randomBytes(32).toString('hex');
    this.sessions.set(session,{accountId:challenge.accountId,tokenId:challenge.tokenId,epoch:agent.ownerEpoch,expiresAt:this.now()+300_000});
    return {session,expiresAt:this.now()+300_000};
  }
  async requireOwner(session,tokenId){
    const record=this.sessions.get(session);
    if(!record||record.tokenId!==tokenId||this.now()>=record.expiresAt)throw Error('Session missing or expired');
    const agent=await this.sdk.get(tokenId);
    if(agent.ownerAccountId!==record.accountId||agent.ownerEpoch!==record.epoch){this.sessions.delete(session);throw Error('Ownership changed');}
    return record.accountId;
  }
}
