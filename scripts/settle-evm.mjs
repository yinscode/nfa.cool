#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {connect,KeyPair,keyStores,transactions,utils} from 'near-api-js';
import {NfaSdk} from '@nfa/sdk';
import {EvmJournal} from '../services/worker/evm-journal.mjs';
import {NearIntentWallet} from '../services/worker/near-intent.mjs';
import {settleEvmTick,sepoliaHoldings} from '../services/worker/evm-settler.mjs';
import {createPrivateKey,createPublicKey} from 'node:crypto';

const tokenId=process.argv[2],send=process.argv.includes('--send'),watch=process.argv.includes('--watch');
if(!/^nfa-[1-9][0-9]*$/.test(tokenId||'')||process.argv.slice(3).some(x=>!['--send','--watch'].includes(x)))
  throw Error('Usage: node scripts/settle-evm.mjs nfa-1 [--send] [--watch]');
const rpcUrl=process.env.NEAR_RPC_URL||'https://test.rpc.fastnear.com',evmRpc=process.env.EVM_RPC_URL;
if(!evmRpc)throw Error('EVM_RPC_URL required');
const rpc=async(method,params)=>{
  const r=await fetch(rpcUrl,{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:'settler',method,params}),signal:AbortSignal.timeout(15000)});
  const j=await r.json();if(!r.ok||j.error)throw Error('NEAR RPC unavailable or transaction unresolved');return j.result;
};
if((await rpc('status',[])).chain_id!=='testnet')throw Error('Only NEAR testnet supported');
const sdk=new NfaSdk({registryAccountId:process.env.NFA_REGISTRY_ID||'nfagent-registry-0e9b2a.testnet',rpcUrl});
if(!send){
  const identity=await sdk.get(tokenId);
  console.log(JSON.stringify({tokenId,send:false,pending:await sdk.getAgentState(tokenId),holdings:identity.foreignWallet?
    await sepoliaHoldings({address:identity.foreignWallet.address,rpcUrl:evmRpc}):null}));
}else{
  const reporterId=process.env.NFA_SETTLEMENT_REPORTER_ACCOUNT_ID;
  const keyFile=process.env.NFA_SETTLEMENT_REPORTER_KEY_FILE;
  if(!reporterId||!keyFile)throw Error('Reporter account and private key file required');
  const secret=JSON.parse(await readFile(keyFile,'utf8'));
  if(secret.account_id!==reporterId)throw Error('Reporter key account mismatch');
  let encodedKey=secret.secret_key;
  if(!encodedKey&&secret.private_key_pkcs8_pem){
    const privateKey=createPrivateKey(secret.private_key_pkcs8_pem),pub=createPublicKey(privateKey).export({format:'der',type:'spki'}).subarray(-32);
    const seed=privateKey.export({format:'der',type:'pkcs8'}).subarray(-32);
    encodedKey='ed25519:'+utils.serialize.base_encode(Buffer.concat([seed,pub]));
  }
  const keys=new keyStores.InMemoryKeyStore();await keys.setKey('testnet',reporterId,KeyPair.fromString(encodedKey));
  const near=await connect({networkId:'testnet',nodeUrl:rpcUrl,deps:{keyStore:keys}}),account=await near.account(reporterId);
  const data=resolve(process.env.NFA_DATA_DIR||'.data');
  const wallet=new NearIntentWallet({directory:resolve(data,'evm-reporter'),accountId:reporterId,rpc,
    sign:async a=>{const [hash,signed]=await account.signTransaction(a.receiverId,[transactions.functionCall(a.methodName,a.args,BigInt(a.gas),0n)]);
      return {hash:utils.serialize.base_encode(hash),signedTxBase64:Buffer.from(signed.encode()).toString('base64')}}});
  const journal=new EvmJournal(resolve(data,'evm-settlement'));
  let stopped=false;process.once('SIGINT',()=>{stopped=true});process.once('SIGTERM',()=>{stopped=true});
  do{
    try{console.log(JSON.stringify({tokenId,...await settleEvmTick({sdk,journal,wallet,reporterId,tokenId,rpcUrl:evmRpc})}))}
    catch(error){console.error(JSON.stringify({tokenId,state:'BLOCKED',reason:error.message}));if(!watch)process.exitCode=1}
    if(watch&&!stopped)await new Promise(resolve=>setTimeout(resolve,5000));
  }while(watch&&!stopped);
}
