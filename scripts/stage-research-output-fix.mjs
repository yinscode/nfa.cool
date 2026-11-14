#!/usr/bin/env node
// Publish and stage the bounded reasoning/output repair without changing the active Project version.
import {readFile,writeFile} from 'node:fs/promises';
import {parseEnv} from 'node:util';
import {createHash} from 'node:crypto';
import {transactions} from 'near-api-js';
import {NfaSdk} from '@nfa/sdk';
import {testnet,pause} from './testnet-lib.mjs';
import {researchEncryptionKey,researchSecretAccess,sealOutlayerSecrets} from '../services/worker/outlayer-secrets.mjs';

const phase=process.argv[2];if(!['upload','secret','stage','verify'].includes(phase))throw Error('Use upload, secret, stage or verify');
const long=process.argv[3]==='long';if(process.argv[3]&&!long)throw Error('Use optional long mode');
const hash=b=>createHash('sha256').update(b).digest('hex');
const newHash=long?'a8513acd137f37ce21a820e8d2e9b92b9712970e3c3710b41a4e26df06137588':
  '40e425829df5f22253c80a5ede821bbc13bdcafedb846f7faeb6fbb6ebc8772e';
const oldHash=long?'40e425829df5f22253c80a5ede821bbc13bdcafedb846f7faeb6fbb6ebc8772e':
  '578af9bf7adb3a8d40b749ece673b8a8f25d777f7ed2c881a294628f4e3a7dfe';
const oldCandidateHash=long?null:'f959f859af13e783e35df24c857b8e4a54739f7a6525248cffd4c2fe1d5b26b9';
const bytes=await readFile(long?'releases/nfa-services-research-a8513acd137f37ce.wasm':
  'releases/nfa-services-research-40e425829df5f222.wasm');
if(hash(bytes)!==newHash)throw Error('Pinned HTTPS Research WASM changed');
const ctx=await testnet(long?'deployments/research-long-stage.json':
  'deployments/research-output-fix-stage.json'),registry=await ctx.signer('t006-registry');
const operator=await ctx.signer('t004-operator'),alice=await ctx.signer('t006-alice'),funder=await ctx.signer('studio-funder');
const sdk=new NfaSdk({registryAccountId:registry.id,rpcUrl:ctx.rpcUrl});
const tokenId='nfa-2',identity=await sdk.get(tokenId),vault=identity.vaultAccountId;
const project=await sdk.getOutlayerProject(tokenId),agent=await sdk.getAgentState(tokenId);
const profile=long?'research-v8':'research-v7',accessor={Project:{project_id:project.project_id}};
const access=researchSecretAccess(vault,newHash);
if(identity.ownerAccountId!==alice.id||project.project_id!==`${vault}/scout`||
  project.state!=='READY'||project.version_key!==oldHash||
  ![oldCandidateHash,newHash].includes(project.candidate_version)||
  agent.pending_op!=null||agent.lifecycle!=='Active')
  throw Error('Owner, active Project or NFA operation state changed');
const until=async(work,predicate,label)=>{for(let i=0;i<80;i++){
  const value=await work();if(predicate(value))return value;await pause(500)
}throw Error(`${label} not observed; inspect journal before retry`)};
const sendAction=(label,who,a)=>ctx.send(label,who,a.receiverId,[transactions.functionCall(
  a.methodName,a.args,BigInt(a.gas),BigInt(a.deposit))]);

