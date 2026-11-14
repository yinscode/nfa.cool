#!/usr/bin/env node
// Read-only reconciliation of all stored payout/income rows against the live counter.
import {writeFile} from 'node:fs/promises';
import {NfaSdk} from '@nfa/sdk';
const rpcUrl=process.env.NEAR_RPC_URL||'https://test.rpc.fastnear.com';
const registry=process.env.NFA_REGISTRY_ID||'nfagent-registry-0e9b2a.testnet';
const sdk=new NfaSdk({registryAccountId:registry,rpcUrl});
async function query(params){const response=await fetch(rpcUrl,{method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({jsonrpc:'2.0',id:'verify-liabilities',method:'query',params:{finality:'final',...params}}),
  signal:AbortSignal.timeout(15000)});const data=await response.json();
  if(!response.ok||data.error)throw Error(JSON.stringify(data.error||response.status));return data.result}
async function keys(prefix){
  const {values}=await query({request_type:'view_state',account_id:registry,prefix_base64:Buffer.from(prefix).toString('base64')});
  return values.map(row=>{const b=Buffer.from(row.key,'base64'),length=b.readUInt32LE(prefix.length);
    if(b.length!==prefix.length+4+length)throw Error('Unexpected storage key');return b.subarray(prefix.length+4).toString()}).sort();
}
const [payoutAccounts,tokens,ledger,paid,account]=await Promise.all([keys('P'),keys('I'),
  sdk.view(registry,'registry_ledger'),sdk.view(registry,'paid_scout_ledger'),
  query({request_type:'view_account',account_id:registry})]);
let payouts=0n,income=0n;const payoutRows={},incomeRows={};
for(const name of payoutAccounts){const p=await sdk.view(registry,'payout',{seller:name});
  if(p.pending)throw Error(`Payout transfer in flight: ${name}`);payoutRows[name]=p.available;payouts+=BigInt(p.available)}
for(const token of tokens){const a=await sdk.view(registry,'agent',{token_id:token});
  if(a?.pending_op!=null)throw Error(`Agent operation in flight: ${token}`);
  const value=await sdk.view(registry,'agent_income',{token_id:token});incomeRows[token]=value;income+=BigInt(value)}
if(BigInt(paid.vault_replenishment_pending)!==0n)throw Error('Replenishment in flight');
const total=payouts+income+BigInt(paid.customer_escrow);
if(total!==BigInt(ledger.liabilities))throw Error(`Liability counter ${ledger.liabilities} differs from rows ${total}`);
const reserve=BigInt(account.amount)-BigInt(account.storage_usage)*10n**19n-total;
if(reserve<0n)throw Error('Registry is undercollateralized after storage');
const evidence={checkedAt:new Date().toISOString(),network:'NEAR testnet',registry,payoutRows,incomeRows,
  escrow:paid.customer_escrow,payouts:payouts.toString(),income:income.toString(),liabilities:ledger.liabilities,
  registryBalance:account.amount,storageBytes:account.storage_usage,reserveAboveLiabilities:reserve.toString(),
  result:'balanced'};
await writeFile('docs/evidence/live-liability-reconciliation.json',JSON.stringify(evidence,null,2)+'\n');
console.log(JSON.stringify({balanced:true,liabilities:ledger.liabilities,reserveAboveLiabilities:reserve.toString()},null,2));
