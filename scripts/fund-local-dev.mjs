#!/usr/bin/env node
// Explicit local faucet. Never called automatically by the API or a testnet flow.
import {readFile} from 'node:fs/promises';
import {connect,KeyPair,keyStores} from 'near-api-js';
const accountId=process.argv[2],amount=process.argv[3]||'20';
if(!['alice.test.near','bob.test.near','customer.test.near'].includes(accountId)||!/^([1-9]|[1-9][0-9])$/.test(amount))
  throw Error('Usage: node scripts/fund-local-dev.mjs alice.test.near [1..99 testNEAR]');
const runtime=JSON.parse(await readFile('.data/sandbox-chain/studio-runtime.json'));
if(!['127.0.0.1','localhost'].includes(new URL(runtime.rpcUrl).hostname))throw Error('Only loopback sandbox accepted');
const r=await fetch(runtime.rpcUrl,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'status',params:[]})});
const status=(await r.json()).result;
if(status?.genesis_hash!==runtime.genesisHash||!String(status.chain_id).startsWith('test-chain')&&!['sandbox','test_chain'].includes(status.chain_id))
  throw Error('Persistent local sandbox identity mismatch');
const root=JSON.parse(await readFile('.data/sandbox-chain/validator_key.json'));
const keys=new keyStores.InMemoryKeyStore();await keys.setKey('sandbox','test.near',KeyPair.fromString(root.secret_key));
const near=await connect({networkId:'sandbox',nodeUrl:runtime.rpcUrl,deps:{keyStore:keys}});
const tx=await (await near.account('test.near')).sendMoney(accountId,BigInt(amount)*10n**24n);
if(tx.status?.Failure)throw Error('Local faucet transfer failed');
console.log(JSON.stringify({mode:'local_sandbox_only',accountId,testNear:amount,transaction:tx.transaction.hash}));
