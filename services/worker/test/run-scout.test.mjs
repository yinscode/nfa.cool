import test from 'node:test';
import assert from 'node:assert/strict';
import {createScoutBrief} from '../scout.mjs';
import {runScout} from '../run-scout.mjs';

const input={question:'How does an agent retain its treasury?',sources:[
  {title:'Vault',url:'https://example.org/vault',text:'An agent retains its treasury in a vault that is controlled by the NFT registry. The buyer keeps the same vault after ownership changes.'}]};
test('worker commits exact paid brief and verifies finalization',async()=>{
  const result=createScoutBrief(input);let status='REQUESTED';
  const sdk={get:async()=>({ownerEpoch:0,lifecycle:'ACTIVE'}),getJob:async()=>({epoch:0,status,
    brief_hash:result.briefHash,source_hash:result.sourceHash,output_hash:status==='FINALIZED'?result.outputHash:null}),
    prepare:(method,args,deposit)=>({method,args,deposit})};
  const wallet={signAndSendTransaction:async action=>{assert.equal(action.method,'complete_scout_job');status='FINALIZED'}};
  const store={put:async()=>({outputHash:result.outputHash})};
  assert.equal((await runScout({sdk,store,wallet,tokenId:'nfa-1',jobId:1,input})).outputHash,result.outputHash);
});
test('worker refuses to commit when epoch changes after producing work',async()=>{
  const result=createScoutBrief(input);let checks=0,called=false;
  const sdk={get:async()=>({ownerEpoch:checks++?1:0,lifecycle:'ACTIVE'}),getJob:async()=>({epoch:0,status:'REQUESTED',
    brief_hash:result.briefHash,source_hash:result.sourceHash})};
  await assert.rejects(()=>runScout({sdk,store:{put:async()=>({outputHash:result.outputHash})},
    wallet:{signAndSendTransaction:async()=>{called=true}},tokenId:'nfa-1',jobId:1,input}),/Ownership or job changed/);
  assert.equal(called,false);
});
test('worker waits for a lagging final view without resubmitting completion',async()=>{
  const result=createScoutBrief(input);let submissions=0,reads=0;
  const sdk={get:async()=>({ownerEpoch:0,lifecycle:'ACTIVE'}),getJob:async()=>({epoch:0,
    status:++reads>4?'FINALIZED':'REQUESTED',brief_hash:result.briefHash,
    source_hash:result.sourceHash,output_hash:reads>4?result.outputHash:null}),
    prepare:(method,args,deposit)=>({method,args,deposit})};
  await runScout({sdk,store:{put:async()=>({outputHash:result.outputHash})},input,
    wallet:{signAndSendTransaction:async()=>{submissions++}},tokenId:'nfa-1',jobId:1});
  assert.equal(submissions,1);
});
