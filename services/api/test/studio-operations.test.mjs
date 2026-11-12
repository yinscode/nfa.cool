import test from 'node:test';
import assert from 'node:assert/strict';
import {finances,recoveryActions} from '../studio-state.mjs';
import {simulateTransaction,validateTransactionPolicy,unsignedSepolia} from '../transaction-policy.mjs';
import {inspectTransaction} from '../transaction-receipt.mjs';
import {materializeWork} from '../materialize-work.mjs';
import {createScoutBrief} from '../../worker/scout.mjs';
import {createHash} from 'node:crypto';

test('Studio finances keep escrow, replenishment and income separate; recovery never restarts uncertainty',()=>{
  const rows=[{id:1,service:{job:{status:'FINALIZED',fee:'50',replenish:'20'}}},
    {id:2,service:{job:{status:'RECONCILING',fee:'60',replenish:'30',reimbursement_pending:false}}},
    {id:3,service:{job:{status:'FAILED',fee:'70'}}}];
  assert.deepEqual(finances(rows),{customerEscrow:'60',replenishmentLiability:'30',recallFunding:'0',grossReceipts:'50',replenished:'20',refunded:'70'});
  const args={registryAccountId:'registry.testnet',tokenId:'nfa-1',agent:{pending_op:2},rows};
  assert.equal(recoveryActions(args)[0].unsignedAction.methodName,'retry_outlayer_replenishment');
  rows[1].service.job.status='UNCERTAIN';
  // Uncertain work is never restarted, retried or refunded by guess; the only offer is the
  // vault-confirmed release (B1), which fails unless no result can still arrive.
  assert.deepEqual(recoveryActions(args).map(a=>a.unsignedAction.methodName),['release_service_job']);
});

test('transfer preview enforces recipient, budget and epoch before returning exact unsigned bytes',async()=>{
  assert.throws(()=>validateTransactionPolicy({nearEnabled:true,evmEnabled:false,nearRecipients:[],evmRecipients:[],maxNear:'1',maxEvm:'0',maxFee:1}),/Invalid/);
  const sdk={get:async()=>({ownerAccountId:'alice.testnet',ownerEpoch:2,lifecycle:'ACTIVE',vaultAccountId:'nfa-1.registry.testnet'}),
    getAgentState:async()=>({pending_op:null}),getTreasury:async()=>({available:'100'}),
    view:async()=>({near_enabled:true,near_recipients:['bob.testnet'],max_near:'20'}),
    requestNearTransfer:(_id,recipient,yocto)=>({methodName:'request_near_transfer',args:{recipient,amount:yocto}})};
  const body={kind:'near_transfer',expectedOwner:'alice.testnet',expectedEpoch:2,recipient:'bob.testnet',yocto:'15'};
  assert.equal((await simulateTransaction({sdk,tokenId:'nfa-1',body})).availableAfter,'85');
  await assert.rejects(()=>simulateTransaction({sdk,tokenId:'nfa-1',body:{...body,yocto:'21'}}),/policy/);
  await assert.rejects(()=>simulateTransaction({sdk,tokenId:'nfa-1',body:{...body,expectedEpoch:1}}),/Ownership/);
  const preview=unsignedSepolia({nonce:0,recipient:'0x'+'11'.repeat(20),valueWei:'1',priorityFee:1,maxFee:2});
  assert.equal(preview.unsigned,'0x02e283aa36a78001028252089411111111111111111111111111111111111111110180c0');
  assert.match(preview.digest,/^0x[0-9a-f]{64}$/);
});

test('checkout obtains job ID from a matching finalized receipt, never a counter guess',async()=>{
  const hash='1'.repeat(44),sender='customer.testnet',inputHash='sha256:'+'a'.repeat(64);
  const tx={final_execution_status:'FINAL',transaction:{hash,signer_id:sender,receiver_id:'registry.testnet',
    actions:[{FunctionCall:{method_name:'request_service_job',args:Buffer.from(JSON.stringify({token_id:'nfa-1',input_hash:inputHash})).toString('base64')}}]},
    status:{SuccessValue:Buffer.from('9').toString('base64')},receipts_outcome:[{id:'receipt',outcome:{executor_id:'registry.testnet',
      logs:['EVENT_JSON:'+JSON.stringify({standard:'nfa',event:'service_job_requested',data:[{token_id:'nfa-1',id:9}]})]}}]};
  const sdk={registryAccountId:'registry.testnet',get:async()=>({vaultAccountId:'nfa-1.registry.testnet'}),
    transaction:async()=>tx,getPaidJob:async()=>({requester:sender,input_hash:inputHash})};
  assert.equal((await inspectTransaction({sdk,tokenId:'nfa-1',hash,sender})).assignedJobId,9);
  sdk.getPaidJob=async()=>({requester:'attacker.testnet',input_hash:inputHash});
  await assert.rejects(()=>inspectTransaction({sdk,tokenId:'nfa-1',hash,sender}),/commitment mismatch/);
});

test('full work is materialized only when public input reproduces the finalized commitment',async()=>{
  const input={question:'How does the agent retain its treasury?',sources:[{title:'Vault',url:'https://example.org/vault',
    text:'The agent retains its treasury in the same NEAR vault after the NFT transfers to its new owner.'}]};
  const inputData=JSON.stringify(input),result=createScoutBrief(input),version='a'.repeat(64);
  const job={status:'FINALIZED',input_hash:'sha256:'+createHash('sha256').update(inputData).digest('hex'),output_hash:result.outputHash,version_key:version};
  const sdk={registryAccountId:'registry.testnet',getServiceJob:async()=>({job,service_id:'scout'}),
    transaction:async()=>({final_execution_status:'FINAL',status:{SuccessValue:''},transaction:{hash:'1'.repeat(44),signer_id:'alice.testnet',receiver_id:'registry.testnet',actions:[{FunctionCall:{
      method_name:'start_service_job',args:Buffer.from(JSON.stringify({token_id:'nfa-1',id:5,input_data:inputData})).toString('base64')}}]}})};
  let stored=null;const store={put:async artifact=>{stored=artifact;return {outputHash:result.outputHash}}};
  const args={sdk,store,tokenId:'nfa-1',jobId:5,startHash:'1'.repeat(44),sender:'alice.testnet',releases:[{versionKey:version,artifactCodec:'scout-compare-v1'}]};
  assert.equal((await materializeWork(args)).outputHash,result.outputHash);assert.deepEqual(stored,result.artifact);
  job.output_hash='sha256:'+'f'.repeat(64);await assert.rejects(()=>materializeWork(args),/differs/);
});
