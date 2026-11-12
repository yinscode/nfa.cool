#!/usr/bin/env node
// Read-only live gate. No signer, key material, account creation or transaction.
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

const rpcUrl=process.env.NEAR_RPC_URL||'https://rpc.testnet.near.org';
const contract='outlayer.testnet';
async function rpc(method,params){
  const response=await fetch(rpcUrl,{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:'nfa-outlayer-preflight',method,params}),signal:AbortSignal.timeout(8000)});
  if(!response.ok)throw Error(`NEAR RPC HTTP ${response.status}`);
  const data=await response.json();if(data.error)throw Error(JSON.stringify(data.error));return data.result;
}
async function view(method,args={}){
  const value=await rpc('query',{request_type:'call_function',finality:'final',account_id:contract,
    method_name:method,args_base64:Buffer.from(JSON.stringify(args)).toString('base64')});
  return JSON.parse(Buffer.from(value.result).toString());
}
async function main(){
  const limits={max_instructions:1_000_000_000,max_memory_mb:64,max_execution_seconds:10};
  if(process.argv.includes('--dry-run')){
    console.log(JSON.stringify({rpcUrl,contract,methods:['is_paused','get_pricing','estimate_execution_cost','get_project'],
      limits,makesTransactions:false},null,2));return;
  }
  const status=await rpc('status',[]);
  if(status.chain_id!=='testnet')throw Error(`Wrong NEAR chain: ${status.chain_id}`);
  const [paused,pricing,deposit]=await Promise.all([view('is_paused'),view('get_pricing'),
    view('estimate_execution_cost',{resource_limits:limits,input_len:512})]);
  const result={chain:status.chain_id,height:status.sync_info?.latest_block_height,paused,pricing,
    estimatedDepositYocto:String(deposit),limits};
  if(process.env.OUTLAYER_PROJECT_ID){result.project=await view('get_project',{project_id:process.env.OUTLAYER_PROJECT_ID})}
  if(process.env.OUTLAYER_WASM_PATH){
    const bytes=await readFile(process.env.OUTLAYER_WASM_PATH);
    result.wasmSha256=createHash('sha256').update(bytes).digest('hex');result.wasmBytes=bytes.length;
  }
  console.log(JSON.stringify(result,null,2));
}
main().catch(error=>{console.error(error.message);process.exitCode=1});
