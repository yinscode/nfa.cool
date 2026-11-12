export function profileLink(origin,tokenId,config){
  const url=new URL('/nfa/'+encodeURIComponent(tokenId),origin);
  url.searchParams.set('network',config.network);url.searchParams.set('registry',config.registryAccountId);
  if(config.network==='sandbox'&&config.workspace?.id)url.searchParams.set('workspace',config.workspace.id);
  return url.toString();
}
