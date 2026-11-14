#!/usr/bin/env node
// Read-only, keyless re-derivation of NFA.cool's live testnet facts (NEAR testnet + Sepolia).
// Compares what the chains say now with the recorded evidence. Sends no transactions.
//   npm run verify:testnet
// Env: NEAR_RPC_URL (default FastNEAR testnet), EVM_RPC_URL (default a public Sepolia node).
import {readFile,writeFile} from 'node:fs/promises';

const nearRpc=process.env.NEAR_RPC_URL||'https://test.rpc.fastnear.com';
const evmRpc=process.env.EVM_RPC_URL||'https://sepolia.gateway.tenderly.co';
const m2=JSON.parse(await readFile('docs/evidence/m02-handover.json','utf8'));
const m6=JSON.parse(await readFile('docs/evidence/m06-reviewed-preparation.json','utf8'));
const registry=process.env.NFA_REGISTRY_ID||m6.identity.vault.split('.').slice(1).join('.');
const tokenId=m6.identity.vault.split('.')[0];
const checks=[];
const check=(id,ok,observed,expected,note)=>checks.push({id,result:ok===null?'changed':ok?'match':'mismatch',observed,expected,...(note?{note}:{})});

async function rpc(url,method,params){
  const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},signal:AbortSignal.timeout(20000),
    body:JSON.stringify({jsonrpc:'2.0',id:'verify',method,params})});
  const j=await r.json();if(!r.ok||j.error||j.result?.error)throw Error(JSON.stringify(j.error||j.result?.error||r.status));return j.result;
}
const view=async(account_id,method_name,args={})=>JSON.parse(Buffer.from((await rpc(nearRpc,'query',{request_type:'call_function',finality:'final',
  account_id,method_name,args_base64:Buffer.from(JSON.stringify(args)).toString('base64')})).result).toString());

try{
  const [nft,agent,project,wallet]=await Promise.all([view(registry,'nft_token',{token_id:tokenId}),view(registry,'agent',{token_id:tokenId}),
    view(registry,'outlayer_project',{token_id:tokenId}),view(registry,'derived_wallet',{token_id:tokenId})]);
  // Facts that must never change for the same NFA.
  check('vault.stable',agent.vault_id===m6.identity.vault,agent.vault_id,m6.identity.vault);
  check('sepolia-address.stable',wallet?.address===m6.identity.address,wallet?.address,m6.identity.address);
  check('project.stable',project?.project_uuid===m6.identity.projectUuid,project?.project_uuid,m6.identity.projectUuid);
  // Facts that may legitimately move after the evidence was recorded (another sale, a new version).
  const owner=nft?.owner_id;
  check('owner.recorded',owner===m6.identity.owner?true:null,owner,m6.identity.owner,owner===m6.identity.owner?undefined:'ownership changed after the evidence; the epoch must have grown');
  check('epoch.monotonic',agent.epoch>=m6.identity.epoch,agent.epoch,`>= ${m6.identity.epoch}`);
  check('runtime.recorded',project?.version_key===m6.runtimeHash?true:null,project?.version_key,m6.runtimeHash);
  const status=await view(agent.vault_id,'status');
  check('vault.controller',status.controller===registry,status.controller,registry);
  check('vault.evm-nonce',status.next_evm_nonce>=2,status.next_evm_nonce,'>= 2 (two settled self-transfers)');
  const keys=(await rpc(nearRpc,'query',{request_type:'view_access_key_list',finality:'final',account_id:agent.vault_id})).keys;
  check('vault.keyless',keys.length===0,keys.length,0);
}catch(error){checks.push({id:'near.reachable',result:'error',observed:String(error.message||error)})}

try{
  if(await rpc(evmRpc,'eth_chainId',[])!=='0xaa36a7')throw Error('not Sepolia');
  const address=m2.initial.address;
  const finalizedNonce=Number(await rpc(evmRpc,'eth_getTransactionCount',[address,'finalized']));
  check('sepolia.finalized-nonce',finalizedNonce>=2,finalizedNonce,'>= 2');
  for(const [label,tx] of [['nonce-0',m2.first],['nonce-1',m2.second]]){
    const [receipt,onchain]=await Promise.all([rpc(evmRpc,'eth_getTransactionReceipt',[tx.tx_hash]),rpc(evmRpc,'eth_getTransactionByHash',[tx.tx_hash])]);
    const ok=receipt?.status==='0x1'&&onchain?.from?.toLowerCase()===address.toLowerCase()&&Number(onchain?.nonce)===tx.nonce&&Number(receipt?.blockNumber)===tx.observed_block;
    check(`sepolia.${label}`,ok,{status:receipt?.status,from:onchain?.from,nonce:onchain&&Number(onchain.nonce),block:receipt&&Number(receipt.blockNumber)},
      {status:'0x1',from:address,nonce:tx.nonce,block:tx.observed_block});
  }
}catch(error){checks.push({id:'sepolia.reachable',result:'error',observed:String(error.message||error)})}

const failed=checks.filter(c=>['mismatch','error'].includes(c.result));
const report={schema:1,tool:'npm run verify:testnet',checkedAt:new Date().toISOString(),readOnly:true,nearRpc,evmRpc,registry,tokenId,
  result:failed.length?'fail':'pass',checks,
  trust:'Public RPC answers are trusted here; compare with another provider by setting NEAR_RPC_URL / EVM_RPC_URL.'};
await writeFile(process.env.NFA_VERIFY_OUTPUT||'verify-testnet-report.json',JSON.stringify(report,null,2)+'\n');
for(const c of checks)console.log(`${c.result.padEnd(9)} ${c.id}`);
console.log(`\n${report.result.toUpperCase()}: ${checks.length-failed.length}/${checks.length} — verify-testnet-report.json`);
if(failed.length)process.exitCode=1;
