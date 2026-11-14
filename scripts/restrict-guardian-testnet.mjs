#!/usr/bin/env node
// Add receiver-specific guardian keys and exercise proposal/cancel safely.
import {readFile,writeFile} from 'node:fs/promises';
import {KeyPair,keyStores,connect,transactions} from 'near-api-js';
import {testnet,pause} from './testnet-lib.mjs';
const ctx=await testnet('deployments/guardian-restriction.json'),operator=await ctx.signer('t004-operator');
const registry='nfagent-registry-0e9b2a.testnet',codeHash='200821c58802e52ac795fbd1a594a66d6f6de8703862019972b9ee93bc33c6e7';
const methods=['propose_upgrade','cancel_upgrade','emergency_upgrade'];
const evidence=[];
for(const token of ['nfa-1','nfa-2']){
  const receiver=`${token}.${registry}`,path=`deployments/guardian-${token}.key.json`;
  let record;try{record=JSON.parse(await readFile(path,'utf8'))}catch(error){if(error.code!=='ENOENT')throw error;
    const pair=KeyPair.fromRandom('ed25519');record={account_id:operator.id,receiver_id:receiver,method_names:methods,
      public_key:pair.getPublicKey().toString(),secret_key:pair.toString()};
    await writeFile(path,JSON.stringify(record,null,2)+'\n',{mode:0o600});}
  const pair=KeyPair.fromString(record.secret_key);
  if(record.account_id!==operator.id||record.receiver_id!==receiver||
    JSON.stringify(record.method_names)!==JSON.stringify(methods)||pair.getPublicKey().toString()!==record.public_key)
    throw Error('Guardian key record mismatch');
  await ctx.send(`addGuardianKey${token}`,operator,operator.id,[transactions.addKey(pair.getPublicKey(),
    transactions.functionCallAccessKey(receiver,methods,null))]);
  const live=(await ctx.rpc('query',{request_type:'view_access_key',finality:'final',account_id:operator.id,public_key:record.public_key})).permission;
  if(live?.FunctionCall?.receiver_id!==receiver||JSON.stringify(live.FunctionCall.method_names)!==JSON.stringify(methods))
    throw Error('Guardian key permission differs');
  const store=new keyStores.InMemoryKeyStore();await store.setKey('testnet',operator.id,pair);
  const node=await connect({networkId:'testnet',nodeUrl:ctx.rpcUrl,deps:{keyStore:store}}),account=await node.account(operator.id);
  const proposal=await account.functionCall({contractId:receiver,methodName:'propose_upgrade',args:{code_hash:codeHash},
    gas:50_000_000_000_000n,attachedDeposit:0n});
  const cancel=await account.functionCall({contractId:receiver,methodName:'cancel_upgrade',args:{},
    gas:50_000_000_000_000n,attachedDeposit:0n});
  let cleared=false;for(let i=0;i<60;i++){
    const result=await ctx.rpc('query',{request_type:'call_function',finality:'final',account_id:receiver,
      method_name:'upgrade_proposal',args_base64:Buffer.from('{}').toString('base64')});
    if(JSON.parse(Buffer.from(result.result).toString())===null){cleared=true;break}await pause(500);
  }
  if(!cleared)throw Error(`${token} guardian proposal was not cleared`);
  evidence.push({token,receiver,methods,publicKey:record.public_key,
    proposal:proposal.transaction.hash,cancel:cancel.transaction.hash,proposalCleared:true});
  console.log(`${token}: restricted guardian proposal/cancel passed`);
}
await writeFile('docs/evidence/guardian-restriction.json',JSON.stringify({checkedAt:new Date().toISOString(),
  network:'NEAR testnet',operator:operator.id,keys:evidence,fullAccessRemoved:false},null,2)+'\n');
