#!/usr/bin/env node
// Temporary, project-restricted operator Payment Key for a separate HTTPS diagnostic.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash,randomBytes} from 'node:crypto';
import {transactions} from 'near-api-js';
import {NfaSdk} from '@nfa/sdk';
import {testnet} from './testnet-lib.mjs';
import {sealOutlayerPaymentKey} from '../services/worker/outlayer-secrets.mjs';

const phase=process.argv[2];
if(!['prepare','issue','fund','verify'].includes(phase))throw Error('Use prepare, issue, fund or verify');
const ctx=await testnet('deployments/operator-payment-key.json');
const operator=await ctx.signer('t004-operator'),payer=await ctx.signer('studio-funder');
const sdk=new NfaSdk({registryAccountId:'nfagent-registry-0e9b2a.testnet',rpcUrl:ctx.rpcUrl});
const token='usdc.fakes.testnet',vault='nfa-2.nfagent-registry-0e9b2a.testnet';
const projectId=`${vault}/scout`,privateFile='.data/outlayer-operator-payment-key.private.json';
const sha=b=>createHash('sha256').update(b).digest('hex');
const call=(label,who,receiver,method,args,gas,deposit)=>ctx.send(label,who,receiver,[
  transactions.functionCall(method,Buffer.from(JSON.stringify(args)),gas,deposit)]);
const saved=async()=>{
  const p=JSON.parse(await readFile(privateFile,'utf8'));
  if(p.owner!==operator.id||p.projectIds?.length!==1||p.projectIds[0]!==projectId||
    p.maxPerCallMicrousd!=='100000'||sha(Buffer.from(p.encryptedSecretsBase64))!==p.ciphertextHash||
    !p.apiKey?.startsWith(`${operator.id}:${p.nonce}:`))throw Error('Private key package mismatch');
  return p;
};
const stored=nonce=>sdk.view('outlayer.testnet','get_secrets',{
  accessor:{System:'PaymentKey'},profile:String(nonce),owner:operator.id});
const balance=async nonce=>{
  const url=`https://testnet-api.outlayer.ai/public/payment-keys/${operator.id}/${nonce}/balance`;
  const response=await fetch(url,{signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw Error(`OutLayer key balance unavailable (HTTP ${response.status})`);
  return response.json();
};

const project=await sdk.getOutlayerProject('nfa-2');
if(project?.project_id!==projectId||project.state!=='READY'||
  await sdk.view('outlayer.testnet','get_payment_token_contract',{})!==token)
  throw Error('Pinned OutLayer project or payment token changed');
if(phase==='prepare'){
  try{await readFile(privateFile);throw Error('Operator Payment Key package already exists')}
  catch(error){if(error.code!=='ENOENT')throw error}
  const nonce=await sdk.view('outlayer.testnet','get_next_payment_key_nonce',{account_id:operator.id});
  if(!Number.isSafeInteger(nonce)||nonce<1)throw Error('Invalid operator Payment Key nonce');
  const secret=randomBytes(32).toString('hex');
  const secrets={key:secret,project_ids:[projectId],max_per_call:'100000',initial_balance:'0'};
  const response=await fetch('https://testnet-api.outlayer.ai/secrets/pubkey',{
    method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({accessor:{type:'System',PaymentKey:{}},owner:operator.id,
      profile:String(nonce),secrets_json:JSON.stringify(secrets)}),signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw Error(`Payment Key encryption key unavailable (HTTP ${response.status})`);
  const pubkey=(await response.json()).pubkey;
  const ciphertext=sealOutlayerPaymentKey(pubkey,secrets);
  await mkdir('.data',{recursive:true});
  await writeFile(privateFile,JSON.stringify({network:'testnet',owner:operator.id,nonce,
    projectIds:[projectId],maxPerCallMicrousd:secrets.max_per_call,
    apiKey:`${operator.id}:${nonce}:${secret}`,encryptedSecretsBase64:ciphertext,
    ciphertextHash:sha(Buffer.from(ciphertext)),createdAt:new Date().toISOString()},null,2)+'\n',
    {flag:'wx',mode:0o600});
  console.log(JSON.stringify({prepared:true,owner:operator.id,nonce,projectId,maxPerCallMicrousd:secrets.max_per_call}));
  process.exit(0);
}
const p=await saved();
if(phase==='issue'){
  const existing=await stored(p.nonce);
  if(!existing){
    const next=await sdk.view('outlayer.testnet','get_next_payment_key_nonce',{account_id:operator.id});
    if(next!==p.nonce)throw Error('Operator Payment Key nonce changed; reconcile before issuance');
    await call('issueOperatorPaymentKey',operator,'outlayer.testnet','store_secrets',
      {accessor:{System:'PaymentKey'},profile:String(p.nonce),
        encrypted_secrets_base64:p.encryptedSecretsBase64,access:'AllowAll',vault_id:null},
      80_000_000_000_000n,100_000_000_000_000_000_000_000n);
  }
  if(!(await stored(p.nonce))?.encrypted_secrets)throw Error('Encrypted operator Payment Key not visible');
  console.log(JSON.stringify({issued:true,owner:operator.id,nonce:p.nonce,projectId}));
  process.exit(0);
}
if(!(await stored(p.nonce))?.encrypted_secrets)throw Error('Issue operator Payment Key first');
if(phase==='fund'){
  const available=BigInt((await balance(p.nonce)).available||0);
  if(available<500_000n){
    const held=BigInt(await sdk.view(token,'ft_balance_of',{account_id:payer.id}));
    if(held<500_000n)throw Error('Payer needs at least 0.50 testnet USDC.e');
    await call('fundOperatorPaymentKey',payer,token,'ft_transfer_call',{
      receiver_id:'outlayer.testnet',amount:'500000',
      msg:JSON.stringify({action:'top_up_payment_key',nonce:p.nonce,owner:operator.id})},
    100_000_000_000_000n,1n);
  }
}
const current=await balance(p.nonce);
console.log(JSON.stringify({owner:operator.id,nonce:p.nonce,projectId,
  availableMicrousd:current.available,scope:'Temporary operator-owned HTTPS diagnostic; separate storage cell'}));
