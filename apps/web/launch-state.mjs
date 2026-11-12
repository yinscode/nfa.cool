export const DEFAULT_LIMITS={max_instructions:1000000000,max_memory_mb:64,max_execution_seconds:10};
export function nearAmount(value){
  if(typeof value!=='string'||!/^\d+(\.\d{1,24})?$/.test(value.trim()))throw Error('Enter a NEAR amount with at most 24 decimal places');
  const [whole,fraction='']=value.trim().split('.');return (BigInt(whole)*10n**24n+BigInt(fraction.padEnd(24,'0'))).toString();
}
export function nearDisplay(value){
  if(value==null)return 'Unavailable';const n=BigInt(value),whole=n/10n**24n,fraction=(n%10n**24n).toString().padStart(24,'0').replace(/0+$/,'');
  return `${whole}${fraction?'.'+fraction:''}`;
}
export function selectedServices(purpose){if(!['scout','compare','both'].includes(purpose))throw Error('Unknown purpose');return purpose==='both'?['scout','compare']:[purpose]}
export function policyMatches(policy,plan,schemaHash){return !!(policy?.enabled&&policy.schema_hash===schemaHash&&policy.min_margin===plan.marginYocto&&policy.max_deposit===plan.maxDepositYocto&&
  Object.keys(DEFAULT_LIMITS).every(k=>policy.limits?.[k]===DEFAULT_LIMITS[k]));}
export function nextLaunchStep(plan,request,snapshot,skills){
  if(plan.pending)return {id:'reconcile',label:'Confirm the previous wallet action',waiting:true};
  if(request?.tokenId&&!request.minted)return {id:'mint-pending',label:request.recovery?'Mint needs operator recovery':'Waiting for NFT and vault confirmation',waiting:true};
  if(!request?.minted)return {id:'mint',label:'Create NFT and persistent vault'};
  if(!snapshot)return {id:'read',label:'Read the minted agent',waiting:true};
  if(snapshot.identity.ownerAccountId!==plan.owner)return {id:'blocked',label:'Ownership changed. Setup cannot continue under the old owner.',blocked:true};
  if(snapshot.agent?.pending_op!=null||snapshot.identity.lifecycle!=='ACTIVE')return {id:'pending',label:'Waiting for the current vault operation',waiting:true};
  if(!snapshot.project)return {id:'project',label:'Create the agent’s OutLayer Project'};
  if(snapshot.project.state!=='READY')return {id:'project-pending',label:'Confirm the OutLayer Project',waiting:true};
  if(snapshot.project.version_key!==plan.release.versionKey)return {id:'blocked',label:'Runtime changed. Review it in Studio before continuing.',blocked:true};
  for(const service of plan.serviceIds){
    const skill=skills.find(s=>s.id===service);if(!skill)throw Error('Reviewed service schema unavailable');
    if(!policyMatches(snapshot.policies?.[service],plan,skill.schemaHash))return {id:'policy:'+service,service,label:`Enable ${service} pricing and limits`};
  }
  if(!snapshot.treasury||snapshot.treasury.available==null)return {id:'treasury',label:'Wait for a confirmed vault balance',waiting:true};
  if(BigInt(snapshot.treasury.available)<BigInt(plan.reserveYocto))return {id:'reserve',label:'Top up the operating reserve',amount:(BigInt(plan.reserveYocto)-BigInt(snapshot.treasury.available)).toString()};
  if(plan.chainKey&&!snapshot.identity.foreignWallet)return {id:'key',label:'Pin the Sepolia address'};
  return {id:'ready',label:'Ready to accept jobs',ready:true};
}
export function validateLaunchPlan(plan,releases){
  if(!plan||!/^[a-z0-9._-]{2,64}$/.test(plan.owner)||!Array.isArray(plan.serviceIds)||!plan.serviceIds.length||new Set(plan.serviceIds).size!==plan.serviceIds.length||plan.serviceIds.some(s=>!['scout','compare'].includes(s)))throw Error('Invalid saved launch plan');
  for(const value of [plan.marginYocto,plan.reserveYocto,plan.maxDepositYocto])if(typeof value!=='string'||!/^[1-9][0-9]*$/.test(value))throw Error('Invalid saved launch budget');
  if(BigInt(plan.marginYocto)<10n**22n||BigInt(plan.reserveYocto)<10n**22n||BigInt(plan.reserveYocto)>10n**25n||BigInt(plan.maxDepositYocto)>5n*10n**23n)throw Error('Saved launch budget exceeds reviewed limits');
  if(!releases.some(r=>r.hostedStatus==='verified'&&r.versionKey===plan.release?.versionKey&&r.url===plan.release?.url&&plan.serviceIds.every(s=>r.services.includes(s))))throw Error('Saved runtime is outside the reviewed release catalog');
}
export function walletCanceled(error){
  return ['4001','user_rejected','userrejected','user_cancelled','user_canceled','walletsignrejected'].includes(String(error?.code||'').toLowerCase())||
    /^(user|wallet user) (rejected|cancelled|canceled)( the)? (request|transaction|action|signature)/i.test(String(error?.message||''));
}
