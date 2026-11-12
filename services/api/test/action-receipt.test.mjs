import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectLaunchAction} from '../action-receipt.mjs';
test('launch receipt binds exact signer, method, args and deposit before clearing a pending mint',async()=>{
  const action={receiverId:'registry.test.near',methodName:'create_agent',args:{request_id:'stable',manifest_hash:'sha256:abc',manifest_uri:'nfa://manifest/abc'},deposit:'600',gas:'250'};
  const tx={final_execution_status:'FINAL',status:{SuccessValue:''},transaction:{hash:'hash',signer_id:'alice.test.near',receiver_id:action.receiverId,actions:[{FunctionCall:{method_name:action.methodName,args:Buffer.from(JSON.stringify(action.args)).toString('base64'),gas:'250',deposit:'600'}}]}};
  const sdk={registryAccountId:action.receiverId,transaction:async()=>tx};
  assert.equal((await inspectLaunchAction({sdk,hash:'hash',sender:'alice.test.near',action})).status,'SUCCEEDED');
  await assert.rejects(()=>inspectLaunchAction({sdk,hash:'hash',sender:'alice.test.near',action:{...action,args:{...action.args,request_id:'another'}}}),/arguments changed/);
  await assert.rejects(()=>inspectLaunchAction({sdk,hash:'hash',sender:'bob.test.near',action}),/identity mismatch/);
  tx.final_execution_status='EXECUTED_OPTIMISTIC';assert.equal((await inspectLaunchAction({sdk,hash:'hash',sender:'alice.test.near',action})).status,'PENDING');
});
