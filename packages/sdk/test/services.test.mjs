import test from 'node:test';
import assert from 'node:assert/strict';
import {NfaServicesClient} from '../dist/index.js';
test('service client rejects a finalized payment bound to another runtime, service or payer',async()=>{
  const quote={tokenId:'nfa-1',service:'scout',inputHash:'hash',versionKey:'version',policyVersion:2,feeYocto:'100'};
  let record={service_id:'scout',policy_version:2,job:{requester:'customer.testnet',input_hash:'hash',version_key:'version',fee:'100'}};
  const client=new NfaServicesClient({baseUrl:'https://api.example',fetchImpl:async(url)=>new Response(JSON.stringify(
    url.endsWith('/inspect')?{status:'SUCCEEDED',assignedJobId:17}:record))});
  assert.equal((await client.inspectPayment({quote,hash:'receipt',sender:'customer.testnet'})).jobId,17);
  record={...record,job:{...record.job,version_key:'other'}};
  await assert.rejects(()=>client.inspectPayment({quote,hash:'receipt',sender:'customer.testnet'}),/differs/);
  record={...record,service_id:'compare'};
  await assert.rejects(()=>client.inspectPayment({quote,hash:'receipt',sender:'customer.testnet'}),/differs/);
});
