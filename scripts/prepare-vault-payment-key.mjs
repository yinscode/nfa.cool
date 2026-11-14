#!/usr/bin/env node
// Prepare one restricted OutLayer Payment Key. Never prints the secret or retries an existing file.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash,randomBytes} from 'node:crypto';
import {NfaSdk} from '@nfa/sdk';
import {paymentKeyEncryptionKey,sealOutlayerPaymentKey} from '../services/worker/outlayer-secrets.mjs';

const vault='nfa-2.nfagent-registry-0e9b2a.testnet',tokenId='nfa-2';
const registry='nfagent-registry-0e9b2a.testnet',projectId=`${vault}/scout`;
const path='.data/outlayer-payment-key-nfa-2.private.json';
const sdk=new NfaSdk({registryAccountId:registry,rpcUrl:process.env.NEAR_RPC_URL||'https://test.rpc.fastnear.com'});
const [identity,project,nonce,setup]=await Promise.all([
  sdk.get(tokenId),sdk.getOutlayerProject(tokenId),
  sdk.view('outlayer.testnet','get_next_payment_key_nonce',{account_id:vault}),
  sdk.view(registry,'payment_key_setup',{token_id:tokenId}).catch(()=>null)]);
if(identity?.vaultAccountId!==vault||project?.project_id!==projectId||project?.state!=='READY')
  throw Error('Vault or OutLayer Project changed');
if(!Number.isSafeInteger(nonce)||nonce<1||setup&&setup.state!=='FAILED')
  throw Error('Payment Key nonce invalid or issuance already approved');
try{await readFile(path);throw Error(`Private Payment Key package already exists at ${path}`)}
catch(error){if(error.code!=='ENOENT')throw error}
const secret=randomBytes(32).toString('hex');
// OutLayer encodes USD limits in six decimal micro-units: $0.10 per call.
const secrets={key:secret,project_ids:[projectId],max_per_call:'100000',initial_balance:'0'};
const pubkey=await paymentKeyEncryptionKey({owner:vault,nonce,secrets});
const ciphertext=sealOutlayerPaymentKey(pubkey,secrets);
const ciphertextHash=createHash('sha256').update(ciphertext).digest('hex');
await mkdir('.data',{recursive:true});
await writeFile(path,JSON.stringify({network:'testnet',owner:vault,nonce,projectIds:[projectId],
  maxPerCallMicrousd:secrets.max_per_call,apiKey:`${vault}:${nonce}:${secret}`,
  encryptedSecretsBase64:ciphertext,ciphertextHash,createdAt:new Date().toISOString()},null,2)+'\n',
  {flag:'wx',mode:0o600});
console.log(JSON.stringify({privateFile:path,owner:vault,nonce,projectId,
  maxPerCallMicrousd:secrets.max_per_call,ciphertextHash,
  next:'NFT owner approves this ciphertext hash; operator submits the encrypted package after the upgrade'}));
