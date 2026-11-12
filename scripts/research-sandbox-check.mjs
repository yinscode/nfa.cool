#!/usr/bin/env node
// Isolated receipt integration. OutLayer is a deterministic stand-in, never a hosted TEE/model.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
import {connect,keyStores,KeyPair} from 'near-api-js';
import {NfaSdk} from '@nfa/sdk';
import {startSandbox} from './sandbox-check.mjs';
import {schemaHashFor} from '../services/api/service-runtime.mjs';
const hash=v=>'sha256:'+createHash('sha256').update(v).digest('hex');
const port=()=>new Promise(resolve=>{const s=createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p))})});
const home=await mkdtemp(join(tmpdir(),'nfa-research-'));let child;
try{
  const running=await startSandbox(process.env.NEAR_SANDBOX_BIN_PATH,home,await port(),await port());child=running.child;
  const keys=new keyStores.InMemoryKeyStore(),rootKey=JSON.parse(await readFile(join(home,'validator_key.json')));
  await keys.setKey('sandbox','test.near',KeyPair.fromString(rootKey.secret_key));
  const node=await connect({networkId:'sandbox',nodeUrl:running.rpcUrl,deps:{keyStore:keys}}),root=await node.account('test.near');
  const people={};for(const name of ['registry','outlayer','alice','bob','customer']){
    const id=name+'.test.near',key=KeyPair.fromRandom('ed25519');await root.createAccount(id,key.getPublicKey(),30n*10n**24n);
    await keys.setKey('sandbox',id,key);people[name]=await node.account(id);
  }
  const {registry,outlayer,alice,bob,customer}=people,tokenId='nfa-1',registryId=registry.accountId;
  const raw=async(who,target,methodName,args,deposit=0n)=>{
    const tx=await who.functionCall({contractId:target,methodName,args,attachedDeposit:BigInt(deposit),gas:250_000_000_000_000n});
    const hashes=[...new Set([tx.transaction_outcome,...tx.receipts_outcome].map(r=>r.block_hash))];
    const heights=await Promise.all(hashes.map(blockId=>node.connection.provider.block({blockId}).then(b=>b.header.height)));
    for(let i=0;i<60;i++){
      if((await node.connection.provider.block({finality:'final'})).header.height>=Math.max(...heights))return tx;
      await new Promise(r=>setTimeout(r,150));
    }
    throw Error('Sandbox receipt did not finalize');
  };
  const call=(who,method,args,deposit=0n)=>raw(who,registryId,method,args,deposit);
  const action=(who,a)=>raw(who,a.receiverId,a.methodName,a.args,a.deposit);
  await outlayer.deployContract(await readFile('output/sandbox-outlayer-mock.wasm'));await raw(outlayer,outlayer.accountId,'new',{});
  await registry.deployContract(await readFile('output/sandbox-nfa-registry.wasm'));
  await call(registry,'new',{admin:registryId,reporter:registryId,guardian:registryId});
  await call(alice,'create_agent',{request_id:'research-acceptance',manifest_hash:hash('manifest'),manifest_uri:'nfa://research'},6n*10n**24n);
  const sdk=new NfaSdk({registryAccountId:registryId,rpcUrl:running.rpcUrl});
  const initial=await sdk.get(tokenId),version='a'.repeat(64),deposit='3000000000000000000000',fee='20000000000000000000000';
  await call(alice,'provision_outlayer',{token_id:tokenId,wasm_url:'https://example.org/local-fixture.wasm',version_key:version,deposit},1n);
  const project=await sdk.getOutlayerProject(tokenId);assert.equal(project.state,'READY');
  const settings={version_key:version,secrets_ref:{account_id:alice.accountId,profile:'research'},
    allowed_sources:[{host:'docs.near.org',path_prefix:'/'}],model:'local-fixture',max_input_tokens:24000,max_output_tokens:512,
    input_microusd_per_token:1,output_microusd_per_token:2,max_cost_microusd:30000,daily_budget_microusd:100000};
  await action(alice,sdk.configureResearch(tokenId,settings));
  const limits={max_instructions:1000000000,max_memory_mb:128,max_execution_seconds:30};
  await action(alice,sdk.configureService(tokenId,'research',schemaHashFor('research'),true,'10000000000000000000000','500000000000000000000000',limits));
  const config=await sdk.getResearchConfig(tokenId),policy=await sdk.getServicePolicy(tokenId,'research');
  const run=async(question,expected='FINALIZED')=>{
    const input=JSON.stringify({question,sources:[{title:'NEAR docs',url:'https://docs.near.org/'}]});
    await action(customer,sdk.requestReviewedServiceJob(tokenId,'research',hash(input),Number(BigInt(Date.now()+3600000)*1000000n),
      fee,deposit,deposit,limits,version,policy.version,config.configuration_hash));
    const id=(await sdk.getAgentState(tokenId)).pending_op;
    await call(customer,'start_service_job',{token_id:tokenId,id,input_data:input});
    const record=await sdk.getServiceJob(tokenId,id);assert.equal(record.job.status,expected);
    assert.equal((await sdk.getAgentState(tokenId)).pending_op,null);
    const context=await sdk.view(outlayer.accountId,'research_context',{project_uuid:project.project_uuid,job_id:id});
    return {id,record,context};
  };
  const first=await run('What is stable vault ownership?');assert.equal(first.record.research_usage.state,'PRICED_USAGE');
  assert.equal(first.record.research_usage.priced_usage_microusd,160);assert.deepEqual(first.context.priorWork,[]);
  const unknown=await run('[fixture] unknown inference result','FAILED');
  assert.equal(unknown.record.research_usage.state,'UNKNOWN');assert.equal(unknown.record.research_usage.priced_usage_microusd,null);
  await assert.rejects(()=>call(customer,'start_service_job',{token_id:tokenId,id:unknown.id,input_data:'{}'}));
  assert.equal((await sdk.getAgentState(tokenId)).lifecycle,'Draining');
  await call(alice,'resume_failed_service',{token_id:tokenId,failed_job_id:unknown.id},1n);
  await action(alice,sdk.listForSale(tokenId,'1000000000000000000000',Number(BigInt(Date.now()+3600000)*1000000n)));
  const listing=(await sdk.get(tokenId)).listing;await action(bob,sdk.buy(tokenId,listing.nonce,listing.price));
  await assert.rejects(()=>action(alice,sdk.configureResearch(tokenId,settings)));
  await assert.rejects(()=>action(alice,sdk.recallOwnerMemory(tokenId,first.id,deposit)));
  const recallTx=await action(bob,sdk.recallOwnerMemory(tokenId,first.id,deposit));
  const afterRecall=await sdk.getAgentState(tokenId);assert.equal(afterRecall.pending_op,null);
  const second=await run('Which finalized work can the new owner use?');
  assert.deepEqual(second.context.priorWork,[{jobId:first.id,outputHash:first.record.job.output_hash}]);
  assert.equal(second.context.ownerEpoch,initial.ownerEpoch+1);
  const final=await sdk.get(tokenId),finalProject=await sdk.getOutlayerProject(tokenId),ledger=await sdk.getPaidLedger();
  assert.equal(final.vaultAccountId,initial.vaultAccountId);assert.equal(finalProject.project_uuid,project.project_uuid);
  assert.equal(ledger.customer_escrow,'0');assert.equal(ledger.vault_replenishment_pending,'0');
  assert.equal(final.income,(2n*(BigInt(fee)-BigInt(deposit))).toString());
  const budget=await sdk.view(registryId,'research_budget',{token_id:tokenId});assert.equal(budget.reserved_microusd,75072);
  const refund=await sdk.view(registryId,'payout',{seller:customer.accountId});assert.equal(refund.available,fee);
  const result={milestone:'M05',complete:true,mode:'isolated NEAR sandbox with deterministic OutLayer fixture',
    registryCodeSha256:createHash('sha256').update(await readFile('output/sandbox-nfa-registry.wasm')).digest('hex'),
    vault:final.vaultAccountId,projectUuid:finalProject.project_uuid,owner:final.ownerAccountId,
    jobs:{first:first.id,unknown:unknown.id,buyer:second.id},priorWork:second.context.priorWork,
    ledgers:{nativeNear:ledger,incomeYocto:final.income,customerRefundYocto:refund.available,modelUsdAllowance:budget,
      firstModelUsage:first.record.research_usage,unknownModelUsage:unknown.record.research_usage},
    recallTransaction:recallTx.transaction_outcome.id,
    checks:['same vault/Project across sale','seller configuration and recall denied','buyer recalled old work',
      'only finalized prior work entered buyer context','unknown inference was not retried','unknown job refunded customer NEAR',
      'USD allowance remained reserved separately','no customer escrow or replenishment remains'],
    limits:['Fixture does not run a model, retrieve web pages, decrypt credentials or attest execution.','Native guest tests separately cover durable model-attempt idempotency.']};
  await writeFile('docs/evidence/m05-memory-billing.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
}finally{if(child){child.kill();await new Promise(r=>{child.once('exit',r);setTimeout(r,3000).unref()})}await rm(home,{recursive:true,force:true,maxRetries:5,retryDelay:100})}
