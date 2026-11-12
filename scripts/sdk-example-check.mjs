#!/usr/bin/env node
import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import {resolve} from 'node:path';
import {NfaSdk,NfaServicesClient} from '@nfa/sdk';
import {createAndRun} from '../examples/create-and-run.mjs';
const baseUrl=process.env.NFA_STUDIO_URL||'http://127.0.0.1:3102';
if(!['127.0.0.1','localhost'].includes(new URL(baseUrl).hostname))throw Error('This example check is local sandbox only');
const api=new NfaServicesClient({baseUrl}),config=await api.request('/config');
if(!config.localSandbox||config.network!=='sandbox')throw Error('Local sandbox wallet required');
const file=resolve('.data/sdk-example-v2-'+config.workspace.id+'.json');
const checkpoint={load:async()=>{try{return JSON.parse(await readFile(file,'utf8'))}catch(e){if(e.code==='ENOENT')return null;throw e}},
  save:async state=>{await mkdir(resolve('.data'),{recursive:true,mode:0o700});await writeFile(file+'.tmp',JSON.stringify(state),{mode:0o600});await rename(file+'.tmp',file)}};
const wallet=accountId=>({signAndSendTransaction:async action=>{
  const response=await fetch(baseUrl+'/dev/wallet/transaction',{method:'POST',headers:{'content-type':'application/json','x-nfa-local-wallet':'1'},
    body:JSON.stringify({accountId,action})});
  const value=await response.json();if(!response.ok)throw Error(value.error||'Sandbox wallet failed');return value;
}});
const sdk=new NfaSdk({registryAccountId:config.registryAccountId,rpcUrl:config.rpcUrl});
const result=await createAndRun({sdk,baseUrl,ownerId:'alice.test.near',ownerWallet:wallet('alice.test.near'),
  customerId:'customer.test.near',customerWallet:wallet('customer.test.near'),requestId:'sdk-foundation-example-v2',displayName:'SDK Research',
  input:{question:'How does an NFT retain its account?',sources:[{title:'Stable account',url:'https://example.org/account',
    text:'An NFT retains its stable account after ownership changes. Its buyer controls the same vault and its eligible service memory.'}]},
  maxCustomerFeeYocto:'500000000000000000000000',checkpoint});
console.log(JSON.stringify({tokenId:result.tokenId,jobId:result.jobId,status:result.job.status,mode:'sandbox_receipts_outlayer_mock'}));
