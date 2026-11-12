const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
export async function inspectLaunchAction({sdk,hash,sender,action}){
  const allowed=['create_agent','provision_outlayer','configure_service','derive_wallet'];
  if(!action||action.methodName&&!allowed.includes(action.methodName))throw Error('Not a launch action');
  const tx=await sdk.transaction(hash,sender),actual=tx.transaction;
  if(actual?.hash!==hash||actual.signer_id!==sender||actual.receiver_id!==action.receiverId||actual.actions?.length!==1)throw Error('Launch receipt identity mismatch');
  if(action.methodName){
    if(action.receiverId!==sdk.registryAccountId)throw Error('Launch registry mismatch');
    const call=actual.actions[0].FunctionCall;
    if(!call||call.method_name!==action.methodName||String(call.deposit)!==action.deposit||String(call.gas)!==action.gas)throw Error('Launch action changed');
    const args=JSON.parse(Buffer.from(call.args,'base64').toString());
    if(JSON.stringify(canonical(args))!==JSON.stringify(canonical(action.args)))throw Error('Launch arguments changed');
  }else{
    if(!/^nfa-[1-9][0-9]*\./.test(action.receiverId)||!action.receiverId.endsWith('.'+sdk.registryAccountId)||String(actual.actions[0].Transfer?.deposit)!==action.deposit)throw Error('Vault funding receipt mismatch');
  }
  return {hash,status:tx.final_execution_status!=='FINAL'?'PENDING':tx.status?.Failure?'FAILED':Object.hasOwn(tx.status||{},'SuccessValue')?'SUCCEEDED':'PENDING'};
}
