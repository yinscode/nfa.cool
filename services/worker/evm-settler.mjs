import {assembleEvmTransfer} from './assemble-evm.mjs';
import {submitAndObserve} from './evm-journal.mjs';
import {observeSettlement,reportArgs} from './settlement.mjs';

/** Only the configured reporter can complete these typed zero-deposit actions. */
export async function settleEvmTick({sdk,journal,wallet,reporterId,tokenId,rpcUrl,fetchImpl=fetch,assemble=assembleEvmTransfer}){
  const identity=await sdk.get(tokenId),agent=await sdk.getAgentState(tokenId),id=agent.pending_op;
  if(id==null)return {state:'IDLE'};
  const [op,evm,vault]=await Promise.all([
    sdk.view(sdk.registryAccountId,'operation',{token_id:tokenId,id}),
    sdk.view(sdk.registryAccountId,'evm_operation',{token_id:tokenId,id}),
    sdk.view(identity.vaultAccountId,'status')]);
  if(op?.kind!=='EVM_TRANSFER'||op.status!=='Submitted')return {state:'WAITING',reason:'not_signed_evm_operation'};
  if(vault.controller!==sdk.registryAccountId||vault.reporter!==reporterId||vault.chain_id!==11155111||vault.path!=='eth-sepolia-v1')
    throw Error('Vault controller/reporter/chain mismatch');
  const pinned=identity.foreignWallet;
  if(!pinned||pinned.chain_id!==11155111||pinned.path!==vault.path)throw Error('Pinned Sepolia wallet required');
  let record=await journal.get(tokenId,id);
  if(vault.pending?.Evm){
    const pending=vault.pending.Evm;
    if(!pending.signature||pending.uncertain)return {state:'UNCERTAIN',reason:'mpc_signature_unresolved'};
    const signed=assemble({pending:vault.pending,derivedPublicKey:pinned.public_key,
      expectedAddress:pinned.address,expectedId:id,expectedNonce:evm.nonce});
    record=await journal.saveSigned(tokenId,id,signed);
    const sent=await submitAndObserve({journal,tokenId,id,signed,rpcUrl,fetchImpl});
    if(sent.state!=='CONFIRMED')return {state:'UNCERTAIN',reason:sent.reason,hash:record.hash};
  }
  if(!record||record.sender.toLowerCase()!==pinned.address.toLowerCase()||record.nonce!==evm.nonce)
    throw Error('Missing or mismatched durable EVM journal; recovery required');
  // Reobserve even a previously confirmed journal before making any authority change.
  const observed=await observeSettlement({rpcUrl,txHash:record.hash,expectedSender:record.sender,
    expectedNonce:record.nonce,fetchImpl});
  if(observed.state!=='CONFIRMED')return {state:'UNCERTAIN',reason:observed.reason,hash:record.hash};
  const send=(stage,receiverId,methodName,args)=>wallet.send(`${tokenId}-${id}-${stage}`,
    {receiverId,methodName,args,gas:'100000000000000',deposit:'0'});
  if(!evm.tx_hash)return {stage:'mark',...await send('mark',sdk.registryAccountId,'mark_evm_broadcast',{token_id:tokenId,id,tx_hash:record.hash})};
  if(evm.tx_hash.toLowerCase()!==record.hash.toLowerCase())throw Error('Registry broadcast hash differs');
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
