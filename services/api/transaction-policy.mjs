import {keccak_256} from '@noble/hashes/sha3';
const account=s=>typeof s==='string'&&/^[a-z0-9._-]{2,64}$/.test(s);
const integer=s=>typeof s==='string'&&/^(0|[1-9][0-9]*)$/.test(s);
const positive=s=>integer(s)&&BigInt(s)>0n;
export function validateTransactionPolicy(body){
  const {nearEnabled,evmEnabled,nearRecipients,evmRecipients,maxNear,maxEvm,maxFee}=body;
  if(typeof nearEnabled!=='boolean'||typeof evmEnabled!=='boolean'||!Array.isArray(nearRecipients)||
    !Array.isArray(evmRecipients)||nearRecipients.length>20||evmRecipients.length>20||
    !nearRecipients.every(account)||!evmRecipients.every(s=>/^0x[0-9a-fA-F]{40}$/.test(s))||
    !integer(maxNear)||!integer(maxEvm)||!Number.isSafeInteger(maxFee)||maxFee<1||maxFee>100_000_000_000||
    (nearEnabled&&(!nearRecipients.length||!positive(maxNear)))||
    (evmEnabled&&(!evmRecipients.length||!positive(maxEvm)||BigInt(maxEvm)>10n**18n)))throw Error('Invalid transaction policy');
  return {near_enabled:nearEnabled,evm_enabled:evmEnabled,near_recipients:nearRecipients,
    evm_recipients:evmRecipients.map(s=>s.toLowerCase()),max_near:maxNear,max_evm:maxEvm,max_fee:maxFee};
}
function bytes(b){if(b.length===1&&b[0]<128)return b;return Buffer.concat([Buffer.from([128+b.length]),b])}
function uint(n){let hex=BigInt(n).toString(16);return bytes(BigInt(n)===0n?Buffer.alloc(0):Buffer.from(hex.padStart(hex.length+hex.length%2,'0'),'hex'))}
function list(parts){const body=Buffer.concat(parts);return Buffer.concat([body.length<=55?Buffer.from([192+body.length]):Buffer.from([248,body.length]),body])}
export function unsignedSepolia({nonce,recipient,valueWei,priorityFee,maxFee}){
  const encoded=list([uint(11155111),uint(nonce),uint(priorityFee),uint(maxFee),uint(21000),
    bytes(Buffer.from(recipient.slice(2),'hex')),uint(valueWei),bytes(Buffer.alloc(0)),list([])]);
  const tx=Buffer.concat([Buffer.from([2]),encoded]);
  return {unsigned:'0x'+tx.toString('hex'),digest:'0x'+Buffer.from(keccak_256(tx)).toString('hex'),
    nonce,chainId:11155111,gasLimit:21000};
}
export async function simulateTransaction({sdk,tokenId,body}){
  const identity=await sdk.get(tokenId),agent=await sdk.getAgentState(tokenId);
  if(identity.ownerAccountId!==body.expectedOwner||identity.ownerEpoch!==body.expectedEpoch)throw Error('Ownership changed');
  if(agent.pending_op!=null||identity.lifecycle!=='ACTIVE')throw Error('NFA has a pending operation or is not active');
  const policy=await sdk.view(sdk.registryAccountId,'transaction_policy',{token_id:tokenId});
  const treasury=await sdk.getTreasury(tokenId);
  if(body.kind==='near_transfer'){
    if(!account(body.recipient)||!positive(body.yocto)||BigInt(body.yocto)>BigInt(treasury.available))throw Error('Invalid transfer or insufficient unreserved NEAR');
    if(policy&&(!policy.near_enabled||!policy.near_recipients.includes(body.recipient)||BigInt(body.yocto)>BigInt(policy.max_near)))throw Error('NEAR transaction policy exceeded');
    return {mode:'simulation',unsignedAction:sdk.requestNearTransfer(tokenId,body.recipient,body.yocto),
      expectedEpoch:identity.ownerEpoch,availableAfter:(BigInt(treasury.available)-BigInt(body.yocto)).toString()};
  }
  if(body.kind!=='evm_transfer'||!/^0x[0-9a-fA-F]{40}$/.test(body.recipient)||!positive(body.valueWei)||
    BigInt(body.valueWei)>10n**18n||!Number.isSafeInteger(body.priorityFee)||!Number.isSafeInteger(body.maxFee)||
    body.priorityFee<1||body.priorityFee>body.maxFee||body.maxFee>100_000_000_000)throw Error('Invalid Sepolia transfer');
  if(!identity.foreignWallet)throw Error('Pin Sepolia identity first');
  if(policy&&(!policy.evm_enabled||!policy.evm_recipients.includes(body.recipient.toLowerCase())||
    BigInt(body.valueWei)>BigInt(policy.max_evm)||body.maxFee>policy.max_fee))throw Error('EVM transaction policy exceeded');
  const status=await sdk.view(identity.vaultAccountId,'status');
  if(status.pending||status.chain_id!==11155111||status.path!=='eth-sepolia-v1'||!Number.isSafeInteger(status.next_evm_nonce))throw Error('Vault signing state mismatch');
  return {mode:'simulation',...unsignedSepolia({...body,nonce:status.next_evm_nonce}),
    unsignedAction:sdk.requestEvmTransfer(tokenId,body.recipient,body.valueWei,body.priorityFee,body.maxFee),
    expectedEpoch:identity.ownerEpoch,notice:'The reporter must confirm the Sepolia receipt before the NFA unlocks.'};
}
