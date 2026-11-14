import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {NfaSdk} from '@nfa/sdk';
import {createApiServer} from '../server.mjs';
import {schemaHashFor} from '../service-runtime.mjs';

const policy={limits:{max_instructions:1_000_000,max_memory_mb:64,max_execution_seconds:10},
  marginYocto:'10000000000000000000000',maxDepositYocto:'500000000000000000000000'};
const source={question:'How does the agent retain its treasury?',sources:[{title:'Account',url:'https://example.org/account',
  text:'The agent retains its treasury in the same NEAR account after the NFT changes hands.'}]};
const digest=text=>'sha256:'+createHash('sha256').update(text).digest('hex');

test('Scout REST quote, checkout, start and status bind the same paid input',async()=>{
  const sdk=new NfaSdk({registryAccountId:'registry.testnet',rpcUrl:'https://rpc.invalid'});
  const project={state:'READY',project_uuid:'project-uuid',version_key:'a'.repeat(64)};
  sdk.getOutlayerProject=async()=>project;
  const scoutPolicy={service_id:'scout',version:1,enabled:true,schema_hash:schemaHashFor('scout'),min_margin:policy.marginYocto,
    max_deposit:policy.maxDepositYocto,limits:policy.limits};
  sdk.getServiceCatalog=async()=>[scoutPolicy];
  sdk.getServicePolicy=async(_id,service)=>service==='scout'?scoutPolicy:null;
  sdk.getAgentState=async()=>({lifecycle:'Active',pending_op:null});
  sdk.getTreasury=async()=>({available:'1000000000000000000000000'});
  sdk.view=async(_account,method,args)=>{
    assert.equal(method,'estimate_execution_cost');
    assert.deepEqual(args.resource_limits,policy.limits);
    assert.ok(args.input_len>JSON.stringify(source).length);
    return '100000000000000000000000';
  };
  let job=null;
  sdk.getPaidJob=async()=>job;
  sdk.getServiceJob=async()=>job?{job,service_id:'scout',policy_version:1}:null;
  const server=createApiServer({sdk,store:{},access:{},servicePolicy:policy});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}/v1/nfas/nfa-1/services`;
  const post=(path,body)=>fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  try{
    const catalog=await (await fetch(base)).json();
    assert.deepEqual(catalog.items.map(x=>x.id),['scout','compare']);
    assert.equal(catalog.items[0].available,true);
    assert.equal(catalog.items[1].available,false);
    assert.equal((await fetch(base+'/unregistered/quotes',{method:'POST'})).status,404);
    const response=await post('/scout/quotes',{input:source});
    assert.equal(response.status,200);
    const quote=await response.json();
    assert.equal(quote.inputData,JSON.stringify(source));
    assert.equal(quote.inputHash,digest(quote.inputData));
    assert.equal(quote.feeYocto,'130000000000000000000000');
    assert.equal(quote.replenishYocto,'120000000000000000000000');
    assert.equal(quote.unsignedAction.methodName,'request_reviewed_service_job');
    assert.equal(quote.unsignedAction.args.expected_version,project.version_key);
    assert.equal(quote.unsignedAction.args.expected_policy_version,1);
    assert.deepEqual(quote.unsignedAction.args.limits,scoutPolicy.limits);
    assert.equal(quote.unsignedAction.deposit,quote.feeYocto);
    assert.equal(quote.unsignedAction.args.input_hash,quote.inputHash);
    assert.equal(quote.unsignedAction.args.deposit_cap,quote.depositCapYocto);
    assert.equal((await post('/scout/jobs/2/prepare-start',{inputData:quote.inputData})).status,400);
    job={status:'REQUESTED',input_hash:quote.inputHash,version_key:quote.versionKey,deadline_ns:String(BigInt(Date.now()+900_000)*1_000_000n)};
    assert.deepEqual((await (await fetch(base+'/scout/jobs/2')).json()).job,job);
    const prepared=await (await post('/scout/jobs/2/prepare-start',{inputData:quote.inputData})).json();
    assert.equal(prepared.unsignedAction.methodName,'start_service_job');
    assert.equal(prepared.unsignedAction.args.id,2);
    assert.equal(prepared.unsignedAction.args.input_data,quote.inputData);
    assert.equal((await post('/scout/jobs/2/prepare-start',{inputData:quote.inputData+' '})).status,400);
    job.status='EXECUTING';
    assert.equal((await post('/scout/jobs/2/prepare-start',{inputData:quote.inputData})).status,400);
  }finally{await new Promise(resolve=>server.close(resolve))}
});

test('Scout quote rejects unavailable project, unsupported inputs and cap overrun',async()=>{
  const sdk=new NfaSdk({registryAccountId:'registry.testnet',rpcUrl:'https://rpc.invalid'});
  let ready=false,estimate='100000000000000000000000';
  sdk.getOutlayerProject=async()=>({state:ready?'READY':'CREATING',project_uuid:'uuid',version_key:'a'.repeat(64)});
  sdk.getServiceCatalog=async()=>[];
  sdk.getServicePolicy=async()=>null;
  sdk.getAgentState=async()=>({lifecycle:'Active',pending_op:null});
  sdk.getTreasury=async()=>({available:'1000000000000000000000000'});
  sdk.view=async()=>estimate;
  const server=createApiServer({sdk,store:{},access:{},servicePolicy:policy});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}/v1/nfas/nfa-1/services`;
  const post=body=>fetch(base+'/scout/quotes',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  try{
    assert.equal((await (await fetch(base)).json()).items[0].available,false);
    assert.equal((await post({input:source})).status,400);
    ready=true;
    assert.equal((await post({input:{...source,operation:'create_project'}})).status,400);
    estimate='500000000000000000000000';
    assert.equal((await post({input:source})).status,400);
  }finally{await new Promise(resolve=>server.close(resolve))}
});

