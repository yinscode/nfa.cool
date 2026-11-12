import {createServer} from 'node:net';

// Keep NFA separate from other workspace APIs that commonly use port 3000.
export function studioPort(env=process.env){
  const port=Number(env.NFA_PORT||3102);
  if(!Number.isInteger(port)||port<1||port>65535)throw Error('NFA_PORT must be an integer from 1 to 65535');
  return port;
}

export function listenStudio(server,port=studioPort(),host='127.0.0.1'){
  return new Promise((resolve,reject)=>{
    const failed=error=>{
      server.off('listening',ready);
      reject(error.code==='EADDRINUSE'?Object.assign(new Error(
        `NFA Studio port ${port} is already in use. Choose a free port with NFA_PORT; the existing app was left running.`,
        {cause:error}),{code:error.code}):error);
    };
    const ready=()=>{server.off('error',failed);resolve(server)};
    server.once('error',failed);server.once('listening',ready);
    server.listen(port,host);
  });
}

export async function assertStudioPortAvailable(port=studioPort()){
  const probe=await listenStudio(createServer(),port);
  await new Promise((resolve,reject)=>probe.close(error=>error?reject(error):resolve()));
}
