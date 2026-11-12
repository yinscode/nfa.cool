import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,createPublicKey,diffieHellman,hkdfSync,createDecipheriv} from 'node:crypto';
import {sealOutlayerSecrets,researchSecretAccess,researchEncryptionKey} from '../outlayer-secrets.mjs';
test('ECIES envelope uses the official v1 key derivation and authenticated format',()=>{
  const recipient=generateKeyPairSync('x25519'),pub=recipient.publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('hex');
  const values={NFA_RESEARCH_API_KEY:'synthetic-test-credential',NFA_RESEARCH_PROVIDER:'near-ai'};
  const sealed=Buffer.from(sealOutlayerSecrets(pub,values),'base64');assert.equal(sealed[0],1);
  const ephemeral=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b656e032100','hex'),sealed.subarray(1,33)]),format:'der',type:'spki'});
  const key=Buffer.from(hkdfSync('sha256',diffieHellman({privateKey:recipient.privateKey,publicKey:ephemeral}),Buffer.alloc(0),Buffer.from('outlayer-keystore-v1'),32));
  const decrypt=bytes=>{const d=createDecipheriv('chacha20-poly1305',key,bytes.subarray(33,45),{authTagLength:16});d.setAuthTag(bytes.subarray(-16));return Buffer.concat([d.update(bytes.subarray(45,-16)),d.final()])};
  assert.deepEqual(JSON.parse(decrypt(sealed)),values);const tampered=Buffer.from(sealed);tampered[46]^=1;assert.throws(()=>decrypt(tampered));
  assert.throws(()=>sealOutlayerSecrets(pub,{PRIVATE_SIGNING_KEY:'x'}));
});
test('encryption-key lookup sends names without API credential values and access is vault/build bound',async()=>{
  let request;await researchEncryptionKey({owner:'operator.testnet',profile:'research',projectId:'nfa-2.registry.testnet/scout',
    fetchImpl:async(url,options)=>{request=JSON.parse(options.body);return {ok:true,json:async()=>({pubkey:'a'.repeat(64)})}}});
  assert.equal(request.secrets_json.includes('name-validation-only'),true);
  const access=researchSecretAccess('nfa-2.registry.testnet','a'.repeat(64));
  assert.deepEqual(access.Logic.conditions[0],{Predecessor:{condition:{Whitelist:{accounts:['nfa-2.registry.testnet']}}}});
  assert.equal(access.Logic.operator,'And');assert.equal(access.Logic.conditions[1].WasmHash.hash,'a'.repeat(64));
});
