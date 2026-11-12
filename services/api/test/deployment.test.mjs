import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {deploymentConfig,readiness} from '../deployment.mjs';
import {createApiServer} from '../server.mjs';

test('public deployment requires a stable origin and durable inputs; readiness fails closed',async()=>{
  assert.throws(()=>deploymentConfig({NODE_ENV:'production'}),/HTTPS/);
  assert.throws(()=>deploymentConfig({NODE_ENV:'production',NFA_PUBLIC_ORIGIN:'https://nfa.example'}),/durable/);
  const config=deploymentConfig({NODE_ENV:'production',NFA_PUBLIC_ORIGIN:'https://nfa.example',NFA_DATA_DIR:'/data',NFA_DURABLE_DATA:'1'});
  assert.equal(config.origin,'https://nfa.example');assert.equal(config.host,'127.0.0.1');
  const data=await mkdtemp(join(tmpdir(),'nfa-ready-'));
  const check=readiness({sdk:{rpcUrl:'https://rpc.invalid',registryAccountId:'registry.testnet'},data,
    fetchImpl:async()=>({ok:true,json:async()=>({error:{message:'unavailable'}})})});
  const server=createApiServer({sdk:{registryAccountId:'registry.testnet',rpcUrl:'https://private.invalid/secret'},deployment:config,readyCheck:check});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
  try{
    assert.equal((await fetch(base+'/healthz')).status,200);
    const publicConfig=await (await fetch(base+'/config')).json();
    assert.equal(publicConfig.rpcUrl,'https://test.rpc.fastnear.com');
    assert.ok(!JSON.stringify(publicConfig).includes('private.invalid'));
    assert.equal((await fetch(base+'/readyz')).status,503);
    assert.equal((await fetch(base+'/prepare',{method:'POST',headers:{origin:'https://other.example'}})).status,403);
  }finally{await new Promise(resolve=>server.close(resolve));await rm(data,{recursive:true,force:true})}
});
