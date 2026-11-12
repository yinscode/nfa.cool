import test from 'node:test';
import assert from 'node:assert/strict';
import {legacyWorkspaceRedirect} from '../workspace-redirect.mjs';
const legacy={network:'sandbox',registryAccountId:'registry.test.near'};
const options={href:'http://localhost:3100/studio?token=nfa-1',config:legacy,target:'http://127.0.0.1:3102',account:'alice.test.near'};
test('an old collection bookmark reaches the persistent workspace with its selected account, without copying a token ID',()=>{
  const target=new URL(legacyWorkspaceRedirect(options));
  assert.equal(target.origin,'http://localhost:3102');assert.equal(target.pathname,'/studio');
  assert.equal(target.searchParams.get('localAccount'),'alice.test.near');assert.equal(target.searchParams.has('token'),false);
  assert.equal(legacyWorkspaceRedirect({...options,href:'http://localhost:3102/studio'}),null);
  assert.equal(legacyWorkspaceRedirect({...options,config:{...legacy,serverVersion:3,workspace:{persistent:true}}}),null);
});
test('bookmark migration leaves pending signatures, other chains and nonlocal destinations alone',()=>{
  assert.equal(legacyWorkspaceRedirect({...options,pending:true}),null);
  for(const suffix of ['?transactionHashes=tx','?errorCode=cancelled','#signature=proof'])
    assert.equal(legacyWorkspaceRedirect({...options,href:'http://localhost:3100/studio'+suffix}),null);
  assert.equal(legacyWorkspaceRedirect({...options,config:{network:'testnet'}}),null);
  assert.equal(legacyWorkspaceRedirect({...options,target:'https://example.org'}),null);
  assert.equal(legacyWorkspaceRedirect({...options,href:'https://example.org/studio'}),null);
});
