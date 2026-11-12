/** Map an SDK action to the Wallet Selector action wire format. */
export function walletCallbackUrl(location){
  const url=new URL(location.origin+location.pathname+location.search);
  for(const name of ['transactionHashes','errorCode','errorMessage'])url.searchParams.delete(name);
  return url.toString();
}
export function toWalletSelectorActions(action){
  if(!action||typeof action.receiverId!=='string'||!action.receiverId||
      !/^(0|[1-9]\d*)$/.test(action.deposit))throw Error('Invalid wallet action');
  if(!action.methodName)return [{type:'Transfer',params:{deposit:action.deposit}}];
  if(typeof action.methodName!=='string'||!/^[a-z][a-z0-9_]*$/.test(action.methodName)||
      !/^[1-9]\d*$/.test(action.gas))throw Error('Invalid function call');
  return [{type:'FunctionCall',params:{methodName:action.methodName,
    args:action.args||{},gas:action.gas,deposit:action.deposit}}];
}
