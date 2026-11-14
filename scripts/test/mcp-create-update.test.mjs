import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApiServer} from '../../services/api/server.mjs';
import {WorkStore} from '../../services/api/work-store.mjs';
import {AvatarRenderer} from '../../services/api/render.mjs';
import {ArtifactStore} from '../../services/api/artifact-store.mjs';
import {NfaSdk} from '@nfa/sdk';

test('MCP lets an agent start a launch and prepare owner actions, all unsigned',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'nfa-mcp-'));
  const sdk=new NfaSdk({registryAccountId:'registry.testnet',rpcUrl:'https://rpc.invalid'});
  sdk.view=async()=>null;
  sdk.get=async tokenId=>({tokenId,ownerAccountId:'alice.testnet',ownerEpoch:1,vaultAccountId:`${tokenId}.registry.testnet`,manifestUri:''});
  const server=createApiServer({sdk,store:new WorkStore(join(directory,'work')),access:{},renderer:new AvatarRenderer(join(directory,'render')),
    manifests:new WorkStore(join(directory,'manifests')),artifacts:new ArtifactStore(join(directory,'artifacts'))});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true})});
  process.env.NFA_API_URL=`http://127.0.0.1:${server.address().port}`;
  const {handle}=await import('../mcp-server.mjs');
  const names=(await handle({id:1,method:'tools/list'})).tools.map(x=>x.name);
  for(const name of ['nfa_directory','nfa_prepare_launch','nfa_launch_next','nfa_prepare_action','nfa_prepare_appearance'])assert.ok(names.includes(name),name);
  const call=async(name,args)=>{const r=await handle({id:2,method:'tools/call',params:{name,arguments:args}});assert.ok(!r.isError,r.content[0].text);return JSON.parse(r.content[0].text)};
  const launch=await call('nfa_prepare_launch',{owner:'alice.testnet',name:'MCP Scout',purpose:'scout'});
  assert.equal(launch.step.id,'mint');
  assert.equal(launch.unsignedAction.methodName,'create_agent');
  const next=await call('nfa_launch_next',{launch:launch.launch});
  assert.equal(next.launch.requestId,launch.launch.requestId);
  const unlist=await call('nfa_prepare_action',{tokenId:'nfa-4',kind:'unlist'});
  assert.equal(unlist.unsignedAction.methodName,'unlist_agent');
});
