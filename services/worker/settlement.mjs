// Trusted reporter observation policy. This does not produce a NEAR proof.
function same(a, b) { return typeof a === 'string' && a.toLowerCase() === b.toLowerCase(); }
function number(hex) { return BigInt(hex); }

export async function observeSettlement({rpcUrl, txHash, expectedSender, expectedNonce,
  minConfirmations = 3n, timeoutMs = 8000, fetchImpl = fetch}) {
  if(BigInt(minConfirmations)<3n)throw Error('At least three confirmations required');
  async function rpc(method, params) {
    const response = await fetchImpl(rpcUrl, {method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(timeoutMs)});
    if (!response.ok) throw Error(`RPC HTTP ${response.status}`);
    const json = await response.json();
    if (json.error) throw Error(`RPC ${json.error.code}: ${json.error.message}`);
    return json.result;
  }
  try {
    const chainId = await rpc('eth_chainId', []);
    if (chainId !== '0xaa36a7') return {state:'UNCERTAIN',reason:'wrong_chain'};
    const receipt = await rpc('eth_getTransactionReceipt', [txHash]);
    if (!receipt) return {state:'UNCERTAIN',reason:'missing_receipt'};
    const tx = await rpc('eth_getTransactionByHash', [txHash]);
    if (!tx || !same(receipt.transactionHash, txHash) || !same(tx.hash, txHash) ||
        !same(receipt.from, expectedSender) || !same(tx.from, expectedSender) ||
        number(tx.nonce) !== BigInt(expectedNonce) || !same(receipt.blockHash, tx.blockHash) ||
        number(tx.chainId) !== 11155111n || !['0x0','0x1'].includes(receipt.status)) {
      return {state:'UNCERTAIN',reason:'receipt_mismatch'};
    }
    const head = number(await rpc('eth_blockNumber', []));
    const block = number(receipt.blockNumber);
    if (head < block || head - block + 1n < BigInt(minConfirmations)) {
      return {state:'UNCERTAIN',reason:'insufficient_confirmations'};
    }
    const canonical=await rpc('eth_getBlockByNumber',[receipt.blockNumber,false]);
    const again=await rpc('eth_getTransactionReceipt',[txHash]);
    if(!canonical||canonical.number==null||number(canonical.number)!==block||!same(canonical.hash,receipt.blockHash)||!again||
      !same(again.blockHash,receipt.blockHash)||again.status!==receipt.status)
      return {state:'UNCERTAIN',reason:'reorg_or_changed_receipt'};
    const finalized=await rpc('eth_getBlockByNumber',['finalized',false]);
    if(!finalized||number(finalized.number)<block||number(finalized.number)===block&&!same(finalized.hash,receipt.blockHash))
      return {state:'UNCERTAIN',reason:'block_not_finalized'};
    // Independent of the receipt: the sender's finalized nonce must have moved past it.
    const count=await rpc('eth_getTransactionCount',[expectedSender,'finalized']);
    if(count==null||number(count)<=BigInt(expectedNonce))return {state:'UNCERTAIN',reason:'nonce_not_finalized'};
    return {state:'CONFIRMED',txHash,nonce:Number(expectedNonce),blockNumber:Number(block),
      success:receipt.status === '0x1', confirmations:Number(head-block+1n),finality:'trusted_rpc_finalized'};
  } catch (error) {
    return {state:'UNCERTAIN',reason:'rpc_error',detail:String(error)};
  }
}

/**
 * Settlement observed through several independent RPC providers. Every provider must report
 * the same finalized block and outcome; any disagreement or failure keeps the NFA locked.
 * One provider is accepted only when it is the only one configured (it stays fully trusted).
 */
export async function observeQuorum({rpcUrls,...request}) {
  const urls=[...new Set((Array.isArray(rpcUrls)?rpcUrls:[rpcUrls]).filter(Boolean))];
  if(!urls.length)throw Error('At least one EVM RPC URL required');
  const results=await Promise.all(urls.map(rpcUrl=>observeSettlement({...request,rpcUrl})));
  const failed=results.find(r=>r.state!=='CONFIRMED');
  if(failed)return {...failed,providers:urls.length};
  const [first]=results;
  if(results.some(r=>r.blockNumber!==first.blockNumber||r.success!==first.success))
    return {state:'UNCERTAIN',reason:'rpc_disagreement',providers:urls.length};
  return {...first,providers:urls.length,finality:urls.length>1?'rpc_quorum_finalized':first.finality};
}

export function reportArgs(observation, operationId) {
  if (observation.state !== 'CONFIRMED') throw Error('Cannot report an uncertain observation');
  return {id:operationId,tx_hash:observation.txHash,
    observed_block:observation.blockNumber,success:observation.success};
}
