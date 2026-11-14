#!/usr/bin/env node
// Start the registry's public two-day code-upgrade delay for the pinned Payment Key build.
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {transactions,utils} from 'near-api-js';
import {NfaSdk} from '@nfa/sdk';
import {testnet} from './testnet-lib.mjs';

const sha=b=>createHash('sha256').update(b).digest('hex');
const oldHash='b733b54b7ea955c6f95042f3ecbe27ad2391dbaa83409416d2dc9cdc790295b4';
const registryHash='5a6f3f0b37c0a2178c65ba48018366da62f220b22881a02eac07ad8470f71fbb';
const vaultHash='5a37a47242d4d38994c7849d11a227146e2816a1e09420336892c12c7a5050ce';
const supersededHash='2b810795615c59c32c958675df32ee23a3af1f7dbbca2f6143ace16c2015b596';
if(sha(await readFile('releases/nfa-registry-payment-key-5a6f3f0b37c0a217.wasm'))!==registryHash||
  sha(await readFile('releases/nfa-vault-payment-key-5a37a47242d4d389.wasm'))!==vaultHash)
  throw Error('Pinned upgrade artifacts changed');
const ctx=await testnet('deployments/payment-key-upgrade.json');
const operator=await ctx.signer('t004-operator'),registryId='nfagent-registry-0e9b2a.testnet';
const sdk=new NfaSdk({registryAccountId:registryId,rpcUrl:ctx.rpcUrl});
const account=await ctx.account(registryId);
const deployed=Buffer.from(utils.serialize.base_decode(account.code_hash)).toString('hex');
if(deployed!==oldHash)throw Error(`Unexpected deployed registry code: ${deployed}`);
const authorities=await sdk.view(registryId,'authorities');
if(authorities.admin!==operator.id||authorities.registry_upgrade&&
  ![registryHash,supersededHash].includes(authorities.registry_upgrade.code_hash))
  throw Error('Admin or existing upgrade proposal changed');
const agent=await sdk.getAgentState('nfa-2'),identity=await sdk.get('nfa-2');
if(agent.pending_op!=null||identity.vaultAccountId!=='nfa-2.nfagent-registry-0e9b2a.testnet')
  throw Error('Research NFA is busy or changed');
const vaultAccount=await ctx.account(identity.vaultAccountId);
if(Buffer.from(utils.serialize.base_decode(vaultAccount.code_hash)).toString('hex')!==
  '200821c58802e52ac795fbd1a594a66d6f6de8703862019972b9ee93bc33c6e7')
  throw Error('Vault predecessor changed');
if(authorities.registry_upgrade?.code_hash===supersededHash){
  await ctx.send('cancelSupersededPaymentKeyProposal',operator,registryId,[transactions.functionCall(
    'cancel_registry_upgrade',Buffer.from('{}'),30_000_000_000_000n,0n)]);
}
if((await sdk.view(registryId,'authorities')).registry_upgrade?.code_hash!==registryHash){
  await ctx.send('proposePaymentKeyRegistryUpgradeV2',operator,registryId,[transactions.functionCall(
    'propose_registry_upgrade',Buffer.from(JSON.stringify({code_hash:registryHash})),30_000_000_000_000n,0n)]);
}
const proposal=(await sdk.view(registryId,'authorities')).registry_upgrade;
if(proposal?.code_hash!==registryHash)throw Error('Upgrade proposal was not observed');
const result={network:'NEAR testnet',registry:registryId,oldRegistryHash:oldHash,proposedRegistryHash:registryHash,
  proposedVaultHash:vaultHash,proposal,eligibleAfterNs:(BigInt(proposal.proposed_at_ns)+172_800_000_000_000n).toString(),
  identity:{tokenId:'nfa-2',owner:identity.ownerAccountId,epoch:identity.ownerEpoch,vault:identity.vaultAccountId},
  proposalTransaction:ctx.evidence.steps.proposePaymentKeyRegistryUpgradeV2?.hash,
  scope:'Proposal only. No code deployed, Payment Key issued or USDC.e funded.'};
await writeFile('docs/evidence/payment-key-upgrade-proposal.json',JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({registry:registryId,proposedRegistryHash:registryHash,
  eligibleAfterNs:result.eligibleAfterNs,proposalTransaction:result.proposalTransaction,scope:result.scope}));
