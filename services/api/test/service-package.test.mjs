import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewedPackages,validateServicePackage} from '../service-package.mjs';
import {schemaHashFor} from '../service-runtime.mjs';
test('reviewed packages preserve deployed schema hashes and keep research visibly a candidate',async()=>{
  const packages=await reviewedPackages();
  for(const p of packages.filter(p=>p.id!=='research'))assert.equal(p.inputSchemaHash,schemaHashFor(p.id));
  const research=packages.find(p=>p.id==='research');assert.equal(research.stage,'candidate');
  assert.equal(research.runtime,'outlayer-wasip2');assert.equal(research.inputSchemaHash,schemaHashFor('research'));
  assert.throws(()=>validateServicePackage({...research,stage:'hosted-testnet-verified'}),/hosted acceptance/);
  assert.throws(()=>validateServicePackage({...research,permissions:{...research.permissions,treasury:true}}),/permissions/);
});
