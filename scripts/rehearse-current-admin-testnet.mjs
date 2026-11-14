#!/usr/bin/env node
import {readFile,writeFile} from 'node:fs/promises';
import {KeyPair,keyStores,connect,utils} from 'near-api-js';
import {testnet,pause} from './testnet-lib.mjs';
const ctx=await testnet('deployments/current-admin-rehearsal.json');
const registry='nfagent-registry-0e9b2a.testnet';
const current='f9c750ad48e369b79e65f3de6c6533602b09658c3202e389d96dbfba154c1353';
const hash=Buffer.from(utils.serialize.base_decode((await ctx.account(registry)).code_hash)).toString('hex');
if(hash!==current)throw Error('Unexpected live registry code');
const record=JSON.parse(await readFile('deployments/admin-registry.key.json'));
const methods=['propose_registry_upgrade','apply_registry_upgrade','cancel_registry_upgrade'];
if(record.receiver_id!==registry||JSON.stringify(record.method_names)!==JSON.stringify(methods)||
  KeyPair.fromString(record.secret_key).getPublicKey().toString()!==record.public_key)
  throw Error('Restricted admin key changed');
const live=(await ctx.rpc('query',{request_type:'view_access_key',finality:'final',
  account_id:record.account_id,public_key:record.public_key})).permission?.FunctionCall;
if(live?.receiver_id!==registry||JSON.stringify(live.method_names)!==JSON.stringify(methods))
  throw Error('Restricted admin key not live');
const store=new keyStores.InMemoryKeyStore();await store.setKey('testnet',record.account_id,
  KeyPair.fromString(record.secret_key));
const node=await connect({networkId:'testnet',nodeUrl:ctx.rpcUrl,deps:{keyStore:store}}),
  account=await node.account(record.account_id);
const proposal=await account.functionCall({contractId:registry,methodName:'propose_registry_upgrade',
  args:{code_hash:current},gas:50_000_000_000_000n,attachedDeposit:0n});
let earlyApplyTx=null,blocked=false;
try{await account.functionCall({contractId:registry,methodName:'apply_registry_upgrade',
  args:Buffer.alloc(0),gas:50_000_000_000_000n,attachedDeposit:0n})}
catch(error){blocked=JSON.stringify(error.kind||error).includes('FunctionCallError');
  earlyApplyTx=error.transaction_outcome?.id??null}
if(!blocked)throw Error('Early public apply unexpectedly succeeded');
const cancel=await account.functionCall({contractId:registry,methodName:'cancel_registry_upgrade',
  args:{},gas:50_000_000_000_000n,attachedDeposit:0n});
let cleared=false;for(let i=0;i<60;i++){
  const raw=await ctx.rpc('query',{request_type:'call_function',finality:'final',account_id:registry,
    method_name:'authorities',args_base64:Buffer.from('{}').toString('base64')});
  if(JSON.parse(Buffer.from(raw.result).toString()).registry_upgrade===null){cleared=true;break}await pause(500)}
if(!cleared)throw Error('Upgrade proposal not cleared');
const evidence={checkedAt:new Date().toISOString(),network:'NEAR testnet',registryHash:current,
  restrictedAdminKey:record.public_key,methods,proposalTx:proposal.transaction.hash,
  earlyApplyTx,delayEnforced:true,cancelTx:cancel.transaction.hash,proposalCleared:true,
  fullDelayedApplyTested:false,fullAccessRemoved:false};
await writeFile('docs/evidence/current-admin-rehearsal.json',JSON.stringify(evidence,null,2)+'\n');
console.log(JSON.stringify({restrictedAdminRehearsed:true,delayEnforced:true,proposalCleared:true}));
