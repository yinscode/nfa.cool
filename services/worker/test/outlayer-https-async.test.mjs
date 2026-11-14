import {test} from 'node:test';
import assert from 'node:assert/strict';
import {OutlayerHttpsAsync,paymentKeyOwner,verifyRecallResult,verifyResearchDiagnostic} from '../outlayer-https-async.mjs';

const vault='nfa-2.registry.testnet',hash='a'.repeat(64),outputHash=`sha256:${'b'.repeat(64)}`;
const key=`${vault}:1:${'K'.repeat(44)}`;
const callId='550e8400-e29b-41d4-a716-446655440000';
const setup=fetchImpl=>new OutlayerHttpsAsync({paymentKey:key,vaultId:vault,
  projectId:`${vault}/scout`,versionKey:hash,fetchImpl});

test('async recall pins vault-owned key, binary, and bounded request',async()=>{
  const calls=[];const client=setup(async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify({
    call_id:callId,status:'pending',poll_url:`/calls/${callId}`}))});
  const admitted=await client.submitRecall({jobId:26,service:'scout',expectedHash:outputHash});
  assert.equal(admitted.callId,callId);
  assert.equal(calls.length,1);
  assert.equal(calls[0].url,`https://testnet-api.outlayer.ai/call/${vault}/scout`);
  assert.equal(calls[0].options.headers['x-compute-limit'],'30000');
  const body=JSON.parse(calls[0].options.body);
  assert.equal(body.async,true);assert.equal(body.version_key,hash);
  assert.deepEqual(body.input,{operation:'recall',service:'scout',jobId:26,expectedHash:outputHash});
  assert.equal(body.secrets_ref,undefined);
});

test('rejects another key owner and an unpinned project',()=>{
  assert.equal(paymentKeyOwner(key),vault);
  assert.throws(()=>new OutlayerHttpsAsync({paymentKey:`alice.testnet:1:${'K'.repeat(44)}`,
    vaultId:vault,projectId:`${vault}/scout`,versionKey:hash}),/owner/);
  assert.throws(()=>new OutlayerHttpsAsync({paymentKey:key,vaultId:vault,
    projectId:'alice.testnet/scout',versionKey:hash}),/Pinned/);
  assert.throws(()=>new OutlayerHttpsAsync({paymentKey:key,vaultId:vault,
    projectId:`${vault}/scout`,versionKey:hash,executionLimitSeconds:181}),/Execution limit/);
});

test('paid Research may use a disclosed longer hosted limit under the same USD cap',async()=>{
  let request;const client=new OutlayerHttpsAsync({paymentKey:key,vaultId:vault,
    projectId:`${vault}/scout`,versionKey:hash,executionLimitSeconds:90,
    fetchImpl:async(_url,options)=>{request=JSON.parse(options.body);
      return new Response(JSON.stringify({call_id:callId,status:'pending'}))}});
  await client.submit({operation:'run',service:'research',jobId:44},{account_id:'operator.testnet',profile:'research-v8'});
  assert.equal(request.resource_limits.max_execution_seconds,90);
  assert.equal(request.version_key,hash);
});

test('does not retry an ambiguous paid submission',async()=>{
  let calls=0;const client=setup(async()=>{calls++;throw Error('timeout')});
  await assert.rejects(client.submitRecall({jobId:26,service:'scout',expectedHash:outputHash}),/outcome unknown/);
  assert.equal(calls,1);
});

test('polls only the returned call and validates finalized recall commitment',async()=>{
  const client=setup(async(url)=>{assert.equal(url,`https://testnet-api.outlayer.ai/calls/${callId}`);
    return new Response(JSON.stringify({call_id:callId,status:'completed',compute_cost:'1200',
      output:JSON.stringify({schemaVersion:1,jobId:26,status:'ok',outputHash,
        outputUri:`nfa://work/${outputHash.slice(7)}`,summary:'Prior work'})}))});
  const result=await client.poll(callId);
  assert.equal(verifyRecallResult(result,{jobId:26,expectedHash:outputHash}).computeCostMicrousd,'1200');
  assert.throws(()=>verifyRecallResult(result,{jobId:27,expectedHash:outputHash}),/differs/);
  await assert.rejects(client.poll('../other'),/Invalid OutLayer call ID/);
});
test('diagnostic Research binds vault, candidate hash and secret without claiming NFA settlement',async()=>{
  let request;const client=setup(async(_url,options)=>{request=JSON.parse(options.body);
    return new Response(JSON.stringify({call_id:callId,status:'pending'}))});
  const secretsRef={account_id:'operator.testnet',profile:'research-v5'};
  const input={operation:'run',service:'research',jobId:1_000_000_000,
    question:'How do NEAR access keys authorize actions?',
    sources:[{title:'NEAR access keys',url:'https://docs.near.org/protocol/accounts-contracts/access-keys'}],
    context:{vaultAccountId:vault,registryAccountId:'registry.testnet',tokenId:'nfa-2',ownerEpoch:2,priorWork:[]},
    research:{settings:{version_key:hash,secrets_ref:secretsRef}}};
  // The synthetic test vault's token id is nfa-2; only the exact context passes.
  await client.submitResearchDiagnostic(input,secretsRef);
  assert.equal(request.version_key,hash);assert.deepEqual(request.secrets_ref,secretsRef);
  assert.equal(request.input.jobId,1_000_000_000);
  await assert.rejects(client.submitResearchDiagnostic({...input,jobId:26},secretsRef),/outside/);
  await assert.rejects(client.submitResearchDiagnostic({...input,context:{...input.context,vaultAccountId:'alice.testnet'}},secretsRef),/outside/);
  const result={status:'completed',call_id:callId,compute_cost:'1200',output:{schemaVersion:1,jobId:input.jobId,
    status:'ok',inferenceOutcome:'succeeded',outputHash,outputUri:`nfa://work/${outputHash.slice(7)}`,
    pricedUsageMicrousd:160}};
  assert.equal(verifyResearchDiagnostic(result,input.jobId).pricedUsageMicrousd,160);
  assert.throws(()=>verifyResearchDiagnostic({...result,output:{...result.output,inferenceOutcome:'unknown'}},input.jobId),/priced/);
});
