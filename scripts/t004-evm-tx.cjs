#!/usr/bin/env node
// Verify the vault MPC result and construct a signed Sepolia EIP-1559 transaction.
const fs = require('node:fs');
const {secp256k1} = require('@noble/curves/secp256k1');
const {keccak_256} = require('@noble/hashes/sha3');
const {utils} = require('near-api-js');

const evidence = JSON.parse(fs.readFileSync('deployments/t004-signature-public.json'));
const vault = JSON.parse(fs.readFileSync('deployments/t004-vault-public.json'));
const sig = JSON.parse(evidence.signature);
if (sig.scheme !== 'Secp256k1' || ![0, 1].includes(sig.recovery_id)) throw Error('Unsupported MPC signature');
const unsigned = Buffer.from(evidence.unsigned_tx.slice(2), 'hex');
if (unsigned[0] !== 2) throw Error('Not EIP-1559');
const digest = Buffer.from(keccak_256(unsigned));
if ('0x' + digest.toString('hex') !== evidence.digest) throw Error('MPC digest mismatch');
const r = Buffer.from(sig.big_r.affine_point.slice(2), 'hex');
const s = Buffer.from(sig.s.scalar, 'hex');
if (r.length !== 32 || s.length !== 32) throw Error('Invalid signature length');
const compact = Buffer.concat([r, s]);
const expectedPub = Buffer.from(utils.serialize.base_decode(vault.derived_public_key.split(':')[1]));
if (expectedPub.length !== 64) throw Error('Expected raw secp256k1 key');
if (!secp256k1.verify(compact, digest, Buffer.concat([Buffer.from([4]), expectedPub]))) throw Error('MPC signature did not verify');
const recovered = Buffer.from(secp256k1.Signature.fromCompact(compact).addRecoveryBit(sig.recovery_id).recoverPublicKey(digest).toRawBytes(false));
if (!recovered.subarray(1).equals(expectedPub)) throw Error('Wrong recovery ID or key');
const derived = '0x' + Buffer.from(keccak_256(expectedPub)).subarray(12).toString('hex');
if (derived.toLowerCase() !== vault.sepolia_evm_address.toLowerCase()) throw Error('Derived sender mismatch');

function bytes(b) {
  if (b.length === 1 && b[0] < 128) return b;
  if (b.length <= 55) return Buffer.concat([Buffer.from([128 + b.length]), b]);
  throw Error('Oversized RLP field');
}
function list(parts) {
  const body = Buffer.concat(parts);
  return body.length <= 55 ? Buffer.concat([Buffer.from([192 + body.length]), body]) :
    Buffer.concat([Buffer.from([248, body.length]), body]);
}
const unsignedRlp = unsigned.subarray(1);
const head = unsignedRlp[0];
const body = head <= 247 ? unsignedRlp.subarray(1) : unsignedRlp.subarray(2);
if ((head <= 247 ? head - 192 : unsignedRlp[1]) !== body.length) throw Error('Malformed unsigned RLP list');
const encoded = Buffer.concat([Buffer.from([2]), list([body,
  bytes(Buffer.from([sig.recovery_id])),
  bytes(r.subarray(r.findIndex(x => x !== 0))),
  bytes(s.subarray(s.findIndex(x => x !== 0))),
])]);
const txHash = '0x' + Buffer.from(keccak_256(encoded)).toString('hex');
fs.writeFileSync('deployments/t004-evm-raw.json', JSON.stringify({raw: '0x'+encoded.toString('hex'),tx_hash:txHash},null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({verified:true,sender:derived,digest:evidence.digest,tx_hash:txHash,
  nonce:evidence.nonce,recipient:evidence.recipient,value_wei:evidence.value_wei,raw_file:'deployments/t004-evm-raw.json'}));