test('Compare REST quote uses the one Project and configured on-chain service policy',async()=>{
  const sdk=new NfaSdk({registryAccountId:'registry.testnet',rpcUrl:'https://rpc.invalid'});
  sdk.getOutlayerProject=async()=>({state:'READY',project_uuid:'shared-uuid',version_key:'a'.repeat(64)});
  const chainPolicy={service_id:'compare',enabled:true,min_margin:policy.marginYocto,
    max_deposit:policy.maxDepositYocto,limits:policy.limits,version:1,schema_hash:schemaHashFor('compare')};
  sdk.getServiceCatalog=async()=>[chainPolicy];
  sdk.getServicePolicy=async()=>chainPolicy;
  sdk.getAgentState=async()=>({lifecycle:'Active',pending_op:null});
  sdk.getTreasury=async()=>({available:'1000000000000000000000000'});
  sdk.view=async()=> '100000000000000000000000';
  const server=createApiServer({sdk,store:{},access:{},servicePolicy:{compare:policy,scout:policy}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}/v1/nfas/nfa-1/services`;
  const input={question:'Which option has cost and speed evidence?',criteria:['cost','speed'],sources:[
    {title:'Option A',url:'https://example.org/a',text:'The cost of option A is five units for a single run. The speed of option A is two seconds per run.'},
    {title:'Option B',url:'https://example.org/b',text:'The cost of option B is seven units for a single run.'}]};
  try{
    assert.equal((await (await fetch(base)).json()).items[1].available,true);
    const response=await fetch(base+'/compare/quotes',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({input})});
    assert.equal(response.status,200);
    const quote=await response.json();
    assert.equal(quote.unsignedAction.methodName,'request_reviewed_service_job');
    assert.equal(quote.unsignedAction.args.expected_policy_version,1);
    assert.equal(quote.unsignedAction.args.service_id,'compare');
    assert.equal(quote.inputHash,digest(quote.inputData));
  }finally{await new Promise(resolve=>server.close(resolve))}
});

test('Scout quotes refuse checkout without an on-chain owner policy',async()=>{
  const sdk=new NfaSdk({registryAccountId:'registry.testnet',rpcUrl:'https://rpc.invalid'});
  sdk.getOutlayerProject=async()=>({state:'READY',project_uuid:'u',version_key:'a'.repeat(64)});
  sdk.getServicePolicy=async()=>null;
  const {quoteService}=await import('../service-runtime.mjs');
  await assert.rejects(()=>quoteService({sdk,tokenId:'nfa-1',service:'scout',body:{input:source},policy}),/not enabled/);
});

test('NFA hiring quote spends income with an exact cap and pinned owner epoch',async()=>{
  const sdk=new NfaSdk({registryAccountId:'registry.testnet',rpcUrl:'https://rpc.invalid'});
  const project={state:'READY',project_uuid:'uuid',version_key:'a'.repeat(64)};
  const onchain={service_id:'scout',version:2,enabled:true,schema_hash:schemaHashFor('scout'),
    min_margin:policy.marginYocto,max_deposit:policy.maxDepositYocto,limits:policy.limits};
  sdk.getOutlayerProject=async()=>project;sdk.getServicePolicy=async()=>onchain;
  sdk.getAgentState=async id=>({lifecycle:'Active',pending_op:null,epoch:id==='nfa-2'?5:0});
  sdk.getAgentIncome=async()=> '130000000000000000000000';
  sdk.getTreasury=async()=>({available:'1000000000000000000000000'});
  sdk.view=async()=> '100000000000000000000000';
  const {quoteService}=await import('../service-runtime.mjs');
  const quote=await quoteService({sdk,tokenId:'nfa-1',service:'scout',body:{input:source,hiredBy:'nfa-2'},policy});
  assert.equal(quote.unsignedAction.methodName,'hire_reviewed_service_job');
  assert.equal(quote.unsignedAction.deposit,'1');
  assert.equal(quote.unsignedAction.args.source_token_id,'nfa-2');
  assert.equal(quote.unsignedAction.args.expected_source_epoch,5);
  assert.equal(quote.unsignedAction.args.max_fee,quote.feeYocto);
  sdk.getAgentIncome=async()=> '1';
  await assert.rejects(()=>quoteService({sdk,tokenId:'nfa-1',service:'scout',
    body:{input:source,hiredBy:'nfa-2'},policy}),/lacks income/);
});

test('hiring NFA owner can read finalized Scout work from the hired NFA',async()=>{
  const outputHash='sha256:'+'f'.repeat(64);
  const sdk={registryAccountId:'registry.testnet',rpcUrl:'https://rpc.invalid',getServiceJob:async()=>({
    job:{status:'FINALIZED',output_hash:outputHash},service_id:'scout',hired_by:'nfa-1'})};
  const access={requireOwner:async(session,id)=>{if(session==='a'.repeat(64)&&id==='nfa-1')return 'buyer.testnet';
    throw Error('Owner session required')}};
  const server=createApiServer({sdk,store:{get:async()=>({question:'Reconstructed result'})},access});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${server.address().port}/studio/nfas/nfa-2/work/7`;
  try{
    const allowed=await fetch(url,{headers:{authorization:`Bearer ${'a'.repeat(64)}`}});
    assert.equal(allowed.status,200);
    assert.equal((await allowed.json()).outputHash,outputHash);
    assert.equal((await fetch(url,{headers:{authorization:`Bearer ${'b'.repeat(64)}`}})).status,401);
  }finally{await new Promise(resolve=>server.close(resolve))}
});
