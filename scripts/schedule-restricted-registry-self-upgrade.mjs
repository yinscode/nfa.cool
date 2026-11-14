#!/usr/bin/env node
// Start the public 48-hour path using the already deployed, rehearsed bytes.
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {KeyPair,keyStores,connect,transactions,utils} from 'near-api-js';
import {NfaSdk} from '@nfa/sdk';
import {testnet,pause} from './testnet-lib.mjs';
const registryId='nfagent-registry-0e9b2a.testnet',hash='f9c750ad48e369b79e65f3de6c6533602b09658c3202e389d96dbfba154c1353';
const code=await readFile('releases/nfa-registry-async-recovery-f9c750ad48e369b7.wasm');
if(createHash('sha256').update(code).digest('hex')!==hash)throw Error('Exact current release changed');
const ctx=await testnet('deployments/restricted-self-upgrade.json');
const deployed=Buffer.from(utils.serialize.base_decode((await ctx.account(registryId)).code_hash)).toString('hex');
if(deployed!==hash)throw Error('Unexpected deployed code');
const sdk=new NfaSdk({registryAccountId:registryId,rpcUrl:ctx.rpcUrl});
for(const token of ['nfa-1','nfa-2'])if((await sdk.getAgentState(token)).pending_op!=null)
  throw Error(`${token} has pending work; finish it before starting administration rehearsal`);
const record=JSON.parse(await readFile('deployments/admin-registry.key.json'));
if(record.receiver_id!==registryId||
  JSON.stringify(record.method_names)!==JSON.stringify(['propose_registry_upgrade','apply_registry_upgrade','cancel_registry_upgrade'])||
  KeyPair.fromString(record.secret_key).getPublicKey().toString()!==record.public_key)
  throw Error('Restricted admin key changed');
const live=(await ctx.rpc('query',{request_type:'view_access_key',finality:'final',
  account_id:record.account_id,public_key:record.public_key})).permission?.FunctionCall;
if(live?.receiver_id!==registryId||JSON.stringify(live.method_names)!==JSON.stringify(record.method_names))
  throw Error('Restricted admin key permission changed');
const store=new keyStores.InMemoryKeyStore();await store.setKey('testnet',record.account_id,
  KeyPair.fromString(record.secret_key));
const node=await connect({networkId:'testnet',nodeUrl:ctx.rpcUrl,deps:{keyStore:store}});
const admin={id:record.account_id,account:await node.account(record.account_id)};
let authorities=await sdk.view(registryId,'authorities');
if(authorities.registry_upgrade?.code_hash!==hash){
  if(authorities.registry_upgrade)throw Error('Different registry proposal is pending');
  await ctx.send('proposeRestrictedSelfUpgrade',admin,registryId,[transactions.functionCall(
    'propose_registry_upgrade',Buffer.from(JSON.stringify({code_hash:hash})),
    50_000_000_000_000n,0n)]);
}
for(let i=0;i<80;i++){authorities=await sdk.view(registryId,'authorities');
  if(authorities.registry_upgrade?.code_hash===hash)break;await pause(500)}
if(authorities.registry_upgrade?.code_hash!==hash)throw Error('Proposal not observed');
const earliestNs=BigInt(authorities.registry_upgrade.proposed_at_ns)+
  BigInt(authorities.registry_upgrade_delay_ns);
const evidence={checkedAt:new Date().toISOString(),network:'NEAR testnet',registryId,
  codeHash:hash,restrictedAdminKey:record.public_key,
  proposalTx:ctx.evidence.steps.proposeRestrictedSelfUpgrade?.hash,
  proposedAtNs:authorities.registry_upgrade.proposed_at_ns,
  earliestApplyUtc:new Date(Number(earliestNs/1_000_000n)).toISOString(),
  applied:false,fullAccessRemoved:false,
  next:'After the public delay, apply exact bytes using the restricted key, verify every NFA and liability, then remove FullAccess keys.'};
await writeFile('docs/evidence/restricted-self-upgrade-scheduled.json',JSON.stringify(evidence,null,2)+'\n');
console.log(JSON.stringify({scheduled:true,earliestApplyUtc:evidence.earliestApplyUtc,codeHash:hash}));
