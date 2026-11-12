import {assembleEvmTransfer} from './assemble-evm.mjs';
import {submitAndObserve} from './evm-journal.mjs';
import {observeSettlement,reportArgs} from './settlement.mjs';

/**
 * Only the configured reporter can complete these typed zero-deposit actions.
 * A same-nonce replacement leaves several signed candidates; whichever one is
 * finalized consumed the nonce, so all of them are journaled and observed.
 */
export async function settleEvmTick({sdk,journal,wallet,reporterId,tokenId,rpcUrl,fetchImpl=fetch,assemble=assembleEvmTransfer,rpcTimeoutMs=8000}){
  const identity=await sdk.get(tokenId),agent=await sdk.getAgentState(tokenId),id=agent.pending_op;
  if(id==null)return {state:'IDLE'};
  const [op,evm,vault]=await Promise.all([
    sdk.view(sdk.registryAccountId,'operation',{token_id:tokenId,id}),
    sdk.view(sdk.registryAccountId,'evm_operation',{token_id:tokenId,id}),
    sdk.view(identity.vaultAccountId,'status')]);
  if(op?.kind!=='EVM_TRANSFER'||!['Submitted','Uncertain'].includes(op.status))return {state:'WAITING',reason:'not_signed_evm_operation'};
  if(vault.controller!==sdk.registryAccountId||vault.reporter!==reporterId||vault.chain_id!==11155111||vault.path!=='eth-sepolia-v1')
    throw Error('Vault controller/reporter/chain mismatch');
  const pinned=identity.foreignWallet;
  if(!pinned||pinned.chain_id!==11155111||pinned.path!==vault.path)throw Error('Pinned Sepolia wallet required');
  const optional=async(account,method,args)=>{try{return await sdk.view(account,method,args)??[]}catch{return []}};
  const pending=vault.pending?.Evm??null;
  // Retained candidates carry only digest/unsigned/signature; the vault pending carries
  // its own id and nonce, which the assembler checks against the registry operation.
  const signedAt=candidate=>assemble({pending:{Evm:{id,nonce:evm.nonce,...candidate,uncertain:false}},
    derivedPublicKey:pinned.public_key,expectedAddress:pinned.address,expectedId:id,expectedNonce:evm.nonce});
  if(pending){
    // Earlier candidates are durable before any broadcast of the current one.
    const earlier=await optional(identity.vaultAccountId,'evm_candidates',{nonce:evm.nonce});
    for(const [attempt,candidate] of earlier.entries())await journal.saveSigned(tokenId,id,signedAt(candidate),attempt);
    if(pending.signature&&!pending.uncertain){
      const attempt=earlier.length,signed=signedAt(pending);
      await submitAndObserve({journal,tokenId,id,signed,attempt,rpcUrl,fetchImpl,timeoutMs:rpcTimeoutMs});
    }
  }
  const records=await journal.list(tokenId,id);
  if(!records.length){
    if(pending&&(!pending.signature||pending.uncertain))
      return {state:'UNCERTAIN',reason:'mpc_signature_unresolved',recovery:pending.uncertain?'retry_evm_signature':'await_signer'};
    throw Error('Missing or mismatched durable EVM journal; recovery required');
  }
  let landed=null;
  for(const record of records){
    if(record.sender.toLowerCase()!==pinned.address.toLowerCase()||record.nonce!==evm.nonce)
      throw Error('Missing or mismatched durable EVM journal; recovery required');
    // Reobserve even a previously confirmed journal before making any authority change.
    const observed=await observeSettlement({rpcUrl,txHash:record.hash,expectedSender:record.sender,
      expectedNonce:record.nonce,fetchImpl,timeoutMs:rpcTimeoutMs});
    if(observed.state==='CONFIRMED'){landed={record,observed};break}
  }
  if(!landed)return {state:'UNCERTAIN',reason:pending?.uncertain?'mpc_signature_unresolved':'not_finalized',
    hashes:records.map(r=>r.hash),...(pending?.uncertain?{recovery:'retry_evm_signature'}:{})};
  const {record,observed}=landed,attempt=record.attempt??0;
  const send=(stage,receiverId,methodName,args)=>wallet.send(`${tokenId}-${id}-${stage}`,
    {receiverId,methodName,args,gas:'100000000000000',deposit:'0'});
  const recorded=[...await optional(sdk.registryAccountId,'evm_broadcasts',{token_id:tokenId,id}),{tx_hash:evm.tx_hash}]
    .some(row=>row?.tx_hash?.toLowerCase()===record.hash.toLowerCase());
  if(!recorded)return {stage:'mark',...await send(attempt===0?'mark':`mark-r${attempt}`,sdk.registryAccountId,'mark_evm_broadcast',
    {token_id:tokenId,id,tx_hash:record.hash,attempt})};
  if(vault.pending?.Evm)return {stage:'report',...await send('report',identity.vaultAccountId,'report_evm_receipt',reportArgs(observed,id))};
  const receipt=vault.last_receipt;
  if(vault.pending!=null||!Array.isArray(receipt)||receipt[0]!==record.nonce||receipt[1]!==record.hash||
    receipt[2]!==observed.blockNumber||receipt[3]!==observed.success)throw Error('Vault receipt differs from current observation');
  return {stage:'reconcile',...await send('reconcile',sdk.registryAccountId,'reconcile_evm',{token_id:tokenId,id})};
}

export async function sepoliaHoldings({address,rpcUrl,fetchImpl=fetch}){
  if(!/^0x[0-9a-fA-F]{40}$/.test(address))throw Error('Invalid EVM address');
  const rpc=async(method,params)=>{
    const response=await fetchImpl(rpcUrl,{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(8000)});
    const json=await response.json();if(!response.ok||json.error)throw Error('EVM RPC unavailable');return json.result;
  };
  try{
    if(await rpc('eth_chainId',[])!=='0xaa36a7')throw Error('Wrong chain');
    const block=await rpc('eth_blockNumber',[]),balance=await rpc('eth_getBalance',[address,block]);
    return {chainId:11155111,address,balanceWei:BigInt(balance).toString(),observedBlock:BigInt(block).toString(),
      observedAt:new Date().toISOString(),freshness:'rpc_observation',authority:'trusted_rpc_not_a_proof'};
  }catch{return {chainId:11155111,address,balanceWei:null,freshness:'unavailable'}}
}
