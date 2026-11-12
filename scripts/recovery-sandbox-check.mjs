#!/usr/bin/env node
// Isolated receipt integration for the liveness fixes (review B1/B2). It uses a local
// NEAR sandbox and the deterministic OutLayer mock; no testnet, no hosted runtime.
//   NEAR_SANDBOX_BIN_PATH=.deps/bin/near-sandbox node scripts/recovery-sandbox-check.mjs
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
import {connect,keyStores,KeyPair} from 'near-api-js';
import {NfaSdk} from '@nfa/sdk';
import {startSandbox} from './sandbox-check.mjs';

const hash=v=>'sha256:'+createHash('sha256').update(v).digest('hex');
const port=()=>new Promise(resolve=>{const s=createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p))})});
const registryWasm=process.env.NFA_SANDBOX_REGISTRY_WASM||'output/sandbox-nfa-registry.wasm';
const NEAR=10n**24n,MOCK_COST=10n**21n;
const home=await mkdtemp(join(tmpdir(),'nfa-recovery-'));let child;
try{
  const running=await startSandbox(process.env.NEAR_SANDBOX_BIN_PATH,home,await port(),await port());child=running.child;
  const keys=new keyStores.InMemoryKeyStore(),rootKey=JSON.parse(await readFile(join(home,'validator_key.json')));
  await keys.setKey('sandbox','test.near',KeyPair.fromString(rootKey.secret_key));
  const node=await connect({networkId:'sandbox',nodeUrl:running.rpcUrl,deps:{keyStore:keys}}),root=await node.account('test.near');
  const people={};for(const name of ['registry','outlayer','alice','customer','stranger']){
    const id=name+'.test.near',key=KeyPair.fromRandom('ed25519');await root.createAccount(id,key.getPublicKey(),30n*NEAR);
    await keys.setKey('sandbox',id,key);people[name]=await node.account(id);
  }
  const {registry,outlayer,alice,customer,stranger}=people,tokenId='nfa-1',registryId=registry.accountId;
  // Waits until every receipt of the transaction is final; failures are returned, not thrown.
  const raw=async(who,target,methodName,args,deposit=0n)=>{
    let tx;try{tx=await who.functionCall({contractId:target,methodName,args,attachedDeposit:BigInt(deposit),gas:300_000_000_000_000n})}
    catch(error){return {failed:true,error:String(error.message||error)}}
    const hashes=[...new Set([tx.transaction_outcome,...tx.receipts_outcome].map(r=>r.block_hash))];
    const heights=await Promise.all(hashes.map(blockId=>node.connection.provider.block({blockId}).then(b=>b.header.height)));
    for(let i=0;i<80;i++){
      if((await node.connection.provider.block({finality:'final'})).header.height>=Math.max(...heights)+2)return tx;
      await new Promise(r=>setTimeout(r,150));
    }
    throw Error('Sandbox receipt did not finalize');
  };
  const call=(who,method,args,deposit=0n)=>raw(who,registryId,method,args,deposit);
  await outlayer.deployContract(await readFile('output/sandbox-outlayer-mock.wasm'));await raw(outlayer,outlayer.accountId,'new',{});
  await registry.deployContract(await readFile(registryWasm));
  await call(registry,'new',{admin:registryId,reporter:registryId,guardian:registryId});
  await call(alice,'create_agent',{request_id:'recovery',manifest_hash:hash('manifest'),manifest_uri:'nfa://recovery'},6n*NEAR);
  const sdk=new NfaSdk({registryAccountId:registryId,rpcUrl:running.rpcUrl});
  const version='a'.repeat(64);
  await call(alice,'provision_outlayer',{token_id:tokenId,wasm_url:'https://example.org/local-fixture.wasm',version_key:version,deposit:(10n**22n).toString()},1n);
  assert.equal((await sdk.getOutlayerProject(tokenId)).state,'READY');
  const limits={max_instructions:1_000_000_000,max_memory_mb:64,max_execution_seconds:10};
  await call(alice,'configure_service',{token_id:tokenId,service_id:'scout',schema_hash:hash('scout-schema'),enabled:true,
    min_margin:(10n**22n).toString(),max_deposit:(5n*10n**23n).toString(),limits},1n);
  const input=JSON.stringify({question:'Does the vault stay the same?',sources:[{title:'Vault',url:'https://example.org/vault',
    text:'The NFA vault stays the same account when the NFT owner changes hands.'}]});
  const deadline=()=>Number((BigInt(Date.now())+1_500_000n)*1_000_000n);
  const request=(deposit,lim=limits)=>call(customer,'request_reviewed_service_job',{token_id:tokenId,service_id:'scout',input_hash:hash(input),
    deadline_ns:deadline(),fee:(deposit+10n**22n).toString(),replenish:deposit.toString(),deposit_cap:deposit.toString(),
    limits:lim,expected_version:version,expected_policy_version:1},deposit+10n**22n);
  const agent=()=>sdk.getAgentState(tokenId);
  const results=[];

  // B1a: the original freeze inputs are refused before any job is recorded.
  const tiny=await request(1n),narrow=await request(MOCK_COST*3n,{...limits,max_instructions:1});
  // Release WASM strips panic text; the native tests assert the exact messages.
  assert.ok(tiny.failed&&narrow.failed);
  assert.equal((await agent()).pending_op,null);assert.equal((await agent()).next_op_id,2,'No job ID was allocated');
  results.push('customer cannot choose 1-yocto deposit or 1-instruction limits');

  // B1b: an execution OutLayer rejects (deposit at the floor, below the mock's cost) used to
  // freeze the NFA forever. It is now released and refunded without any owner action.
  const refundsBefore=BigInt((await sdk.view(registryId,'payout',{seller:customer.accountId})).available);
  assert.ok(!(await request(MOCK_COST)).failed);
  const jobId=(await agent()).pending_op;assert.ok(jobId);
  await call(customer,'start_service_job',{token_id:tokenId,id:jobId,input_data:input});
  const stuck=await sdk.getPaidJob(tokenId,jobId);
  assert.equal(stuck.status,'UNCERTAIN',JSON.stringify(stuck));
  assert.equal((await agent()).pending_op,jobId);
  assert.ok((await call(alice,'create_listing',{token_id:tokenId,price:NEAR.toString(),expires_at_ns:deadline()},1n)).failed,'Sale is blocked while uncertain');
  assert.ok(!(await call(stranger,'release_service_job',{token_id:tokenId,id:jobId})).failed);
  assert.equal((await sdk.getPaidJob(tokenId,jobId)).status,'FAILED');
  assert.equal((await agent()).pending_op,null);
  assert.equal(BigInt((await sdk.view(registryId,'payout',{seller:customer.accountId})).available)-refundsBefore,MOCK_COST+10n**22n);
  assert.equal((await sdk.view(`${tokenId}.${registryId}`,'status')).pending,null,'Vault pending cleared');
  results.push('OutLayer-rejected job released permissionlessly, customer refunded, vault clear');

  // B2: a withdrawal above the vault balance is a definite failure, not a permanent lock.
  const over=await call(alice,'request_near_transfer',{token_id:tokenId,recipient:stranger.accountId,amount:(100n*NEAR).toString()},1n);
  assert.ok(!over.failed||/false/.test(over.error));
  const near=await sdk.view(registryId,'operation',{token_id:tokenId,id:jobId+1});
  assert.equal(near.status,'Failed',JSON.stringify(near));
  assert.equal((await agent()).pending_op,null);assert.equal((await agent()).lifecycle,'Active');
  results.push('over-balance NEAR transfer fails definitely and unlocks');

  // H1: the single operation slot cannot be held long or for free.
  const ledger=()=>sdk.view(registryId,'registry_ledger');
  const storageFee=BigInt((await ledger()).job_storage_fee),deposit=3n*MOCK_COST,fee=deposit+10n**22n;
  const payout=async who=>BigInt((await sdk.view(registryId,'payout',{seller:who})).available);
  const income=async()=>BigInt(await sdk.view(registryId,'agent_income',{token_id:tokenId}));
  const at=offsetMs=>Number((BigInt(Date.now())+BigInt(offsetMs))*1_000_000n);
  const requestAt=(deadline_ns,data=input)=>call(customer,'request_reviewed_service_job',{token_id:tokenId,service_id:'scout',input_hash:hash(data),
    deadline_ns,fee:fee.toString(),replenish:deposit.toString(),deposit_cap:deposit.toString(),limits,expected_version:version,expected_policy_version:1},fee);
  assert.ok((await requestAt(at(31*60_000))).failed,'Deadline beyond 30 minutes is refused');
  let refunds=await payout(customer.accountId),earned=await income();
  assert.ok(!(await requestAt(at(4_000))).failed);
  const unstarted=(await agent()).pending_op;
  await new Promise(r=>setTimeout(r,5_000));
  assert.ok(!(await call(stranger,'expire_unstarted_paid_scout',{token_id:tokenId,id:unstarted})).failed);
  assert.equal(await payout(customer.accountId)-refunds,deposit,'Unstarted requester gets the execution deposit back');
  assert.equal(await income()-earned,fee-deposit-storageFee,'The agent keeps the margin net of storage');
  results.push('unstarted job: 30-minute window, deposit refunded, margin compensates the agent');
  refunds=await payout(customer.accountId);
  assert.ok(!(await requestAt(at(600_000))).failed);
  const cancelled=(await agent()).pending_op;
  assert.ok(!(await call(alice,'cancel_unstarted_job',{token_id:tokenId,id:cancelled},1n)).failed);
  assert.equal(await payout(customer.accountId)-refunds,fee);assert.equal((await agent()).pending_op,null);
  results.push('owner cancels an unstarted job with a full refund');

  // H2: a failure caused by the customer's input pays for compute and keeps the agent available.
  const empty=JSON.stringify({question:'Does an empty source list work?',sources:[]});
  refunds=await payout(customer.accountId);
  assert.ok(!(await requestAt(at(600_000),empty)).failed);
  const failing=(await agent()).pending_op;
  await call(customer,'start_service_job',{token_id:tokenId,id:failing,input_data:empty});
  assert.equal((await sdk.getPaidJob(tokenId,failing)).status,'FAILED');
  assert.equal(await payout(customer.accountId)-refunds,fee-deposit-storageFee,'Compute and storage are charged on a customer-caused failure');
  const after=await agent();assert.equal(after.pending_op,null);assert.equal(after.lifecycle,'Active');
  assert.equal((await sdk.view(`${tokenId}.${registryId}`,'status')).pending,null,'Vault acknowledged');
  results.push('customer-caused failure reimburses the vault and leaves the agent Active');

  // H3: tracked liabilities equal what the registry owes: customer credits plus agent income.
  assert.equal(BigInt((await ledger()).liabilities),await payout(customer.accountId)+await income());
  results.push('tracked liabilities equal customer credits plus unclaimed income');

  // The NFA is sellable again.
  assert.ok(!(await call(alice,'create_listing',{token_id:tokenId,price:NEAR.toString(),expires_at_ns:deadline()},1n)).failed);
  assert.equal((await agent()).lifecycle,'Listed');
  results.push('listing succeeds after recovery');
  console.log(JSON.stringify({sandbox:'local NEAR sandbox + OutLayer mock',registryWasm,results},null,2));
}finally{
  if(child&&child.exitCode==null){const exited=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await exited}
  await rm(home,{recursive:true,force:true,maxRetries:5})
}
