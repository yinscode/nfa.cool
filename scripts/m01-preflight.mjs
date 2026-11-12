#!/usr/bin/env node
import {readFile,readdir,writeFile} from 'node:fs/promises';
import {createPrivateKey,createPublicKey} from 'node:crypto';
import {NfaSdk} from '@nfa/sdk';
import {utils,KeyPair} from 'near-api-js';
const report={checkedAt:new Date().toISOString(),milestone:'M01',ready:false,blockers:[],checks:{}};
const registry=process.env.NFA_REGISTRY_ID||'nfagent-registry-0e9b2a.testnet',tokenId=process.env.NFA_RELEASE_TOKEN_ID||'nfa-2';
const evmUrl=process.env.EVM_RPC_URL||'https://ethereum-sepolia-rpc.publicnode.com';
const rpc=async(url,method,params)=>{
  const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:'m01',method,params}),signal:AbortSignal.timeout(8000)});
  const j=await r.json();if(!r.ok||j.error)throw Error('RPC unavailable');return j.result;
};
let nearUrl,identity;
const endpoints=process.env.NEAR_RPC_URL?[process.env.NEAR_RPC_URL]:['https://test.rpc.fastnear.com','https://rpc.testnet.near.org'];
const probes=await Promise.all(endpoints.map(async url=>{try{return {url,chain:(await rpc(url,'status',[])).chain_id}}catch{return {url,unavailable:true}}}));
nearUrl=probes.find(p=>p.chain==='testnet')?.url;report.nearRpc=probes;
if(!nearUrl)report.blockers.push('NEAR testnet RPC unreachable; current owner, reporter and vault cannot be authenticated');
else{
  const sdk=new NfaSdk({registryAccountId:registry,rpcUrl:nearUrl});
  try{
    identity=await sdk.get(tokenId);
    const vault=await sdk.view(identity.vaultAccountId,'status');
    report.identity=identity;report.vaultStatus=vault;
    report.checks.controller=vault.controller===registry;
    report.checks.vaultChain=vault.chain_id===11155111&&vault.path==='eth-sepolia-v1';
    const candidates=[];
    for(const name of (await readdir('deployments')).filter(n=>n.endsWith('.key.json'))){
      const key=JSON.parse(await readFile('deployments/'+name,'utf8'));if(key.account_id!==vault.reporter)continue;
      let publicKey;
      if(key.secret_key)publicKey=KeyPair.fromString(key.secret_key).getPublicKey().toString();
      else if(key.private_key_pkcs8_pem)publicKey='ed25519:'+utils.serialize.base_encode(createPublicKey(createPrivateKey(key.private_key_pkcs8_pem)).export({format:'der',type:'spki'}).subarray(-32));
      if(publicKey)candidates.push(publicKey);
    }
    report.checks.reporterKey=false;
    for(const public_key of candidates){try{const k=await rpc(nearUrl,'query',{request_type:'view_access_key',finality:'final',account_id:vault.reporter,public_key});
      if(k.permission==='FullAccess')report.checks.reporterKey=true}catch{}}
    report.nearBalances={};
    for(const id of [identity.ownerAccountId,identity.vaultAccountId,vault.reporter]){
      const account=await rpc(nearUrl,'query',{request_type:'view_account',finality:'final',account_id:id});
      report.nearBalances[id]={amount:account.amount,storageUsage:account.storage_usage,codeHash:account.code_hash};
    }
    report.checks.noPending=await sdk.getAgentState(tokenId).then(a=>a.pending_op==null)&&vault.pending==null;
  }catch{report.blockers.push('NEAR identity/reporter preflight incomplete')}
}
if(!identity){try{const cached=JSON.parse(await readFile('deployments/studio-testnet-public.json','utf8'));
  if(cached.finalIdentity?.registryAccountId===registry&&cached.tokenId===tokenId){identity=cached.finalIdentity;report.cachedIdentity=identity;report.addressSource='historical record, not authenticated by current NEAR view'}}catch{}}
try{
  const [chain,finalized]=await Promise.all([rpc(evmUrl,'eth_chainId',[]),rpc(evmUrl,'eth_getBlockByNumber',['finalized',false])]);
  report.checks.sepolia=chain==='0xaa36a7';report.checks.finalizedRpc=!!finalized?.hash;
  if(identity?.foreignWallet?.address){
    const address=identity.foreignWallet.address;
    const [balance,nonce]=await Promise.all([rpc(evmUrl,'eth_getBalance',[address,'latest']),rpc(evmUrl,'eth_getTransactionCount',[address,'latest'])]);
    report.sepolia={address,balanceWei:BigInt(balance).toString(),nonce:BigInt(nonce).toString(),finalizedBlock:finalized.number};
    report.checks.testEthFunded=BigInt(balance)>100000000000000n;
  }else report.blockers.push('Pinned NFA Sepolia address unavailable');
}catch{report.blockers.push('Sepolia RPC/finality preflight incomplete')}
for(const [name,passed] of Object.entries(report.checks))if(!passed)report.blockers.push('Check failed: '+name);
report.ready=!!nearUrl&&!!report.identity&&report.blockers.length===0;
await writeFile('docs/evidence/m01-preflight.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));if(!report.ready)process.exitCode=2;
