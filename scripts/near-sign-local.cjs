#!/usr/bin/env node
// Signs a reviewed testnet transaction locally. Output and secret files are ignored.
const fs = require('node:fs');
const crypto = require('node:crypto');
const near = require('near-api-js');
const [keyName, receiver, blockHash, nextNonce, specFile, outName] = process.argv.slice(2);
if (!/^[a-z0-9-]+$/.test(keyName ?? '') || !/^[a-z0-9-]+$/.test(outName ?? '') ||
    !/^[0-9a-z._-]{2,64}$/.test(receiver ?? '') || !/^\d+$/.test(nextNonce ?? '')) {
  console.error('Usage: node scripts/near-sign-local.cjs KEY_NAME RECEIVER BLOCK_HASH NEXT_NONCE SPEC_FILE OUTPUT_NAME');
  process.exit(2);
}
const record = JSON.parse(fs.readFileSync(`deployments/${keyName}.key.json`));
const priv = crypto.createPrivateKey(record.private_key_pkcs8_pem);
const pub = crypto.createPublicKey(priv).export({format:'der',type:'spki'}).subarray(-32);
const derivedPublic = 'ed25519:' + near.utils.serialize.base_encode(pub);
if (record.public_key ? record.public_key !== derivedPublic : record.account_id !== pub.toString('hex')) {
  throw Error('Key mismatch');
}
const seed = priv.export({format:'der',type:'pkcs8'}).subarray(-32);
const kp = near.KeyPair.fromString('ed25519:' + near.utils.serialize.base_encode(Buffer.concat([seed,pub])));
const spec = JSON.parse(fs.readFileSync(specFile));
if (!Array.isArray(spec.actions) || spec.actions.length < 1 || spec.actions.length > 5) throw Error('Invalid actions');
const actions = spec.actions.map(a => {
  switch(a.type) {
    case 'transfer': return near.transactions.transfer(BigInt(a.yocto));
    case 'deploy': return near.transactions.deployContract(fs.readFileSync(a.wasm));
    case 'call': return near.transactions.functionCall(a.method,a.args,
      BigInt(a.gas ?? '100000000000000'),BigInt(a.deposit ?? '0'));
    case 'deleteKey': return near.transactions.deleteKey(kp.getPublicKey());
    default: throw Error('Unsupported action');
  }
});
const tx = near.transactions.createTransaction(record.account_id,kp.getPublicKey(),receiver,
  BigInt(nextNonce),actions,near.utils.serialize.base_decode(blockHash));
const digest = crypto.createHash('sha256').update(tx.encode()).digest();
const sig = new near.transactions.Signature({keyType:0,data:kp.sign(digest).signature});
const encoded = Buffer.from(new near.transactions.SignedTransaction({transaction:tx,signature:sig}).encode()).toString('base64');
const path = `deployments/${outName}.signed.json`;
fs.writeFileSync(path,JSON.stringify({sender:record.account_id,receiver,hash:near.utils.serialize.base_encode(digest),signed_tx_base64:encoded},null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({sender:record.account_id,receiver,hash:near.utils.serialize.base_encode(digest),bytes:encoded.length,path}));
