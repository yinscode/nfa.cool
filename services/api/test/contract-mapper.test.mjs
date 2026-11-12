import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {agentIdentity, operationRecord} from '../contract-mapper.mjs';

test('NEAR registry view maps to SDK/API identity fixture', () => {
  const fixture=JSON.parse(readFileSync(new URL('../../../packages/shared/fixtures/nfa.json',import.meta.url)));
  const contract={vault_id:fixture.vaultAccountId,epoch:0,lifecycle:'Active',
    manifest_hash:fixture.manifestHash,manifest_uri:fixture.manifestUri};
  const result=agentIdentity(fixture.registryAccountId,fixture.tokenId,{owner_id:fixture.ownerAccountId},contract);
  assert.deepEqual(result,fixture);
});
test('NEAR operation view maps monetary amount as a string', () => {
  const fixture=JSON.parse(readFileSync(new URL('../../../packages/shared/fixtures/operation.json',import.meta.url)));
  const view={id:fixture.id,token_id:fixture.tokenId,epoch:fixture.ownerEpoch,kind:fixture.kind,
    status:'Requested',requested_by:fixture.requestedBy,recipient:fixture.recipient,amount:fixture.amount};
  assert.deepEqual(operationRecord(view,{vault_id:fixture.vaultAccountId}),fixture);
});
