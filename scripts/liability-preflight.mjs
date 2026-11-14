#!/usr/bin/env node
// Read-only testnet inventory for the one-time registry liability migration.
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {utils} from 'near-api-js';
import {NfaSdk} from '@nfa/sdk';

const registry=process.env.NFA_REGISTRY_ID||'nfagent-registry-0e9b2a.testnet';
const rpcUrl=process.env.NEAR_RPC_URL||'https://test.rpc.fastnear.com';
const sdk=new NfaSdk({registryAccountId:registry,rpcUrl});
async function query(params){
  const response=await fetch(rpcUrl,{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:'liability-preflight',method:'query',params:{finality:'final',...params}}),
    signal:AbortSignal.timeout(20000)});
  const data=await response.json();if(!response.ok||data.error)throw Error(JSON.stringify(data.error||response.status));
  return data.result;
}
function accountKey(raw,prefix){
  const bytes=Buffer.from(raw,'base64'),head=Buffer.from(prefix);
  if(!bytes.subarray(0,head.length).equals(head)||bytes.length<head.length+4)throw Error('Unexpected storage key');
  const length=bytes.readUInt32LE(head.length);
  if(bytes.length!==head.length+4+length)throw Error('Malformed storage key');
  return bytes.subarray(head.length+4).toString('utf8');
}
async function storage(prefix){
  const result=await query({request_type:'view_state',account_id:registry,prefix_base64:Buffer.from(prefix).toString('base64')});
  return result.values.map(row=>accountKey(row.key,prefix)).sort();
}
const [payoutAccounts,tokens,provisions,account,paidLedger]=await Promise.all([
  storage('P'),storage('g'),storage('p'),query({request_type:'view_account',account_id:registry}),
  sdk.view(registry,'paid_scout_ledger')]);
const codeHash=Buffer.from(utils.serialize.base_decode(account.code_hash)).toString('hex');
const oldCode=await readFile('releases/nfa-registry-research-3547ac6018aa2d5e.wasm');
const oldHash=createHash('sha256').update(oldCode).digest('hex');
if(codeHash!==oldHash)throw Error(`Deployed registry ${codeHash} is not the reviewed prior release ${oldHash}`);
if(provisions.length)throw Error(`Unresolved provision rows require review: ${provisions.join(', ')}`);
const supply=Number(await sdk.view(registry,'nft_total_supply'));
if(tokens.length!==supply||tokens.some((id,i)=>id!==`nfa-${i+1}`))throw Error('Token inventory is incomplete or nonsequential');
const payouts={};let payoutTotal=0n;
for(const name of payoutAccounts){
  const row=await sdk.view(registry,'payout',{seller:name});
  if(row.pending)throw Error(`Payout transfer in flight for ${name}`);
  payouts[name]={available:row.available,pending:row.pending};
  payoutTotal+=BigInt(row.available);
}
const agents={};let income=0n;
for(const token of tokens){
  const identity=await sdk.get(token);
  const [agent,status,project,balance]=await Promise.all([
    sdk.getAgentState(token),sdk.view(identity.vaultAccountId,'status'),
    sdk.getOutlayerProject(token).catch(()=>null),sdk.view(registry,'agent_income',{token_id:token})]);
  if(agent.pending_op!=null||status.pending!=null)throw Error(`${token} has a pending operation`);
  income+=BigInt(balance);
  agents[token]={owner:identity.ownerAccountId,epoch:identity.ownerEpoch,vault:identity.vaultAccountId,
    address:identity.foreignWallet?.address??null,projectUuid:project?.project_uuid??null,
    runtime:project?.version_key??null,income:balance,manifestHash:identity.manifestHash,
    vaultStatus:status};
}
if(BigInt(paidLedger.customer_escrow)!==0n||BigInt(paidLedger.vault_replenishment_pending)!==0n)
  throw Error('Live paid jobs require an in-flight migration review');
const total=payoutTotal+income+BigInt(paidLedger.customer_escrow);
const storageCost=BigInt(account.storage_usage)*10n**19n;
const available=BigInt(account.amount)-storageCost;
const newCode=await readFile('releases/nfa-registry-reviewed-0f02c8a935199f99.wasm');
const newCodeHash=createHash('sha256').update(newCode).digest('hex');
const projectedStorageCost=storageCost+BigInt(newCode.length-oldCode.length)*10n**19n;
const reserve=10n**23n;
const requiredTopUp=(projectedStorageCost+total+reserve-BigInt(account.amount));
const result={checkedAt:new Date().toISOString(),network:'NEAR testnet',registry,oldCodeSha256:codeHash,
  newCodeSha256:newCodeHash,
  account:{balanceYocto:account.amount,storageBytes:account.storage_usage,availableAboveStorageYocto:available.toString()},
  payoutAccounts,payouts,agents,paidLedger,
  migration:{payout_accounts:payoutAccounts,expected_payouts:payoutTotal.toString(),expected_total:total.toString()},
  breakdown:{payouts:payoutTotal.toString(),income:income.toString(),paidEscrow:paidLedger.customer_escrow,
    legacyEscrow:'0',recallDeposits:'0',total:total.toString()},
  projectedStorageCostYocto:projectedStorageCost.toString(),requiredTopUpYocto:(requiredTopUp>0n?requiredTopUp:0n).toString()};
await writeFile('docs/evidence/liability-migration-preflight.json',JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({oldCodeSha256:codeHash,payoutAccounts:payoutAccounts.length,
  payouts:payoutTotal.toString(),income:income.toString(),escrow:paidLedger.customer_escrow,
  total:total.toString(),requiredTopUp:result.requiredTopUpYocto},null,2));
