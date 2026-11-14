#!/usr/bin/env node
// Exercise the restricted registry admin key and the 48-hour upgrade delay.
import {readFile,writeFile} from 'node:fs/promises';
import {KeyPair,keyStores,connect,transactions} from 'near-api-js';
import {testnet,pause} from './testnet-lib.mjs';
const ctx=await testnet('deployments/restricted-admin-rehearsal.json'),operator=await ctx.signer('t004-operator');
const registry='nfagent-registry-0e9b2a.testnet',code=await readFile('releases/nfa-registry-reviewed-0f02c8a935199f99.wasm');
const hash='0f02c8a935199f998922552067f92f5bfc6b2ae58edf89c5bc30bb3e034e63d0';
const methods=['propose_registry_upgrade','apply_registry_upgrade','cancel_registry_upgrade'];
const path='deployments/admin-registry.key.json';let record;
try{record=JSON.parse(await readFile(path,'utf8'))}catch(error){if(error.code!=='ENOENT')throw error;
  const pair=KeyPair.fromRandom('ed25519');record={account_id:operator.id,receiver_id:registry,method_names:methods,
    public_key:pair.getPublicKey().toString(),secret_key:pair.toString()};
  await writeFile(path,JSON.stringify(record,null,2)+'\n',{mode:0o600});}
if(record.account_id!==operator.id||record.receiver_id!==registry||JSON.stringify(record.method_names)!==JSON.stringify(methods))
  throw Error('Admin key record differs');
const pair=KeyPair.fromString(record.secret_key);
if(pair.getPublicKey().toString()!==record.public_key)throw Error('Admin public key differs');
await ctx.send('addRestrictedAdminKey',operator,operator.id,[transactions.addKey(pair.getPublicKey(),
  transactions.functionCallAccessKey(registry,methods,null))]);
const live=(await ctx.rpc('query',{request_type:'view_access_key',finality:'final',account_id:operator.id,public_key:record.public_key})).permission;
if(live?.FunctionCall?.receiver_id!==registry||JSON.stringify(live.FunctionCall.method_names)!==JSON.stringify(methods))
  throw Error('Admin key permission differs');
const store=new keyStores.InMemoryKeyStore();await store.setKey('testnet',operator.id,pair);
const node=await connect({networkId:'testnet',nodeUrl:ctx.rpcUrl,deps:{keyStore:store}}),account=await node.account(operator.id);
const proposal=await account.functionCall({contractId:registry,methodName:'propose_registry_upgrade',args:{code_hash:hash},
  gas:50_000_000_000_000n,attachedDeposit:0n});
let earlyApplyHash,blocked=false;
try{await account.functionCall({contractId:registry,methodName:'apply_registry_upgrade',args:code,
  gas:300_000_000_000_000n,attachedDeposit:0n})}
catch(error){blocked=JSON.stringify(error.kind||error).includes('FunctionCallError');earlyApplyHash=error.transaction_outcome?.id}
if(!blocked)throw Error('Registry upgrade did not enforce the public delay');
const cancel=await account.functionCall({contractId:registry,methodName:'cancel_registry_upgrade',args:{},
  gas:50_000_000_000_000n,attachedDeposit:0n});
let authorities;for(let i=0;i<60;i++){
  const view=await ctx.rpc('query',{request_type:'call_function',finality:'final',account_id:registry,
    method_name:'authorities',args_base64:Buffer.from('{}').toString('base64')});
  authorities=JSON.parse(Buffer.from(view.result).toString());
  if(authorities.registry_upgrade===null)break;await pause(500);
}
if(authorities.registry_upgrade!==null)throw Error('Registry proposal was not cleared');
const evidence={checkedAt:new Date().toISOString(),network:'NEAR testnet',admin:operator.id,restrictedKey:record.public_key,
  receiver:registry,methods,codeHash:hash,proposal:proposal.transaction.hash,earlyApply:earlyApplyHash,
  delayEnforced:blocked,cancel:cancel.transaction.hash,proposalCleared:true,
  localAfterDelayCheck:'contracts/registry/src/lib.rs registry_upgrade_waits_for_the_public_delay',
  fullAccessRemoved:false};
await writeFile('docs/evidence/registry-admin-rehearsal.json',JSON.stringify(evidence,null,2)+'\n');
console.log(JSON.stringify({restrictedAdminKey:true,delayEnforced:true,proposalCleared:true},null,2));
