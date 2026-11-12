import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {connect,keyStores,KeyPair} from 'near-api-js';
import {NfaSdk} from '@nfa/sdk';
import {WorkStore} from '../api/work-store.mjs';
import {InputStore} from './input-store.mjs';
import {runScout} from './run-scout.mjs';

/** A separately funded, owner-granted account signs only the typed completion. */
export async function workerWallet({accountId,secretKey,rpcUrl,networkId='testnet'}){
  if(!accountId||!secretKey)throw Error('Worker account and key required');
  const keys=new keyStores.InMemoryKeyStore();
  await keys.setKey(networkId,accountId,KeyPair.fromString(secretKey));
  const near=await connect({networkId,nodeUrl:rpcUrl,deps:{keyStore:keys}});
  const account=await near.account(accountId);
  return {signAndSendTransaction:async action=>{
    const result=await account.functionCall({contractId:action.receiverId,methodName:action.methodName,
      args:action.args,gas:BigInt(action.gas),attachedDeposit:BigInt(action.deposit)});
    if(result.status?.Failure)throw Error('Worker transaction failed');
    return result;
  }};
}

if(process.argv[1]&&resolve(process.argv[1])===new URL(import.meta.url).pathname){
  const [tokenId,jobString,...flags]=process.argv.slice(2);
  if(!/^nfa-[1-9]\d*$/.test(tokenId||'')||!/^\d+$/.test(jobString||'')||flags.some(x=>x!=='--send')){
    console.error('Usage: node services/worker/cli.mjs nfa-1 JOB_ID [--send]');process.exitCode=2;
  }else{
    const data=resolve(process.env.NFA_DATA_DIR||'.data');
    const rpcUrl=process.env.NEAR_RPC_URL||'https://rpc.testnet.near.org';
    const sdk=new NfaSdk({registryAccountId:process.env.NFA_REGISTRY_ID||'nfagent-registry-0e9b2a.testnet',rpcUrl});
    const store=new WorkStore(resolve(data,'work')),inputStore=new InputStore(resolve(data,'inputs'));
    try{
      if(!flags.includes('--send')){
        const job=await sdk.getJob(tokenId,Number(jobString));
        const input=await inputStore.get(job.brief_hash,job.source_hash);
        const {createScoutBrief}=await import('./scout.mjs');
        const result=createScoutBrief(input);
        console.log(JSON.stringify({job,outputHash:result.outputHash,outputUri:result.outputUri,send:false},null,2));
      }else{
        const secretKey=process.env.NFA_WORKER_SECRET_KEY ||
          (process.env.NFA_WORKER_KEY_FILE?JSON.parse(await readFile(process.env.NFA_WORKER_KEY_FILE,'utf8')).secret_key:null);
        const wallet=await workerWallet({accountId:process.env.NFA_WORKER_ID,secretKey,rpcUrl});
        const result=await runScout({sdk,store,inputStore,wallet,tokenId,jobId:Number(jobString)});
        console.log(JSON.stringify({outputHash:result.outputHash,outputUri:result.outputUri},null,2));
      }
    }catch(error){console.error(error.message);process.exitCode=1}
  }
}
