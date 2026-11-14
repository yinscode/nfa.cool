import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,createPublicKey,diffieHellman,hkdfSync,createDecipheriv} from 'node:crypto';
import {sealOutlayerSecrets,sealOutlayerPaymentKey,paymentKeyEncryptionKey,researchSecretAccess,researchEncryptionKey} from '../outlayer-secrets.mjs';
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
test('Payment Key encryption requires one vault Project and a finite per-call cap',async()=>{
  const recipient=generateKeyPairSync('x25519'),pub=recipient.publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('hex');
  const owner='nfa-2.registry.testnet',secrets={key:'a'.repeat(64),project_ids:[`${owner}/scout`],
    max_per_call:'100000',initial_balance:'0'};
  const sealed=sealOutlayerPaymentKey(pub,secrets);assert.ok(sealed.length>100);
  assert.throws(()=>sealOutlayerPaymentKey(pub,{...secrets,project_ids:[]}));
  assert.throws(()=>sealOutlayerPaymentKey(pub,{...secrets,max_per_call:'0'}));
  assert.throws(()=>sealOutlayerPaymentKey(pub,{...secrets,initial_balance:'1'}));
  let request;await paymentKeyEncryptionKey({owner,nonce:1,secrets,fetchImpl:async(_url,options)=>{
    request=JSON.parse(options.body);return {ok:true,json:async()=>({pubkey:pub})};}});
  assert.deepEqual(request.accessor,{type:'System',PaymentKey:{}});
  assert.equal(request.owner,owner);assert.equal(request.profile,'1');
});
test('encryption-key lookup sends names without API credential values and access is vault/build bound',async()=>{
  let request;await researchEncryptionKey({owner:'operator.testnet',profile:'research',projectId:'nfa-2.registry.testnet/scout',
    fetchImpl:async(url,options)=>{request=JSON.parse(options.body);return {ok:true,json:async()=>({pubkey:'a'.repeat(64)})}}});
  assert.equal(request.secrets_json.includes('name-validation-only'),true);
  const access=researchSecretAccess('nfa-2.registry.testnet','a'.repeat(64));
  assert.deepEqual(access.Logic.conditions[0],{Predecessor:{condition:{Whitelist:{accounts:['nfa-2.registry.testnet']}}}});
  assert.equal(access.Logic.operator,'And');assert.equal(access.Logic.conditions[1].WasmHash.hash,'a'.repeat(64));
});
