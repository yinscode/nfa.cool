import {isAbsolute} from 'node:path';
import {mkdir,access} from 'node:fs/promises';
import {constants} from 'node:fs';

export function deploymentConfig(env=process.env){
  const production=env.NODE_ENV==='production';
  const port=Number(env.NFA_PORT||env.PORT||3102);
  if(!Number.isInteger(port)||port<1||port>65535)throw Error('Invalid API port');
  const origin=env.NFA_PUBLIC_ORIGIN||`http://127.0.0.1:${port}`;
  const url=new URL(origin);
  if(url.origin!==origin||url.username||url.password)throw Error('NFA_PUBLIC_ORIGIN must be an exact origin');
  if(production&&url.protocol!=='https:')throw Error('Production requires an HTTPS public origin');
  if(production&&!(env.NFA_REGISTRY_ID||'nfagent-registry-0e9b2a.testnet').endsWith('.testnet'))throw Error('This release supports NEAR testnet only');
  const data=env.NFA_DATA_DIR||'.data';
  // Inputs and transaction journals require persistence even when artwork uses S3.
  if(production&&(!isAbsolute(data)||env.NFA_DURABLE_DATA!=='1'))
    throw Error('Production requires an absolute durable NFA_DATA_DIR and NFA_DURABLE_DATA=1');
  const host=env.NFA_BIND_HOST||'127.0.0.1';
  if(!['127.0.0.1','0.0.0.0','::1'].includes(host))throw Error('Invalid API bind host');
  const publicRpcUrl=env.NFA_PUBLIC_RPC_URL||'https://test.rpc.fastnear.com';
  if(!['https://test.rpc.fastnear.com','https://rpc.testnet.near.org'].includes(publicRpcUrl))throw Error('Use an approved public testnet RPC for browser configuration');
  return {production,port,origin,data,host,publicRpcUrl,durable:env.NFA_DURABLE_DATA==='1'};
}

export function readiness({sdk,data,fetchImpl=fetch}){
  let cached=null,expires=0;
  return async()=>{
    if(Date.now()<expires)return cached;
    try{
      await mkdir(data,{recursive:true,mode:0o700});await access(data,constants.W_OK);
      const response=await fetchImpl(sdk.rpcUrl,{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({jsonrpc:'2.0',id:'readiness',method:'query',params:{
          request_type:'view_account',finality:'final',account_id:sdk.registryAccountId}}),signal:AbortSignal.timeout(5000)});
      const value=await response.json();
      if(!response.ok||value.error||!value.result?.code_hash||/^1+$/.test(value.result.code_hash))throw Error('Registry unavailable');
      const statusResponse=await fetchImpl(sdk.rpcUrl,{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({jsonrpc:'2.0',id:'readiness-network',method:'status',params:[]}),signal:AbortSignal.timeout(5000)});
      const status=await statusResponse.json();
      if(!statusResponse.ok||status.result?.chain_id!=='testnet')throw Error('Wrong NEAR network');
      cached={ready:true,registry:sdk.registryAccountId};
    }catch{cached={ready:false,reason:'registry_or_storage_unavailable'}}
    expires=Date.now()+5000;return cached;
  };
}
