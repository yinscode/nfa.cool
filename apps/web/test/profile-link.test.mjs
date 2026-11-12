import test from 'node:test';
import assert from 'node:assert/strict';
import {profileLink} from '../profile-link.mjs';
test('public links bind the registry and network so the same token ID cannot silently open on another chain',()=>{
  const sandbox=new URL(profileLink('http://localhost:3102','nfa-2',{network:'sandbox',registryAccountId:'registry.test.near',workspace:{id:'saved-chain'}}));
  assert.equal(sandbox.searchParams.get('workspace'),'saved-chain');assert.equal(sandbox.searchParams.get('network'),'sandbox');
  const live=new URL(profileLink('http://localhost:3102','nfa-2',{network:'testnet',registryAccountId:'registry.testnet'}));
  assert.equal(live.searchParams.get('registry'),'registry.testnet');assert.equal(live.searchParams.has('workspace'),false);
});
