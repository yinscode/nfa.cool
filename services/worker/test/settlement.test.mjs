import test from 'node:test';
import assert from 'node:assert/strict';
import {observeSettlement, observeQuorum, reportArgs} from '../settlement.mjs';

const hash = '0x'+'a'.repeat(64), sender='0x'+'b'.repeat(40), block='0x'+'c'.repeat(64);
const results = {eth_chainId:'0xaa36a7',eth_getTransactionReceipt:{transactionHash:hash,from:sender,
  blockHash:block,blockNumber:'0x64',status:'0x1'},eth_getTransactionByHash:{hash,from:sender,
  blockHash:block,nonce:'0x0',chainId:'0xaa36a7'},eth_blockNumber:'0x66',eth_getBlockByNumber:{hash:block,number:'0x64'},
  eth_getTransactionCount:'0x1'};
function fakeFetch(overrides={}) {
  return async (_url, opts) => ({ok:true,json:async () => {
    const request=JSON.parse(opts.body),value={...results,...overrides}[request.method];
    return {result:typeof value==='function'?value(request.params):value};
  }});
}
const request = {rpcUrl:'https://example.invalid',txHash:hash,expectedSender:sender,expectedNonce:0,
  minConfirmations:3n};

test('confirmed receipt creates exact reporter args', async () => {
  const result=await observeSettlement({...request,fetchImpl:fakeFetch()});
  assert.equal(result.state,'CONFIRMED');
  assert.deepEqual(reportArgs(result,1),{id:1,tx_hash:hash,observed_block:100,success:true});
});
test('RPC timeout stays uncertain and cannot release an operation', async () => {
  const result=await observeSettlement({...request,fetchImpl:async()=>{throw Error('timeout')}});
  assert.equal(result.state,'UNCERTAIN');
  assert.throws(()=>reportArgs(result,1),/Cannot report/);
});
test('missing receipt and insufficient confirmations remain uncertain', async () => {
  assert.equal((await observeSettlement({...request,fetchImpl:fakeFetch({eth_getTransactionReceipt:null})})).reason,'missing_receipt');
  assert.equal((await observeSettlement({...request,minConfirmations:4n,fetchImpl:fakeFetch()})).reason,'insufficient_confirmations');
});
test('forged sender or nonce cannot produce a report', async () => {
  const tx={...results.eth_getTransactionByHash,nonce:'0x1'};
  assert.equal((await observeSettlement({...request,fetchImpl:fakeFetch({eth_getTransactionByHash:tx})})).reason,'receipt_mismatch');
  const receipt={...results.eth_getTransactionReceipt,from:'0x'+'d'.repeat(40)};
  assert.equal((await observeSettlement({...request,fetchImpl:fakeFetch({eth_getTransactionReceipt:receipt})})).reason,'receipt_mismatch');
});
test('mined reverted transaction consumes nonce', async () => {
  const receipt={...results.eth_getTransactionReceipt,status:'0x0'};
  const result=await observeSettlement({...request,fetchImpl:fakeFetch({eth_getTransactionReceipt:receipt})});
  assert.equal(result.state,'CONFIRMED'); assert.equal(result.success,false);
});
test('reorganized and unfinalized blocks cannot release the sale lock',async()=>{
  const result=await observeSettlement({...request,fetchImpl:fakeFetch({eth_getBlockByNumber:{hash:'0x'+'d'.repeat(64)}})});
  assert.equal(result.reason,'reorg_or_changed_receipt');
  const pending=await observeSettlement({...request,fetchImpl:fakeFetch({eth_getBlockByNumber:params=>
    params[0]==='finalized'?{hash:'0x'+'d'.repeat(64),number:'0x63'}:{hash:block,number:'0x64'}})});
  assert.equal(pending.reason,'block_not_finalized');
});

test('finalized sender nonce must have advanced past the transaction', async () => {
  const result=await observeSettlement({...request,fetchImpl:fakeFetch({eth_getTransactionCount:'0x0'})});
  assert.equal(result.reason,'nonce_not_finalized');
});
test('several RPC providers must agree before a lock is released', async () => {
  const per=url=>url.includes('b')?fakeFetch({eth_getTransactionReceipt:{...results.eth_getTransactionReceipt,status:'0x0'}}):fakeFetch();
  const fetchImpl=(url,opts)=>per(url)(url,opts);
  const agreed=await observeQuorum({...request,rpcUrls:['https://a.invalid','https://c.invalid'],fetchImpl});
  assert.equal(agreed.state,'CONFIRMED');assert.equal(agreed.providers,2);assert.equal(agreed.finality,'rpc_quorum_finalized');
  const split=await observeQuorum({...request,rpcUrls:['https://a.invalid','https://b.invalid'],fetchImpl});
  assert.equal(split.reason,'rpc_disagreement');
  const down=await observeQuorum({...request,rpcUrls:['https://a.invalid','https://down.invalid'],
    fetchImpl:(url,opts)=>url.includes('down')?Promise.reject(Error('timeout')):fakeFetch()(url,opts)});
  assert.equal(down.state,'UNCERTAIN');
});
