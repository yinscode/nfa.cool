#!/usr/bin/env node
// Read-only live preflight for the delayed vault-owned OutLayer Payment Key rollout.
import {readFile,writeFile} from 'node:fs/promises';
import {parseEnv} from 'node:util';
import {createHash} from 'node:crypto';
import {utils} from 'near-api-js';
import {NfaSdk} from '@nfa/sdk';
import {researchSecretAccess} from '../services/worker/outlayer-secrets.mjs';

const rpcUrl=process.env.NEAR_RPC_URL||'https://test.rpc.fastnear.com';
const registry='nfagent-registry-0e9b2a.testnet',tokenId='nfa-2',vault=`${tokenId}.${registry}`;
const payer='nfa-studio-mwd3mksx.testnet',operator='01871de834e09e380684d3cdbdfd4a3d029051ce76957865bbccc19471b35ae8';
const oldRegistry='b733b54b7ea955c6f95042f3ecbe27ad2391dbaa83409416d2dc9cdc790295b4';
const newRegistry='5a6f3f0b37c0a2178c65ba48018366da62f220b22881a02eac07ad8470f71fbb';
const oldVault='200821c58802e52ac795fbd1a594a66d6f6de8703862019972b9ee93bc33c6e7';
const activeWasm='578af9bf7adb3a8d40b749ece673b8a8f25d777f7ed2c881a294628f4e3a7dfe';
const researchWasm='3bc0201218feab5b9685326df499d2c25ce449028d811124d46109b062850ad6';
const sdk=new NfaSdk({registryAccountId:registry,rpcUrl});
const rpc=async(method,params)=>{const response=await fetch(rpcUrl,{method:'POST',
  headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:'vault-key-preflight',method,params}),
  signal:AbortSignal.timeout(15000)});const data=await response.json();
  if(!response.ok||data.error)throw Error(JSON.stringify(data.error||response.status));return data.result};
const codeHash=async id=>Buffer.from(utils.serialize.base_decode((await rpc('query',{
  request_type:'view_account',finality:'final',account_id:id})).code_hash)).toString('hex');
const sha=b=>createHash('sha256').update(b).digest('hex');
const [identity,project,agent,authorities,setup,nonce,token,balance,regHash,vaultHash,block,secret]=await Promise.all([
  sdk.get(tokenId),sdk.getOutlayerProject(tokenId),sdk.getAgentState(tokenId),
  sdk.view(registry,'authorities'),sdk.view(registry,'payment_key_setup',{token_id:tokenId}).catch(()=>null),
  sdk.view('outlayer.testnet','get_next_payment_key_nonce',{account_id:vault}),
  sdk.view('outlayer.testnet','get_payment_token_contract',{}),
  sdk.view('usdc.fakes.testnet','ft_balance_of',{account_id:payer}),codeHash(registry),codeHash(vault),
  rpc('block',{finality:'final'}),
  sdk.view('outlayer.testnet','get_secrets',{accessor:{Project:{project_id:`${vault}/scout`}},
    profile:'research-v5',owner:operator})]);
const key=JSON.parse(await readFile('.data/outlayer-payment-key-nfa-2.private.json','utf8'));
const env=parseEnv(await readFile('.env.research','utf8'));
const eligible=BigInt(authorities.registry_upgrade.proposed_at_ns)+172_800_000_000_000n;
const ready=identity.vaultAccountId===vault&&identity.ownerAccountId==='nfagent-alice-fe53d8.testnet'&&
  agent.pending_op==null&&agent.lifecycle==='Active'&&project.state==='READY'&&
  project.project_id===`${vault}/scout`&&project.version_key===activeWasm&&
  project.candidate_version===researchWasm&&regHash===oldRegistry&&vaultHash===oldVault&&
  authorities.admin===operator&&authorities.registry_upgrade.code_hash===newRegistry&&
  setup==null&&nonce===key.nonce&&key.owner===vault&&
  key.projectIds?.length===1&&key.projectIds[0]===project.project_id&&
  key.maxPerCallMicrousd==='100000'&&sha(Buffer.from(key.encryptedSecretsBase64))===key.ciphertextHash&&
  token==='usdc.fakes.testnet'&&BigInt(balance)>=500_000n&&
  JSON.stringify(secret?.access)===JSON.stringify(researchSecretAccess(vault,researchWasm))&&
  env.NFA_RESEARCH_PROVIDER==='near-ai'&&!!env.NFA_RESEARCH_API_KEY&&!!env.NFA_RESEARCH_MODEL;
if(!ready)throw Error('Vault-owned Payment Key rollout preflight changed');
const evidence={checkedAt:new Date().toISOString(),network:'NEAR testnet',tokenId,vault,
  owner:identity.ownerAccountId,ownerEpoch:identity.ownerEpoch,projectUuid:project.project_uuid,
  activeWasm,stagedResearchWasm:researchWasm,registryCodeHash:regHash,vaultCodeHash:vaultHash,
  proposedRegistryCodeHash:newRegistry,proposalEligibleAt:new Date(Number(eligible/1_000_000n)).toISOString(),
  blockTime:new Date(Number(BigInt(block.header.timestamp_nanosec)/1_000_000n)).toISOString(),
  delayElapsed:BigInt(block.header.timestamp_nanosec)>=eligible,setupState:null,
  paymentKey:{owner:key.owner,nonce:key.nonce,projectIds:key.projectIds,maxPerCallMicrousd:key.maxPerCallMicrousd,
    ciphertextHash:key.ciphertextHash,issued:false},token,payer,balanceMicrousd:balance,
  secretProfile:'research-v5',secretGrantMatches:true,modelConfigured:true,
  upgradeRehearsal:'docs/evidence/payment-key-upgrade-rehearsal.json',
  liabilityReconciliation:'docs/evidence/live-liability-reconciliation.json',
  readyExceptForDelay:true};
await writeFile('docs/evidence/vault-key-rollout-preflight.json',JSON.stringify(evidence,null,2)+'\n');
console.log(JSON.stringify({ready:true,delayElapsed:evidence.delayElapsed,eligibleAt:evidence.proposalEligibleAt,
  payerBalanceMicrousd:balance,registryCodeHash:regHash,vaultCodeHash:vaultHash}));
