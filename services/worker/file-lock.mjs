import {open,readFile,stat,unlink} from 'node:fs/promises';

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
/** A lock is stale when its process is gone, or (legacy empty lock) it is older than a minute. */
async function stale(path){
  let text;try{text=await readFile(path,'utf8')}catch(e){return false}
  let pid=null;try{pid=JSON.parse(text).pid}catch{}
  if(Number.isSafeInteger(pid)&&pid>0){try{process.kill(pid,0);return false}catch(e){return e.code==='ESRCH'}}
  try{return Date.now()-(await stat(path)).mtimeMs>60_000}catch{return false}
}
/**
 * Exclusive section guarded by a pid-stamped lock file. A crash no longer leaves a lock that
 * blocks every later writer; a live holder is waited for, then reported.
 */
export async function withFileLock(path,work,{waitMs=5_000}={}){
  for(const started=Date.now();;){
    try{const handle=await open(path,'wx',0o600);
      try{await handle.writeFile(JSON.stringify({pid:process.pid,at:new Date().toISOString()}));await handle.sync()}finally{await handle.close()}
      break;
    }catch(error){
      if(error.code!=='EEXIST')throw error;
      if(await stale(path)){await unlink(path).catch(()=>{});continue}
      if(Date.now()-started>waitMs)throw Error(`Lock held by a live process: ${path}`);
      await pause(100);
    }
  }
  try{return await work()}finally{await unlink(path).catch(()=>{})}
}
