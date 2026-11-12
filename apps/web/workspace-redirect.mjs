const loopback=host=>['localhost','127.0.0.1','[::1]'].includes(host);
/** Migrate a legacy collection view, never a pending wallet action or NFT ID. */
export function legacyWorkspaceRedirect({href,config,target,account,pending=false}){
  const source=new URL(href);
  if(!loopback(source.hostname)||source.protocol!=='http:'||!['/','/studio'].includes(source.pathname)||
    config?.network!=='sandbox'||config.registryAccountId!=='registry.test.near'||
    config.serverVersion>=3||config.workspace?.persistent||pending||source.hash)return null;
  for(const name of ['transactionHashes','errorCode','errorMessage','state','signature','publicKey'])
    if(source.searchParams.has(name))return null;
  let destination;try{destination=new URL(target)}catch{return null}
  if(destination.protocol!=='http:'||!loopback(destination.hostname)||destination.username||destination.password)return null;
  // Keep localhost/127.0.0.1 consistent with the user's bookmark and cookie context.
  destination.hostname=source.hostname;destination.pathname='/studio';destination.search='';destination.hash='';
  if(destination.origin===source.origin)return null;
  destination.searchParams.set('network','sandbox');
  if(['alice.test.near','bob.test.near','customer.test.near'].includes(account))destination.searchParams.set('localAccount',account);
  return destination.toString();
}