if(phase==='upload'){
  if(!ctx.evidence.upload){ctx.evidence.upload=await ctx.upload('researchOutputFixUpload',funder,bytes,'application/wasm','wasm');await ctx.save()}
  if(ctx.evidence.upload.hash!==newHash)throw Error('FastFS upload hash changed');
  console.log(JSON.stringify({phase,url:ctx.evidence.upload.url,wasmHash:newHash}));
}
if(phase==='secret'){
  const stored=await sdk.view('outlayer.testnet','get_secrets',{accessor,profile,owner:operator.id});
  if(!stored){
    const values=parseEnv(await readFile('.env.research','utf8'));
    if(!values.NFA_RESEARCH_API_KEY||values.NFA_RESEARCH_PROVIDER!=='near-ai'||!values.NFA_RESEARCH_MODEL)
      throw Error('Dedicated near-ai provider credential/model unavailable');
    const pubkey=await researchEncryptionKey({owner:operator.id,profile,projectId:project.project_id});
    const sealed=sealOutlayerSecrets(pubkey,{NFA_RESEARCH_API_KEY:values.NFA_RESEARCH_API_KEY,
      NFA_RESEARCH_PROVIDER:values.NFA_RESEARCH_PROVIDER});
    await ctx.send('storeResearchHttpsSecretV7',operator,'outlayer.testnet',[transactions.functionCall(
      'store_secrets',Buffer.from(JSON.stringify({accessor,profile,encrypted_secrets_base64:sealed,
        access,vault_id:null})),50_000_000_000_000n,100_000_000_000_000_000_000_000n)]);
  }
  const row=await until(()=>sdk.view('outlayer.testnet','get_secrets',{accessor,profile,owner:operator.id}),
    r=>!!r,'Research secret');
  if(JSON.stringify(row.access)!==JSON.stringify(access))throw Error('Research secret is not bound to vault and exact new WASM hash');
  console.log(JSON.stringify({phase,profile,owner:operator.id,projectId:project.project_id,wasmHash:newHash,stored:true}));
}
if(phase==='stage'){
  if(!ctx.evidence.upload||ctx.evidence.upload.hash!==newHash)throw Error('Upload and verify exact WASM first');
  const stored=await sdk.view('outlayer.testnet','get_secrets',{accessor,profile,owner:operator.id});
  if(JSON.stringify(stored?.access)!==JSON.stringify(access))throw Error('Exact new WASM secret grant required');
  if(project.candidate_version!==newHash){
    if(project.candidate_version!==oldCandidateHash)throw Error('Unexpected candidate version');
    await sendAction('stageResearchOutputFixVersion',alice,sdk.addOutlayerVersion(tokenId,ctx.evidence.upload.url,
      newHash,'10000000000000000000000'));
  }
  const staged=await until(()=>sdk.getOutlayerProject(tokenId),r=>r?.state==='READY'&&r.candidate_version===newHash,
    'Inactive Project candidate');
  console.log(JSON.stringify({phase,activeHash:staged.version_key,candidateHash:staged.candidate_version,
    scope:'Candidate only; active on-chain Research remains unchanged'}));
}
if(phase==='verify'){
  const stored=await sdk.view('outlayer.testnet','get_secrets',{accessor,profile,owner:operator.id});
  const result={checkedAt:new Date().toISOString(),network:'NEAR testnet',vault,projectId:project.project_id,
    activeHash:project.version_key,candidateHash:project.candidate_version,newWasmHash:newHash,
    secret:{profile,owner:operator.id,accessMatches:JSON.stringify(stored?.access)===JSON.stringify(access)},
    upload:ctx.evidence.upload?{url:ctx.evidence.upload.url,hash:ctx.evidence.upload.hash,
      note:'FastFS upload receipt reports failure by design; published bytes were fetched and hash-verified'}:null,
    transactions:Object.fromEntries(Object.entries(ctx.evidence.steps).map(([name,step])=>
      [name,{hash:step.hash,failed:step.outcome?.failed??null}])),
    scope:'New guest is staged but inactive. No paid HTTPS inference or on-chain async settlement.'};
  if(result.candidateHash!==newHash||!result.secret.accessMatches||result.upload?.hash!==newHash)
    throw Error('HTTPS Research candidate incomplete');
  await writeFile(long?'docs/evidence/research-long-staged.json':
    'docs/evidence/research-output-fix-staged.json',JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({phase,activeHash:result.activeHash,candidateHash:newHash,secretBound:true}));
}
