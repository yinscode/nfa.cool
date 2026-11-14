#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {connect,KeyPair,keyStores,transactions,utils} from 'near-api-js';
import {NfaSdk} from '@nfa/sdk';
import {EvmJournal} from '../services/worker/evm-journal.mjs';
import {NearIntentWallet} from '../services/worker/near-intent.mjs';
import {settleEvmTick,sepoliaHoldings} from '../services/worker/evm-settler.mjs';

const tokenId=process.argv[2],send=process.argv.includes('--send'),watch=process.argv.includes('--watch');
if(!/^nfa-[1-9][0-9]*$/.test(tokenId||'')||process.argv.slice(3).some(x=>!['--send','--watch'].includes(x)))
  throw Error('Usage: node scripts/settle-evm.mjs nfa-1 [--send] [--watch]');
const rpcUrl=process.env.NEAR_RPC_URL||'https://test.rpc.fastnear.com';
// Comma-separated independent providers; every one must confirm the same finalized receipt.
const evmRpcs=(process.env.EVM_RPC_URLS||process.env.EVM_RPC_URL||'').split(',').map(s=>s.trim()).filter(Boolean),evmRpc=evmRpcs[0];
if(!evmRpc)throw Error('EVM_RPC_URLS (or EVM_RPC_URL) required');
if(evmRpcs.length<2)console.error(JSON.stringify({warning:'single EVM RPC: finality is trusted to one provider; set EVM_RPC_URLS'}));
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
  if(!reporterId)throw Error('NFA_SETTLEMENT_REPORTER_ACCOUNT_ID required');
  const keyDir=resolve(process.env.NFA_SETTLEMENT_REPORTER_KEY_DIR||'deployments');
  const accounts=new Map();
  for(const [name,receiver,methods] of [['registry',sdk.registryAccountId,['mark_evm_broadcast','reconcile_evm','retry_evm_signature']],
    [tokenId,`${tokenId}.${sdk.registryAccountId}`,['report_evm_receipt']]]){
    const record=JSON.parse(await readFile(resolve(keyDir,`reporter-${name}.key.json`),'utf8'));
    if(record.account_id!==reporterId||record.receiver_id!==receiver||
      JSON.stringify(record.method_names)!==JSON.stringify(methods))throw Error(`Restricted reporter key ${name} mismatches the receiver`);
    const pair=KeyPair.fromString(record.secret_key);
    if(pair.getPublicKey().toString()!==record.public_key)throw Error(`Reporter key ${name} public key mismatch`);
    const live=(await rpc('query',{request_type:'view_access_key',finality:'final',account_id:reporterId,public_key:record.public_key})).permission;
    if(live?.FunctionCall?.receiver_id!==receiver||JSON.stringify(live.FunctionCall.method_names)!==JSON.stringify(methods))
      throw Error(`Reporter key ${name} has unexpected on-chain permission`);
    const store=new keyStores.InMemoryKeyStore();await store.setKey('testnet',reporterId,pair);
    const near=await connect({networkId:'testnet',nodeUrl:rpcUrl,deps:{keyStore:store}});
    accounts.set(receiver,await near.account(reporterId));
  }
  const data=resolve(process.env.NFA_DATA_DIR||'.data');
  const wallet=new NearIntentWallet({directory:resolve(data,'evm-reporter'),accountId:reporterId,rpc,
    sign:async a=>{const account=accounts.get(a.receiverId);if(!account)throw Error('Reporter receiver is not allowlisted');
      const [hash,signed]=await account.signTransaction(a.receiverId,[transactions.functionCall(a.methodName,a.args,BigInt(a.gas),0n)]);
      return {hash:utils.serialize.base_encode(hash),signedTxBase64:Buffer.from(signed.encode()).toString('base64')}}});
  const journal=new EvmJournal(resolve(data,'evm-settlement'));
  let stopped=false;process.once('SIGINT',()=>{stopped=true});process.once('SIGTERM',()=>{stopped=true});
  do{
    try{console.log(JSON.stringify({tokenId,...await settleEvmTick({sdk,journal,wallet,reporterId,tokenId,rpcUrls:evmRpcs})}))}
    catch(error){console.error(JSON.stringify({tokenId,state:'BLOCKED',reason:error.message}));if(!watch)process.exitCode=1}
    if(watch&&!stopped)await new Promise(resolve=>setTimeout(resolve,5000));
  }while(watch&&!stopped);
}
