#!/usr/bin/env node
// Read-only public RPC probe. It never creates an account or requests a signature.
const nearRpc = process.env.NEAR_RPC_URL || 'https://rpc.testnet.near.org';
const signer = process.env.NEAR_SIGNER_ACCOUNT_ID || 'v1.signer-prod.testnet';
const evmRpc = process.env.EVM_RPC_URL;
const chainId = BigInt(process.env.EVM_CHAIN_ID || '11155111');
const path = 'eth-sepolia-v1';
const vaults = process.argv.filter((a) => a.endsWith('.testnet'));
if (vaults.length === 0) vaults.push('scout.nfa-registry.testnet', 'bloom.nfa-registry.testnet');

async function rpc(url, method, params) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'nfa-probe', method, params }),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw Error(`${method}: HTTP ${response.status}`);
  const json = await response.json();
  if (json.error) throw Error(`${method}: ${JSON.stringify(json.error)}`);
  return json.result;
}

async function view(method, args) {
  const result = await rpc(nearRpc, 'query', {
    request_type: 'call_function',
    finality: 'final',
    account_id: signer,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
  });
  return JSON.parse(Buffer.from(result.result).toString());
}

async function main() {
  if (process.argv.includes('--dry-run')) {
    console.log(JSON.stringify({ nearRpc, signer, method: 'derived_public_key', path,
      args: vaults.map((predecessor) => ({ path, predecessor, domain_id: 0 })),
      evmRpc: evmRpc || null, chainId: chainId.toString(), makesTransactions: false }, null, 2));
    return;
  }
  const status = await rpc(nearRpc, 'status', []);
  if (status.chain_id !== 'testnet') throw Error(`Unexpected NEAR chain ${status.chain_id}`);
  const account = await rpc(nearRpc, 'query', {
    request_type: 'view_account', finality: 'final', account_id: signer,
  });
  console.log(JSON.stringify({ signer, nearChain: status.chain_id,
    nearBlock: status.sync_info?.latest_block_height, signerCodeHash: account.code_hash }));
  const keys = [];
  for (const predecessor of vaults) {
    const publicKey = await view('derived_public_key', { path, predecessor, domain_id: 0 });
    if (typeof publicKey !== 'string' || !publicKey.startsWith('secp256k1:'))
      throw Error(`Unexpected derived key format for ${predecessor}`);
    keys.push(publicKey);
    console.log(JSON.stringify({ predecessor, path, domain_id: 0, publicKey }));
  }
  if (new Set(vaults).size === vaults.length && new Set(keys).size !== keys.length)
    throw Error('Distinct vault predecessors derived the same public key');
  if (evmRpc) {
    const observed = BigInt(await rpc(evmRpc, 'eth_chainId', []));
    if (observed !== chainId) throw Error(`EVM chain mismatch: ${observed} vs ${chainId}`);
    console.log(JSON.stringify({ evmChainId: observed.toString() }));
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
