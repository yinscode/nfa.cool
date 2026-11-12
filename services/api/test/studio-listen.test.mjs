import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {studioPort,listenStudio,assertStudioPortAvailable} from '../studio-listen.mjs';

test('Studio has a dedicated default and rejects port conflicts without displacing the existing app',async()=>{
  assert.equal(studioPort({}),3102);
  assert.equal(studioPort({NFA_PORT:'3910'}),3910);
  assert.throws(()=>studioPort({NFA_PORT:'invalid'}),/NFA_PORT/);
  const existing=await listenStudio(createServer(),0),port=existing.address().port;
  try{
    await assert.rejects(()=>assertStudioPortAvailable(port),error=>error.code==='EADDRINUSE'&&/existing app was left running/.test(error.message));
    assert.equal(existing.listening,true);
  }finally{await new Promise(resolve=>existing.close(resolve))}
  await assertStudioPortAvailable(port);
});
