#!/usr/bin/env node
// One capped testnet USDC.e top-up after key issuance. Never auto-swaps another token.
import {transactions} from 'near-api-js';
import {NfaSdk} from '@nfa/sdk';
import {testnet} from './testnet-lib.mjs';

const registry='nfagent-registry-0e9b2a.testnet',tokenId='nfa-2';
const vault=`${tokenId}.${registry}`,amount='500000'; // $0.50, six decimals.
const ctx=await testnet('deployments/payment-key-upgrade.json'),funder=await ctx.signer('studio-funder');
const sdk=new NfaSdk({registryAccountId:registry,rpcUrl:ctx.rpcUrl});
const [setup,identity,token]=await Promise.all([
  sdk.view(registry,'payment_key_setup',{token_id:tokenId}),sdk.get(tokenId),
  sdk.view('outlayer.testnet','get_payment_token_contract',{})]);
if(setup?.state!=='READY'||identity.vaultAccountId!==vault||token!=='usdc.fakes.testnet')
  throw Error('Issued key, vault or OutLayer payment token changed');
const metadata=await sdk.view(token,'ft_metadata',{});
if(metadata.decimals!==6)throw Error('Unexpected token precision');
const balance=BigInt(await sdk.view(token,'ft_balance_of',{account_id:funder.id}));
if(balance<BigInt(amount))throw Error(`Funder needs at least $0.50 of ${token}; no transfer submitted`);
const msg=JSON.stringify({action:'top_up_payment_key',nonce:setup.nonce,owner:vault});
await ctx.send('fundVaultPaymentKeyUsdcE',funder,token,[transactions.functionCall('ft_transfer_call',
  Buffer.from(JSON.stringify({receiver_id:'outlayer.testnet',amount,msg})),100_000_000_000_000n,1n)]);
const url=`https://testnet-api.outlayer.ai/public/payment-keys/${vault}/${setup.nonce}/balance`;
const response=await fetch(url,{signal:AbortSignal.timeout(15000)});
if(!response.ok)throw Error(`OutLayer key balance unavailable (HTTP ${response.status}); inspect top-up receipt`);
const observed=await response.json();
console.log(JSON.stringify({token,owner:vault,nonce:setup.nonce,transferredMicrousd:amount,
  availableMicrousd:observed.available,transaction:ctx.evidence.steps.fundVaultPaymentKeyUsdcE.hash}));
