import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {createCompareBrief} from '../../services/worker/compare.mjs';

const fixture={question:'Which choice has cost and speed evidence?',criteria:['cost','speed'],sources:[
  {title:'Option A',url:'https://example.org/a',text:'The cost of option A is five units for a single run. The speed of option A is two seconds per run.'},
  {title:'Option B',url:'https://example.org/b',text:'The cost of option B is seven units for a single run.'}
]};
const expected=createCompareBrief(fixture);
const guest=fileURLToPath(new URL('./target/debug/nfa-scout-wasi',import.meta.url));
const child=spawnSync(guest,{input:JSON.stringify({operation:'run',service:'compare',jobId:9,...fixture}),encoding:'utf8'});
assert.equal(child.status,0,child.stderr);
const result=JSON.parse(child.stdout);
assert.equal(result.outputHash,expected.outputHash);
assert.equal(result.outputUri,expected.outputUri);
console.log(JSON.stringify({service:'compare',jobId:9,outputHash:result.outputHash,matched:true}));
