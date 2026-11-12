import {secp256k1} from '@noble/curves/secp256k1';
import {keccak_256} from '@noble/hashes/sha3';
import {utils} from 'near-api-js';

const keccak=x=>Buffer.from(keccak_256(x));
function rlpBytes(data){if(data.length===1&&data[0]<128)return data;
  if(data.length>55)throw Error('Oversized RLP field');return Buffer.concat([Buffer.from([128+data.length]),data])}
function rlpList(parts){const body=Buffer.concat(parts);
  if(body.length<=55)return Buffer.concat([Buffer.from([192+body.length]),body]);
  if(body.length>=256)throw Error('Oversized signed transaction');
  return Buffer.concat([Buffer.from([248,body.length]),body])}
const trim=data=>data.subarray(data.findIndex(x=>x!==0));

/** Verify the MPC result against the vault-derived key before constructing raw EIP-1559 bytes. */
export function assembleEvmTransfer({pending,derivedPublicKey,expectedAddress,expectedId,expectedNonce}){
  const op=pending?.Evm;
  if(!op||op.id!==expectedId||op.nonce!==expectedNonce||!op.signature||op.uncertain)
    throw Error('No finalized signature for expected operation');
  const sig=JSON.parse(Buffer.from(op.signature).toString());
  if(sig.scheme!=='Secp256k1'||![0,1].includes(sig.recovery_id))throw Error('Unsupported MPC signature');
  const unsigned=Buffer.from(op.unsigned),digest=keccak(unsigned);
  if(unsigned[0]!==2||!digest.equals(Buffer.from(op.digest)))throw Error('Unsigned EVM digest mismatch');
  const r=Buffer.from(sig.big_r.affine_point.slice(2),'hex'),s=Buffer.from(sig.s.scalar,'hex');
  if(r.length!==32||s.length!==32)throw Error('Invalid signature scalars');
  const compact=Buffer.concat([r,s]);
  const pub=Buffer.from(utils.serialize.base_decode(derivedPublicKey.replace(/^secp256k1:/,'')));
  if(pub.length!==64||!secp256k1.verify(compact,digest,Buffer.concat([Buffer.from([4]),pub])))
    throw Error('MPC signature did not verify');
  const recovered=Buffer.from(secp256k1.Signature.fromCompact(compact).addRecoveryBit(sig.recovery_id).recoverPublicKey(digest).toRawBytes(false));
  if(!recovered.subarray(1).equals(pub))throw Error('Wrong MPC recovery key');
  const sender='0x'+keccak(pub).subarray(12).toString('hex');
  if(sender.toLowerCase()!==expectedAddress.toLowerCase())throw Error('Derived sender mismatch');
  const encoded=unsigned.subarray(1),head=encoded[0];
  const body=head<=247?encoded.subarray(1):encoded.subarray(2);
  if((head<=247?head-192:encoded[1])!==body.length)throw Error('Malformed unsigned EIP-1559 list');
  const raw=Buffer.concat([Buffer.from([2]),rlpList([body,rlpBytes(sig.recovery_id===0?Buffer.alloc(0):Buffer.from([1])),
    rlpBytes(trim(r)),rlpBytes(trim(s))])]);
  return {raw:'0x'+raw.toString('hex'),hash:'0x'+keccak(raw).toString('hex'),sender,nonce:op.nonce};
}
