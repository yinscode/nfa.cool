import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,access} from 'node:fs/promises';

const claims=JSON.parse(await readFile('docs/CLAIMS.json','utf8'));
const sources={sandbox:'scripts/sandbox-check.mjs',recovery:'scripts/recovery-sandbox-check.mjs',
  research:'scripts/research-sandbox-check.mjs',rehearsal:'scripts/rehearse-studio-upgrade.mjs'};
test('every claim names existing evidence and valid levels and status',async()=>{
  for(const claim of claims.claims){
    assert.ok(claims.statuses[claim.status],`${claim.id}: status`);
    for(const level of claim.level)assert.ok(claims.levels[level],`${claim.id}: level ${level}`);
    for(const path of claim.evidence)await access(path);
    if(claim.status==='open'||claim.status==='not-claimed')assert.ok(claim.limits,`${claim.id}: open claims say why`);
  }
  assert.equal(new Set(claims.claims.map(c=>c.id)).size,claims.claims.length,'unique ids');
});
test('every linked transaction appears in its evidence file',async()=>{
  for(const claim of claims.claims)for(const tx of claim.transactions||[]){
    assert.ok((await readFile(tx.evidence,'utf8')).includes(tx.hash),`${claim.id}: ${tx.hash} not in ${tx.evidence}`);
    assert.ok(tx.url.endsWith(tx.hash));
  }
});
test('every judge check is an assertion the judge actually runs',async()=>{
  for(const claim of claims.claims)for(const check of claim.judge||[]){
    const [step,...rest]=check.split(':'),assertion=rest.join(':');
    if(step==='contracts'){assert.ok(['registry','vault'].includes(assertion),check);continue}
    assert.ok(sources[step],`${claim.id}: unknown step ${step}`);
    assert.ok((await readFile(sources[step],'utf8')).includes(assertion),`${claim.id}: "${assertion}" not asserted in ${sources[step]}`);
  }
});
