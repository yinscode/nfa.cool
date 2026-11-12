import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {keccak_256} from '@noble/hashes/sha3';
import {assembleEvmTransfer} from '../assemble-evm.mjs';
import {secp256k1} from '@noble/curves/secp256k1';
import {utils} from 'near-api-js';

const evidence=JSON.parse(readFileSync(new URL('./fixtures/mpc-public.json',import.meta.url)));
const vault=evidence;
test('verified historical MPC signature assembles the recorded Sepolia transaction',()=>{
  const unsigned=Buffer.from(evidence.unsigned_tx.slice(2),'hex');
  const digest=Buffer.from(keccak_256(unsigned));
  const pending={Evm:{id:1,nonce:0,signature:[...Buffer.from(evidence.signature)],unsigned:[...unsigned],digest:[...digest],uncertain:false}};
  const result=assembleEvmTransfer({pending,derivedPublicKey:vault.derived_public_key,
    expectedAddress:vault.sepolia_evm_address,expectedId:1,expectedNonce:0});
  assert.equal(result.hash,'0xa4c4ddd3948a1d6dfb443d8193bd0ea13ac6801c5bd1bea0a53fadd659fd7c8a');
  assert.throws(()=>assembleEvmTransfer({pending,derivedPublicKey:vault.derived_public_key,
    expectedAddress:'0x'+'0'.repeat(40),expectedId:1,expectedNonce:0}),/sender mismatch/);
});
test('EIP-1559 zero recovery parity uses canonical empty RLP integer',()=>{
  const unsigned=Buffer.from(evidence.unsigned_tx.slice(2),'hex'),digest=Buffer.from(keccak_256(unsigned));
  let signature,key;
  for(let i=1;i<100;i++){
    key=Buffer.alloc(32);key[31]=i;signature=secp256k1.sign(digest,key);
    if(signature.recovery===0&&signature.r.toString(16).length===64&&signature.s.toString(16).length===64)break;
  }
  assert.equal(signature.recovery,0);
  const pub=Buffer.from(secp256k1.getPublicKey(key,false)).subarray(1),address='0x'+Buffer.from(keccak_256(pub)).subarray(12).toString('hex');
  const sig={scheme:'Secp256k1',recovery_id:0,big_r:{affine_point:'02'+signature.r.toString(16)},s:{scalar:signature.s.toString(16)}};
  const result=assembleEvmTransfer({pending:{Evm:{id:1,nonce:0,signature:[...Buffer.from(JSON.stringify(sig))],unsigned:[...unsigned],digest:[...digest],uncertain:false}},
    derivedPublicKey:'secp256k1:'+utils.serialize.base_encode(pub),expectedAddress:address,expectedId:1,expectedNonce:0});
  assert.ok(result.raw.endsWith('80a0'+signature.r.toString(16)+'a0'+signature.s.toString(16)));
});
