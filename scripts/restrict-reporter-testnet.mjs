#!/usr/bin/env node
// Add and verify FunctionCall-only reporter keys for each allowed receiver.
import {readFile,writeFile} from 'node:fs/promises';
import {KeyPair,keyStores,connect,transactions} from 'near-api-js';
import {testnet} from './testnet-lib.mjs';
const ctx=await testnet('deployments/reporter-restriction.json'),operator=await ctx.signer('t004-operator');
const registry='nfagent-registry-0e9b2a.testnet';
if(operator.id!=='01871de834e09e380684d3cdbdfd4a3d029051ce76957865bbccc19471b35ae8')
  throw Error('Unexpected operator account');
const rows=[
  {name:'registry',receiver:registry,methods:['mark_evm_broadcast','reconcile_evm','retry_evm_signature'],
    testMethod:'reconcile_evm',testArgs:{token_id:'nfa-2',id:999999}},
  ...['nfa-1','nfa-2'].map(token=>({name:token,receiver:`${token}.${registry}`,methods:['report_evm_receipt'],
    testMethod:'report_evm_receipt',testArgs:{id:999999,tx_hash:'0x'+'a'.repeat(64),observed_block:1,success:false}}))
];
for(const row of rows){
  const path=`deployments/reporter-${row.name}.key.json`;
  let record;try{record=JSON.parse(await readFile(path,'utf8'))}catch(error){if(error.code!=='ENOENT')throw error;
    const pair=KeyPair.fromRandom('ed25519');record={account_id:operator.id,receiver_id:row.receiver,
      method_names:row.methods,public_key:pair.getPublicKey().toString(),secret_key:pair.toString()};
    await writeFile(path,JSON.stringify(record,null,2)+'\n',{mode:0o600});}
  if(record.account_id!==operator.id||record.receiver_id!==row.receiver||
    JSON.stringify(record.method_names)!==JSON.stringify(row.methods)||
    KeyPair.fromString(record.secret_key).getPublicKey().toString()!==record.public_key)throw Error('Reporter key record mismatch');
  row.publicKey=record.public_key;
  const pair=KeyPair.fromString(record.secret_key);
  await ctx.send(`addReporterKey${row.name}`,operator,operator.id,[transactions.addKey(pair.getPublicKey(),
    transactions.functionCallAccessKey(row.receiver,row.methods,null))]);
  const keys=(await ctx.rpc('query',{request_type:'view_access_key_list',finality:'final',account_id:operator.id})).keys;
  const live=keys.find(k=>k.public_key===record.public_key)?.access_key?.permission?.FunctionCall;
  if(live?.receiver_id!==row.receiver||JSON.stringify(live.method_names)!==JSON.stringify(row.methods))
    throw Error(`${row.name} access key is not restricted as expected`);
  const store=new keyStores.InMemoryKeyStore();await store.setKey('testnet',operator.id,pair);
  const node=await connect({networkId:'testnet',nodeUrl:ctx.rpcUrl,deps:{keyStore:store}}),account=await node.account(operator.id);
  let contractRejected=false;
  try{await account.functionCall({contractId:row.receiver,methodName:row.testMethod,args:row.testArgs,
    gas:50_000_000_000_000n,attachedDeposit:0n})}
  catch(error){contractRejected=JSON.stringify(error.kind||error).includes('FunctionCallError');
    row.testTransaction=error.transaction_outcome?.id}
  if(!contractRejected)throw Error(`${row.name} reporter key did not reach the allowed contract method`);
  console.log(`${row.name}: FunctionCall key accepted by receiver and rejected invalid operation`);
}
const publicEvidence={checkedAt:new Date().toISOString(),network:'NEAR testnet',operator:operator.id,
  keys:rows.map(row=>({receiver:row.receiver,methods:row.methods,publicKey:row.publicKey,
    contractRejectionTransaction:row.testTransaction})),
  transactions:Object.fromEntries(Object.entries(ctx.evidence.steps).map(([k,v])=>[k,{hash:v.hash,failed:v.outcome?.failed}])),
  fullAccessRemoval:'deferred until registry administration and all guardian methods are exercised with restricted keys'};
await writeFile('docs/evidence/reporter-restriction.json',JSON.stringify(publicEvidence,null,2)+'\n');
console.log(JSON.stringify({restrictedReporterKeys:rows.length,fullAccessRemoved:false},null,2));
