#!/usr/bin/env node
// Offline NEAR transaction builder for the live T004 spike. Never prints secrets.
const fs = require('node:fs');
const crypto = require('node:crypto');
const near = require('near-api-js');

const [kind, blockHash, nextNonce] = process.argv.slice(2);
if (!['deploy', 'delete-key', 'request'].includes(kind) || !blockHash || !/^\d+$/.test(nextNonce ?? '')) {
  console.error('Usage: node scripts/t004-sign-tx.cjs deploy|delete-key|request BLOCK_HASH NEXT_NONCE');
  process.exit(2);
}
const vault = JSON.parse(fs.readFileSync('deployments/t004-vault-public.json'));
const signerName = kind === 'request' ? 'operator' : 'vault';
const record = JSON.parse(fs.readFileSync(`deployments/t004-${signerName}.key.json`));
const publicRaw = crypto.createPublicKey(record.private_key_pkcs8_pem).export({format: 'der', type: 'spki'}).subarray(-32);
if (publicRaw.toString('hex') !== record.account_id) throw Error('Key does not match account ID');
const seed = crypto.createPrivateKey(record.private_key_pkcs8_pem).export({format: 'der', type: 'pkcs8'}).subarray(-32);
const key = near.KeyPair.fromString('ed25519:' + near.utils.serialize.base_encode(Buffer.concat([seed, publicRaw])));
const publicKey = key.getPublicKey();
let actions, receiver;
if (kind === 'deploy') {
  const wasm = fs.readFileSync('contracts/vault/target/wasm32-unknown-unknown/release/nfa_t004_vault.wasm');
  receiver = vault.account_id;
  actions = [near.transactions.deployContract(wasm), near.transactions.functionCall('new',
    {operator: JSON.parse(fs.readFileSync('deployments/t004-operator-public.json')).account_id,
      recipient_hex: '0x000000000000000000000000000000000000dEaD'},
    80_000_000_000_000n, 0n)];
} else if (kind === 'delete-key') {
  receiver = vault.account_id;
  actions = [near.transactions.deleteKey(publicKey)];
} else {
  receiver = vault.account_id;
  actions = [near.transactions.functionCall('request_test_transfer',
    {nonce: 0, priority_fee: 1_000_000_000, max_fee: 2_000_000_000},
    140_000_000_000_000n, 0n)];
}
const tx = near.transactions.createTransaction(record.account_id, publicKey, receiver,
  BigInt(nextNonce), actions, near.utils.serialize.base_decode(blockHash));
const signedHash = crypto.createHash('sha256').update(tx.encode()).digest();
const signature = new near.transactions.Signature({keyType: 0, data: key.sign(signedHash).signature});
const signed = new near.transactions.SignedTransaction({transaction: tx, signature});
const encoded = Buffer.from(signed.encode()).toString('base64');
fs.writeFileSync(`deployments/t004-${kind}.signed.json`, JSON.stringify({kind, signer:record.account_id,
  receiver, tx_hash:near.utils.serialize.base_encode(signedHash), signed_tx_base64:encoded}, null, 2)+'\n', {mode: 0o600});
console.log(`Prepared ${kind}: signer ${record.account_id}, receiver ${receiver}, transaction ${near.utils.serialize.base_encode(signedHash)}`);
console.log(`Saved signed transaction to deployments/t004-${kind}.signed.json`);
