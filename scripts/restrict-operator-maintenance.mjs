#!/usr/bin/env node
// Add least-privilege keys for payment-key recovery and Research secret rotation.
import {readFile,writeFile} from 'node:fs/promises';
import {KeyPair,keyStores,connect,transactions} from 'near-api-js';
import {testnet} from './testnet-lib.mjs';
const ctx=await testnet('deployments/operator-maintenance-keys.json'),operator=await ctx.signer('t004-operator');
const rows=[
  {name:'payment-key',receiver:'nfagent-registry-0e9b2a.testnet',
    methods:['issue_payment_key','reconcile_payment_key_setup'],
    testMethod:'reconcile_payment_key_setup',testArgs:{token_id:'nfa-2'}},
  {name:'research-secret',receiver:'outlayer.testnet',methods:['store_secrets'],
    testMethod:'store_secrets',testArgs:{}}
];
const evidence=[];
for(const row of rows){
  const path=`deployments/operator-${row.name}.key.json`;let record;
  try{record=JSON.parse(await readFile(path))}catch(error){if(error.code!=='ENOENT')throw error;
    const pair=KeyPair.fromRandom('ed25519');record={account_id:operator.id,receiver_id:row.receiver,
      method_names:row.methods,public_key:pair.getPublicKey().toString(),secret_key:pair.toString()};
    await writeFile(path,JSON.stringify(record,null,2)+'\n',{mode:0o600})}
  const pair=KeyPair.fromString(record.secret_key);
  if(record.account_id!==operator.id||record.receiver_id!==row.receiver||
    JSON.stringify(record.method_names)!==JSON.stringify(row.methods)||
    pair.getPublicKey().toString()!==record.public_key)throw Error('Operator maintenance key changed');
  await ctx.send(`add${row.name}MaintenanceKey`,operator,operator.id,[transactions.addKey(pair.getPublicKey(),
    transactions.functionCallAccessKey(row.receiver,row.methods,null))]);
  const live=(await ctx.rpc('query',{request_type:'view_access_key',finality:'final',
    account_id:operator.id,public_key:record.public_key})).permission?.FunctionCall;
  if(live?.receiver_id!==row.receiver||JSON.stringify(live.method_names)!==JSON.stringify(row.methods))
    throw Error('Live maintenance permission differs');
  const store=new keyStores.InMemoryKeyStore();await store.setKey('testnet',operator.id,pair);
  const node=await connect({networkId:'testnet',nodeUrl:ctx.rpcUrl,deps:{keyStore:store}}),
    account=await node.account(operator.id);
  let reached=false,tx=null;
  try{await account.functionCall({contractId:row.receiver,methodName:row.testMethod,
    args:row.testArgs,gas:50_000_000_000_000n,attachedDeposit:0n})}
  catch(error){reached=JSON.stringify(error.kind||error).includes('FunctionCallError');
    tx=error.transaction_outcome?.id??null}
  if(!reached)throw Error(`${row.name} key did not reach its allowed contract method`);
  evidence.push({receiver:row.receiver,methods:row.methods,publicKey:record.public_key,
    invalidOperationRejectedTx:tx});
}
await writeFile('docs/evidence/operator-maintenance-restriction.json',JSON.stringify({
  checkedAt:new Date().toISOString(),network:'NEAR testnet',operator:operator.id,
  restrictedKeys:evidence,fullAccessRemoved:false,
  remainingGate:'Live delayed apply with restricted registry admin key, then full authority audit'
},null,2)+'\n');
console.log(JSON.stringify({restrictedMaintenanceKeys:evidence.length,fullAccessRemoved:false}));
