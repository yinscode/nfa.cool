#!/usr/bin/env node
import {readFile,writeFile} from 'node:fs/promises';
import {KeyPair,keyStores,connect,transactions} from 'near-api-js';
import {testnet} from './testnet-lib.mjs';

const ctx=await testnet('deployments/async-research-reporter.json'),operator=await ctx.signer('t004-operator');
const receiver='nfagent-registry-0e9b2a.testnet',methods=['bind_async_research_call','settle_async_research_job'];
const path='deployments/reporter-async-research.key.json';
let record;try{record=JSON.parse(await readFile(path,'utf8'))}catch(error){if(error.code!=='ENOENT')throw error;
  const pair=KeyPair.fromRandom('ed25519');record={account_id:operator.id,receiver_id:receiver,
    method_names:methods,public_key:pair.getPublicKey().toString(),secret_key:pair.toString()};
  await writeFile(path,JSON.stringify(record,null,2)+'\n',{mode:0o600})}
if(record.account_id!==operator.id||record.receiver_id!==receiver||
  JSON.stringify(record.method_names)!==JSON.stringify(methods)||
  KeyPair.fromString(record.secret_key).getPublicKey().toString()!==record.public_key)
  throw Error('Restricted reporter key record changed');
const pair=KeyPair.fromString(record.secret_key);
await ctx.send('addAsyncResearchReporterKey',operator,operator.id,[transactions.addKey(pair.getPublicKey(),
  transactions.functionCallAccessKey(receiver,methods,null))]);
const keys=(await ctx.rpc('query',{request_type:'view_access_key_list',finality:'final',account_id:operator.id})).keys;
const live=keys.find(k=>k.public_key===record.public_key)?.access_key?.permission?.FunctionCall;
if(live?.receiver_id!==receiver||JSON.stringify(live.method_names)!==JSON.stringify(methods))
  throw Error('Async Research reporter key is not limited as expected');
const store=new keyStores.InMemoryKeyStore();await store.setKey('testnet',operator.id,pair);
const node=await connect({networkId:'testnet',nodeUrl:ctx.rpcUrl,deps:{keyStore:store}}),account=await node.account(operator.id);
let contractRejected=false,tx=null;
try{await account.functionCall({contractId:receiver,methodName:'bind_async_research_call',
  args:{token_id:'nfa-2',id:999999,call_id:'00000000-0000-0000-0000-000000000000',
    execution_hash:'sha256:'+'0'.repeat(64),version_key:'0'.repeat(64),epoch:0},
  gas:50_000_000_000_000n,attachedDeposit:0n})}
catch(error){contractRejected=JSON.stringify(error.kind||error).includes('FunctionCallError');
  tx=error.transaction_outcome?.id??null}
if(!contractRejected)throw Error('Restricted reporter did not reach and get rejected by contract');
const evidence={checkedAt:new Date().toISOString(),network:'NEAR testnet',operator:operator.id,
  receiver,methods,publicKey:record.public_key,contractRejectionTransaction:tx,
  addKeyTransaction:ctx.evidence.steps.addAsyncResearchReporterKey.hash,
  fullAccessRemoved:false};
await writeFile('docs/evidence/async-research-reporter-restriction.json',JSON.stringify(evidence,null,2)+'\n');
console.log(JSON.stringify({restricted:true,methods,publicKey:record.public_key}));
