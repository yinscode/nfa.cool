/** Coalesce repeated finalized views only within one read-only page snapshot. */
export function snapshotSdk(sdk){
  const cache=new Map(),reader=Object.create(sdk);
  reader.view=(account,method,args={})=>{
    const key=JSON.stringify([account,method,args]);
    if(!cache.has(key))cache.set(key,Promise.resolve().then(()=>sdk.view(account,method,args)));
    return cache.get(key);
  };
  return reader;
}
