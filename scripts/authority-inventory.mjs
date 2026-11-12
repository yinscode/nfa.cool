#!/usr/bin/env node
// Read-only inventory of who can change an NFA's rules (review M4). No keys, no writes.
//   node scripts/authority-inventory.mjs [nfa-2 ...]
// Env: NEAR_RPC_URL (default testnet FastNEAR), NFA_REGISTRY_ID.
const rpcUrl=process.env.NEAR_RPC_URL||'https://test.rpc.fastnear.com';
const registry=process.env.NFA_REGISTRY_ID||'nfagent-registry-0e9b2a.testnet';
const tokens=process.argv.slice(2);
if(tokens.some(t=>!/^nfa-[1-9][0-9]*$/.test(t)))throw Error('Usage: node scripts/authority-inventory.mjs [nfa-N ...]');

async function query(request){
  const r=await fetch(rpcUrl,{method:'POST',headers:{'content-type':'application/json'},signal:AbortSignal.timeout(15000),
    body:JSON.stringify({jsonrpc:'2.0',id:'inventory',method:'query',params:{finality:'final',...request}})});
  const j=await r.json();if(!r.ok||j.error||j.result?.error)throw Error(JSON.stringify(j.error||j.result?.error||r.status));return j.result;
}
const view=async(account_id,method_name,args={})=>{
  try{const r=await query({request_type:'call_function',account_id,method_name,args_base64:Buffer.from(JSON.stringify(args)).toString('base64')});
    return JSON.parse(Buffer.from(r.result).toString())}catch{return undefined}
};
async function keys(account_id){
  try{const {keys}=await query({request_type:'view_access_key_list',account_id});
    return keys.map(k=>({public_key:k.public_key,permission:k.access_key.permission==='FullAccess'?'FullAccess':
      {receiver:k.access_key.permission.FunctionCall.receiver_id,methods:k.access_key.permission.FunctionCall.method_names}}))}
  catch{return null}
}
async function code(account_id){try{return (await query({request_type:'view_account',account_id})).code_hash}catch{return null}}

const authorities=await view(registry,'authorities');
const accounts={registry,...(authorities?{admin:authorities.admin,reporter:authorities.reporter,guardian:authorities.guardian}:{})};
const report={rpcUrl,registry:{account:registry,codeHash:await code(registry),keys:await keys(registry),
  authorities:authorities??'view unavailable (older registry code)'},roles:{},vaults:{},findings:[]};
for(const [role,account] of Object.entries(accounts))if(role!=='registry')report.roles[role]={account,keys:await keys(account)};
const full=list=>(list||[]).filter(k=>k.permission==='FullAccess').length;
if(full(report.registry.keys))report.findings.push(`Registry has ${full(report.registry.keys)} full-access key(s): its code and state can change with no delay. Use propose_registry_upgrade/apply_registry_upgrade and delete these keys.`);
if(!authorities)report.findings.push('Registry predates the authorities view and the upgrade timelock.');
if(report.roles.reporter&&full(report.roles.reporter.keys))report.findings.push('Reporter account holds a full-access key; give the settler a FunctionCall key limited to mark_evm_broadcast/reconcile_evm/report_evm_receipt.');
for(const token of tokens){
  const agent=await view(registry,'agent',{token_id:token});
  if(!agent){report.vaults[token]={error:'unknown token'};continue}
  const status=await view(agent.vault_id,'status'),vaultKeys=await keys(agent.vault_id);
  report.vaults[token]={vault:agent.vault_id,codeHash:await code(agent.vault_id),keys:vaultKeys,
    guardian:status?.guardian,reporter:status?.reporter,upgradeProposal:status?.upgrade_proposal??null,
    upgradeBound:status&&'upgrade_proposal' in status?'owner approval or 7-day public delay':'unbounded guardian upgrade (older vault code)'};
  if(vaultKeys?.length)report.findings.push(`${token} vault has access keys; it must have none.`);
  if(status&&!('upgrade_proposal' in status))report.findings.push(`${token} vault code lets the guardian deploy any code immediately.`);
  if(status?.upgrade_proposal)report.findings.push(`${token} has a pending vault upgrade proposal: ${status.upgrade_proposal.code_hash}.`);
}
// Older registries have no authorities view: the vault status names the reporter and guardian.
if(!authorities)for(const v of Object.values(report.vaults))for(const role of ['reporter','guardian'])
  if(v[role]&&!report.roles[role])report.roles[role]={account:v[role],keys:await keys(v[role]),source:'vault status'};
if(report.roles.reporter&&full(report.roles.reporter.keys)&&!report.findings.some(f=>f.startsWith('Reporter')))
  report.findings.push('Reporter account holds a full-access key; give the settler a FunctionCall key limited to mark_evm_broadcast/reconcile_evm/report_evm_receipt.');
console.log(JSON.stringify(report,null,2));
