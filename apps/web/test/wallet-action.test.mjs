import test from 'node:test';
import assert from 'node:assert/strict';
import {toWalletSelectorActions,walletCallbackUrl} from '../wallet-action.mjs';
import {NfaSdk} from '@nfa/sdk';

test('SDK purchase and vault funding map to wallet actions without changing price or receiver',()=>{
  const sdk=new NfaSdk({registryAccountId:'registry.testnet',rpcUrl:'https://rpc.invalid'});
  const purchase=sdk.buy('nfa-1',3,'1000000000000000000000000');
  assert.deepEqual(toWalletSelectorActions(purchase),[{type:'FunctionCall',params:{
    methodName:'buy',args:{token_id:'nfa-1',expected_nonce:3},gas:purchase.gas,deposit:purchase.deposit}}]);
  assert.deepEqual(toWalletSelectorActions(sdk.fund('nfa-1.registry.testnet','100')),
    [{type:'Transfer',params:{deposit:'100'}}]);
  assert.throws(()=>toWalletSelectorActions({...purchase,deposit:'-1'}),/Invalid wallet action/);
});
test('wallet redirects preserve the selected NFA and drop a previous receipt or error',()=>{
  assert.equal(walletCallbackUrl({origin:'https://nfa.example',pathname:'/studio',search:'?token=nfa-2&transactionHashes=old&errorCode=cancelled'}),
    'https://nfa.example/studio?token=nfa-2');
});
