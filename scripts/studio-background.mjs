#!/usr/bin/env node
import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile,open,rm,access} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve,join} from 'node:path';
import {studioPort,assertStudioPortAvailable} from '../services/api/studio-listen.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const directory=join(root,'.data/studio-server'),statePath=join(directory,`run-${studioPort()}.json`),logPath=join(directory,`server-${studioPort()}.log`);
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const alive=pid=>{try{process.kill(pid,0);return true}catch(error){if(error.code==='ESRCH')return false;if(error.code==='EPERM')return true;throw error}};
async function saved(){try{return JSON.parse(await readFile(statePath,'utf8'))}catch(error){if(error.code==='ENOENT')return null;throw error}}
async function config(port){try{const response=await fetch(`http://127.0.0.1:${port}/config`,{signal:AbortSignal.timeout(1500)});
  return response.ok?await response.json():null}catch{return null}}
async function status(state){
  if(!state||!Number.isSafeInteger(state.pid)||state.pid<2||!alive(state.pid))return 'stopped';
  const current=await config(state.port);
  return current?.network==='sandbox'&&current.localSandbox?.instanceId===state.instanceId?'running':'unconfirmed';
}
async function start(){
  const previous=await saved(),previousStatus=await status(previous);
  if(previousStatus==='running'){console.log(`NFA Studio running at http://127.0.0.1:${previous.port}/studio`);return}
  if(previousStatus==='unconfirmed')throw Error(`A recorded Studio process is still alive but not ready. Inspect ${logPath}; no duplicate was started.`);
  const port=studioPort();await assertStudioPortAvailable(port);
  const binary=resolve(root,process.env.NEAR_SANDBOX_BIN_PATH||'.deps/bin/near-sandbox');
  for(const file of [binary,join(root,'apps/web/dist/index.html'),join(root,'output/sandbox-nfa-registry.wasm'),join(root,'output/sandbox-outlayer-mock.wasm')])await access(file);
  await mkdir(directory,{recursive:true,mode:0o700});
  const log=await open(logPath,'a',0o600),instanceId=randomUUID(),controlToken=randomUUID()+randomUUID();
  let child;
  try{
    child=spawn(process.execPath,[join(root,'scripts/persistent-studio.mjs')],{
      cwd:root,detached:true,stdio:['ignore',log.fd,log.fd],env:{...process.env,NFA_PORT:String(port),
        NEAR_SANDBOX_BIN_PATH:binary,NFA_SANDBOX_OUTLAYER:'1',NFA_SANDBOX_REGISTRY_WASM:join(root,'output/sandbox-nfa-registry.wasm'),
        NFA_STUDIO_INSTANCE_ID:instanceId,NFA_STUDIO_CONTROL_TOKEN:controlToken}});
    await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject)});
  }finally{await log.close()}
  child.unref();
  const state={pid:child.pid,port,instanceId,controlToken,startedAt:new Date().toISOString()};
  await writeFile(statePath,JSON.stringify(state,null,2)+'\n',{mode:0o600});
  for(let attempt=0;attempt<90;attempt++){
    if(await status(state)==='running'){
      console.log(`NFA Studio running at http://127.0.0.1:${port}/studio\nBackground PID ${state.pid}; log: ${logPath}\nStop with npm run studio:stop`);return;
    }
    if(child.exitCode!==null||!alive(state.pid))break;
    await pause(500);
  }
  throw Error(`Studio did not become ready. Inspect ${logPath}; its recorded process was not blindly restarted.`);
}
async function stop(){
  const state=await saved(),current=await status(state);
  if(current==='stopped'){console.log('NFA Studio is stopped');return}
  if(current!=='running')throw Error(`Cannot verify the recorded Studio instance; refusing to signal an unrelated process. Inspect ${logPath}`);
  if(!state.controlToken)throw Error('This older server needs to be stopped from its original terminal');
  const response=await fetch(`http://127.0.0.1:${state.port}/dev/server/stop`,{method:'POST',headers:{'x-nfa-dev-control':state.controlToken}});
  if(response.status!==202)throw Error('Development server did not accept the authenticated stop request');
  for(let attempt=0;attempt<40;attempt++){
    if(!(await config(state.port))){await rm(statePath,{force:true});console.log('NFA Studio stopped');return}
    await pause(250);
  }
  throw Error('Studio is still stopping; inspect the log before restarting');
}
try{
  switch(process.argv[2]){
    case 'start':await start();break;
    case 'stop':await stop();break;
    case 'status':{const state=await saved(),current=await status(state);console.log(current==='running'?
      `NFA Studio running at http://127.0.0.1:${state.port}/studio`:`NFA Studio ${current}`);break}
    default:throw Error('Usage: node scripts/studio-background.mjs start|status|stop');
  }
}catch(error){console.error(error.message);process.exitCode=1}
