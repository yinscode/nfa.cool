import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runResearch,validateResearchInput} from '../research.mjs';
import {ResearchMemory} from '../research-memory.mjs';
import {ResearchAttempts,assertResearchJob} from '../research-runner.mjs';

const quote='An NFT controls the same stable vault after ownership changes.';
const input={question:'What remains after ownership changes?',sources:[{title:'Vault',url:'https://docs.near.org/vault'}]};
const config={allowedSources:[{host:'docs.near.org',pathPrefix:'/'}],endpoint:'https://cloud-api.near.ai/v1/chat/completions',
  apiKey:'test-key',model:'configured-model',maxTokens:512,maxInputTokens:24000,maxCostMicrousd:30000,inputMicrousdPerToken:1,outputMicrousdPerToken:2};
const context={tokenId:'nfa-1',vaultAccountId:'vault.testnet',jobId:1,ownerEpoch:0};
const response=value=>new Response(typeof value==='string'?value:JSON.stringify(value),{status:200});
test('bounded research uses typed citations and eligible vault memory across owner changes',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'nfa-research-'));let owner='alice.testnet',finalized=null,checks=0;
  const sdk={get:async()=>({ownerAccountId:owner,vaultAccountId:context.vaultAccountId}),getServiceJob:async()=>({job:finalized})};
  try{
    const memory=new ResearchMemory({directory,sdk});
    const result=await runResearch({input,config,context,memory,assertCurrent:async()=>{checks++},claimInference:async()=>true,
      fetchImpl:async(url,options)=>{
        if(url===input.sources[0].url){assert.equal(options.redirect,'error');assert.equal(options.headers.authorization,undefined);return response(quote)}
        const request=JSON.parse(options.body);assert.equal(request.tools,undefined);assert.equal(request.max_tokens,512);
        return response({usage:{prompt_tokens:100,completion_tokens:30},choices:[{message:{content:JSON.stringify({findings:[{claim:quote,quote,sourceId:1}]})}}]});
      }});
    assert.equal(checks,3);assert.equal(result.artifact.inference.costMicrousd,'160');
    assert.deepEqual(await memory.readFinalized({...context,jobId:2}),[]);
    finalized={status:'FINALIZED',output_hash:result.outputHash};owner='bob.testnet';
    assert.equal((await memory.readFinalized({...context,jobId:2,ownerEpoch:1}))[0].outputHash,result.outputHash);
  }finally{await rm(directory,{recursive:true,force:true})}
});
test('paid research rejects stale epochs and an unresolved inference cannot be charged twice',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'nfa-inference-'));
  try{
    const c={...context,registryAccountId:'registry.testnet',versionKey:'runtime'};
    const sdk={get:async()=>({ownerEpoch:1,vaultAccountId:c.vaultAccountId,lifecycle:'ACTIVE'}),getAgentState:async()=>({pending_op:1}),
      getServiceJob:async()=>({service_id:'research',job:{epoch:0,status:'EXECUTING',version_key:'runtime',deadline_ns:'9999999999999999999'}}),
      getOutlayerProject:async()=>({state:'READY',version_key:'runtime'})};
    await assert.rejects(()=>assertResearchJob(sdk,c),/epoch or runtime/);
    assert.equal(await new ResearchAttempts(directory).claim(c,'hash','100'),true);
    assert.equal(await new ResearchAttempts(directory).claim(c,'hash','100'),false);
  }finally{await rm(directory,{recursive:true,force:true})}
});
test('research rejects redirects, dynamic tools, excess costs and uncited model actions',async()=>{
  assert.throws(()=>validateResearchInput({...input,sources:[{title:'internal',url:'https://127.0.0.1/secrets'}]},config.allowedSources),/allowlist/);
  assert.throws(()=>validateResearchInput({...input,method:'create_project'},config.allowedSources),/Typed/);
  const base={input,config,context,assertCurrent:async()=>{},claimInference:async()=>true,memory:{readFinalized:async()=>[],stage:async()=>{throw Error('Must not stage')}}};
  await assert.rejects(()=>runResearch({...base,config:{...config,maxCostMicrousd:1}}),/cost cap/);
  await assert.rejects(()=>runResearch({...base,fetchImpl:async(url)=>url===input.sources[0].url?response(quote):response({usage:{prompt_tokens:20,completion_tokens:20},choices:[{message:{content:JSON.stringify({findings:[{claim:quote,quote:'Invented evidence that is absent from every source.',sourceId:1}]})}}]})}),/unsupported citation/);
  await assert.rejects(()=>runResearch({...base,fetchImpl:async()=>new Response('',{status:302,headers:{location:'https://127.0.0.1/'}})}),/unavailable/);
});
