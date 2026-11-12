#!/usr/bin/env node
// Test host linking before touching a stable NFA's active runtime. No model or secret used.
import {readFile,writeFile} from 'node:fs/promises';
import {transactions} from 'near-api-js';
import {NfaSdk} from '@nfa/sdk';
import {testnet} from './testnet-lib.mjs';
import {createScoutBrief} from '../services/worker/scout.mjs';
import {createCompareBrief} from '../services/worker/compare.mjs';
import {hostedExecutionEvidence} from './hosted-execution-evidence.mjs';
const ctx=await testnet('deployments/m04-component-smoke.json'),alice=await ctx.signer('t006-alice');
const sdk=new NfaSdk({registryAccountId:'nfagent-registry-0e9b2a.testnet',rpcUrl:ctx.rpcUrl});
const prepared=JSON.parse(await readFile('deployments/m06-research.json','utf8'));
const runtime=JSON.parse(await readFile('docs/evidence/m04-runtime.json','utf8'));
if(prepared.upload?.hash!==runtime.sha256)throw Error('Verified candidate upload required');
const projectId=alice.id+'/nfa-probe',project=await sdk.view('outlayer.testnet','get_project',{project_id:projectId});
if(!project||project.owner!==alice.id)throw Error('Existing disposable probe Project must belong to Alice');
await ctx.send('stageResearchComponentSmoke',alice,'outlayer.testnet',[transactions.functionCall('add_version',{
  project_name:'nfa-probe',source:{WasmUrl:{url:prepared.upload.url,hash:runtime.sha256,build_target:'wasm32-wasip2'}},set_active:false},
  100000000000000n,10000000000000000000000n)]);
const limits={max_instructions:1000000000,max_memory_mb:128,max_execution_seconds:30},results={};
for(const [index,service] of ['scout','compare'].entries()){
  const input={question:'What follows the NFA when sold?',sources:[{title:'Vault',url:'https://docs.near.org/',
    text:'The NFA vault and its agent memory stay with the NFT when ownership changes.'}]};
  if(service==='compare'){input.criteria=['memory'];input.sources.push({title:'Signer',url:'https://docs.near.org/accounts-contracts/account',
    text:'A human signer can change while the agent vault and memory remain the same.'})}
  const data=JSON.stringify({operation:'run',service,jobId:index+1,...input});
  const estimate=BigInt(await sdk.view('outlayer.testnet','estimate_execution_cost',{resource_limits:limits,input_len:Buffer.byteLength(data)}));
  const deposit=(estimate*6n+4n)/5n;if(deposit<=0n||deposit>500000000000000000000000n)throw Error('Probe cost cap');
  const result=await ctx.send(service+'ProjectComponentSmoke',alice,'outlayer.testnet',[transactions.functionCall('request_execution',{
    source:{Project:{project_id:projectId,version_key:runtime.sha256}},
    resource_limits:limits,input_data:data,response_format:'Json'},250000000000000n,deposit)]);
  const expected=service==='scout'?createScoutBrief(input):createCompareBrief(input);
  if(result.value?.status!=='ok'||result.value?.outputHash!==expected.outputHash)throw Error('Hosted legacy result differs from reviewed codec');
  results[service]={transaction:result.hash,output:result.value,depositYocto:deposit.toString(),
    execution:await hostedExecutionEvidence({sdk,hash:result.hash,sender:alice.id,runtimeHash:runtime.sha256,predecessor:alice.id,projectUuid:project.uuid})};
}
const evidence={milestone:'M04',mode:'real OutLayer testnet on existing disposable probe Project; caller is probe signer, not NFA vault',
  runtimeHash:runtime.sha256,projectId,projectUuid:project.uuid,results,
  standaloneRefusal:{transaction:ctx.evidence.steps.scoutComponentSmoke?.hash,reason:'Storage-importing guests require a Project UUID; standalone request returned no result.'},
  checks:['HTTP-capable WASI component links on host','Scout output matches reviewed codec','Compare output matches reviewed codec'],
  limits:['Does not run model inference or use NFA memory.','Does not replace M06 vault-owned Project acceptance.']};
await writeFile('docs/evidence/m04-component-smoke.json',JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence,null,2));
