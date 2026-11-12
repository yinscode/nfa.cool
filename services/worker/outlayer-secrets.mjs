// ECIES v1 matches out-layer/outlayer-cli bfea235a src/crypto.rs.
import {generateKeyPairSync,createPublicKey,diffieHellman,hkdfSync,randomBytes,createCipheriv} from 'node:crypto';
export function sealOutlayerSecrets(pubkeyHex,secrets){
  if(!/^[0-9a-f]{64}$/i.test(pubkeyHex)||/^0{64}$/.test(pubkeyHex))throw Error('Invalid X25519 encryption key');
  if(!secrets||Object.entries(secrets).some(([name,value])=>!/^NFA_RESEARCH_(API_KEY|PROVIDER)$/.test(name)||typeof value!=='string'))
    throw Error('Only reviewed research environment values may be sealed');
  const recipient=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b656e032100','hex'),Buffer.from(pubkeyHex,'hex')]),format:'der',type:'spki'});
  const ephemeral=generateKeyPairSync('x25519'),shared=diffieHellman({privateKey:ephemeral.privateKey,publicKey:recipient});
  const key=Buffer.from(hkdfSync('sha256',shared,Buffer.alloc(0),Buffer.from('outlayer-keystore-v1'),32)),nonce=randomBytes(12);
  const cipher=createCipheriv('chacha20-poly1305',key,nonce,{authTagLength:16});
  const encrypted=Buffer.concat([cipher.update(JSON.stringify(secrets),'utf8'),cipher.final(),cipher.getAuthTag()]);
  key.fill(0);shared.fill(0);
  return Buffer.concat([Buffer.from([1]),ephemeral.publicKey.export({format:'der',type:'spki'}).subarray(-32),nonce,encrypted]).toString('base64');
}
export function researchSecretAccess(vault,wasmHash){
  if(!/^nfa-[1-9][0-9]*\.[a-z0-9._-]+\.testnet$/.test(vault)||!/^[0-9a-f]{64}$/.test(wasmHash))throw Error('Reviewed testnet vault/build required');
  return {Logic:{operator:'And',conditions:[{Predecessor:{condition:{Whitelist:{accounts:[vault]}}}},{WasmHash:{hash:wasmHash}}]}};
}
export async function researchEncryptionKey({owner,profile,projectId,fetchImpl=fetch}){
  // The official keystore validates names only; placeholder values keep credentials local.
  const response=await fetchImpl('https://testnet-api.outlayer.ai/secrets/pubkey',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({accessor:{type:'Project',project_id:projectId},owner,profile,
      secrets_json:JSON.stringify({NFA_RESEARCH_API_KEY:'name-validation-only',NFA_RESEARCH_PROVIDER:'name-validation-only'})}),signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw Error(`Research encryption key unavailable (HTTP ${response.status})`);
  const result=await response.json();if(!/^[0-9a-f]{64}$/i.test(result.pubkey))throw Error('Encryption key response invalid');return result.pubkey;
}
