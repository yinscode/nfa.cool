import test from 'node:test';
import assert from 'node:assert/strict';
import {NfaSdk} from '@nfa/sdk';
import {quoteService,schemaHashFor,listServices} from '../service-runtime.mjs';
const input={question:'How does an NFT retain its vault?',sources:[{title:'Vault',url:'https://docs.near.org/vault'}]};
const limits={max_instructions:1000000000,max_memory_mb:128,max_execution_seconds:30};
function setup(){
  const sdk=new NfaSdk({registryAccountId:'registry.testnet',rpcUrl:'https://rpc.invalid'});
  const config={configuration_hash:'sha256:'+'c'.repeat(64),version:1,settings:{version_key:'a'.repeat(64),
    allowed_sources:[{host:'docs.near.org',path_prefix:'/'}],max_cost_microusd:30000}};
  const onchain={service_id:'research',version:2,enabled:true,schema_hash:schemaHashFor('research'),min_margin:'20000000000000000000000',max_deposit:'500000000000000000000000',limits};
  sdk.getOutlayerProject=async()=>({state:'READY',project_uuid:'same-project',version_key:'a'.repeat(64)});
  sdk.getResearchConfig=async()=>config;sdk.getServicePolicy=async()=>onchain;sdk.getServiceCatalog=async()=>[onchain];
  sdk.getAgentState=async()=>({lifecycle:'Active',pending_op:null});sdk.getTreasury=async()=>({available:'1000000000000000000000000'});
  sdk.view=async(_account,method)=>method==='research_vault_capable'?true:'2000000000000000000000';
  return {sdk,policy:{research:{limits,marginYocto:'10000000000000000000000',maxDepositYocto:'500000000000000000000000'}},tokenId:'nfa-1',config};
}
test('research quote pins configuration and remains unavailable before hosted acceptance',async()=>{
  const context=setup();
  const item=(await listServices(context)).items.find(i=>i.id==='research');assert.equal(item.available,false);
  assert.equal(item.reason,'research_release_not_ready');
  await assert.rejects(()=>quoteService({...context,service:'research',body:{input}}),/hosted acceptance/);
  const quote=await quoteService({...context,service:'research',body:{input},allowResearchCandidate:true});
  assert.equal(quote.researchConfigHash,context.config.configuration_hash);
  assert.equal(quote.unsignedAction.args.expected_research_config,context.config.configuration_hash);
  assert.equal(quote.unsignedAction.args.expected_policy_version,2);
  assert.equal(BigInt(quote.feeYocto)-BigInt(quote.replenishYocto),20000000000000000000000n);
});
test('customer research input cannot choose secrets, privileged methods or arbitrary URLs',async()=>{
  const context=setup();
  for(const value of [{...input,secrets_ref:{account_id:'attacker.testnet',profile:'keys'}},
    {...input,operation:'create_project'},{...input,sources:[{title:'Internal',url:'http://127.0.0.1/key'}]}]){
    await assert.rejects(()=>quoteService({...context,service:'research',body:{input:value},allowResearchCandidate:true}),/Typed|allowlist/);
  }
});
