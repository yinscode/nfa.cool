import {spawnSync} from 'node:child_process';
import {createScoutBrief} from '../../services/worker/scout.mjs';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';

const fixture={question:'How does a transferable agent retain its NEAR treasury?',sources:[
  {title:'Vault note',url:'https://example.org/vault',text:'A transferable agent retains its NEAR treasury in a keyless vault controlled by the NFT registry. The vault checks the registry as its predecessor before a withdrawal. A buyer gets the same vault address after ownership transfer.'},
  {title:'Transfer note',url:'https://example.org/transfer',text:'Transfer advances the owner epoch and rejects commands from the previous owner. Existing balances remain in the agent vault after transfer. A pending signature keeps the transfer locked until it is reconciled.'}
]};
const expected=createScoutBrief(fixture);
const child=spawnSync(fileURLToPath(new URL('./target/debug/nfa-scout-wasi',import.meta.url)),{
  input:JSON.stringify({operation:'scout',jobId:7,...fixture}),encoding:'utf8'});
assert.equal(child.status,0,child.stderr);
const result=JSON.parse(child.stdout);
assert.equal(result.outputHash,expected.outputHash);
assert.equal(result.outputUri,expected.outputUri);
console.log(JSON.stringify({jobId:result.jobId,outputHash:result.outputHash,matched:true}));
