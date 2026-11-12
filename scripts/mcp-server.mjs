#!/usr/bin/env node
// Model Context Protocol server for NFA.gent (stdio, JSON-RPC 2.0, no dependencies).
// Read tools work against any NFA API; nfa_sandbox_* tools only run against a local sandbox
// Studio, where they sign with the sandbox's own test accounts. No real key is ever used.
//   NFA_API_URL=http://127.0.0.1:3102 node scripts/mcp-server.mjs
import {createHash,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';

const root=join(dirname(fileURLToPath(import.meta.url)),'..');
const API=(process.env.NFA_API_URL||'http://127.0.0.1:3102').replace(/\/$/,'');
const TOKEN=/^nfa-[1-9][0-9]*$/,SERVICE=['scout','compare','research'];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function api(path,body,headers={}){
  const response=await fetch(API+path,{method:body===undefined?'GET':'POST',signal:AbortSignal.timeout(60_000),
    headers:body===undefined?headers:{'content-type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});
  const text=await response.text();let value;try{value=JSON.parse(text)}catch{value={text}}
  if(!response.ok)throw Error(value.error||`NFA API ${response.status} on ${path}`);
  return value;
}
const token=id=>{if(!TOKEN.test(id||''))throw Error('tokenId must look like nfa-1');return id};
const service=s=>{if(!SERVICE.includes(s))throw Error('service must be scout, compare or research');return s};
const pick=(snapshot)=>({identity:snapshot.identity,lifecycle:snapshot.agent?.lifecycle,pendingOperation:snapshot.agent?.pending_op,
  treasury:snapshot.treasury,project:snapshot.project,services:snapshot.availability,economics:snapshot.economics,
  inventory:snapshot.inventory,recovery:snapshot.recovery,runtimeGate:snapshot.runtimeGate});

// ---- sandbox helpers (refuse anything that is not the local sandbox) ----
async function sandbox(){
  const config=await api('/config');
  if(config.network!=='sandbox'||!config.localSandbox)throw Error('nfa_sandbox_* tools need a local sandbox Studio (npm run studio:start)');
  const [owner,buyer,customer]=config.localSandbox.accounts;return {config,owner,buyer,customer};
}
async function send(accountId,action){
  const outcome=await api('/dev/wallet/transaction',{accountId,action},{'x-nfa-local-wallet':'1'});
  const failure=outcome?.status?.Failure;
  return {hash:outcome?.transaction?.hash||outcome?.transaction_outcome?.id,failed:!!failure,failure:failure||null,
    value:outcome?.status?.SuccessValue?JSON.parse(Buffer.from(outcome.status.SuccessValue,'base64').toString()||'null'):null};
}
const prepared=async body=>(await api('/prepare',body)).unsignedAction;
async function until(work,ok,tries=60){let v;for(let i=0;i<tries;i++){v=await work();if(ok(v))return v;await sleep(500)}return v}

async function bootstrap(){
  const {owner}=await sandbox();
  const requestId='mcp-'+randomUUID().slice(0,8);
  const manifestHash='sha256:'+createHash('sha256').update(requestId).digest('hex');
  const created=await send(owner,await prepared({kind:'create',requestId,manifestHash,manifestUri:`nfa://manifest/${requestId}`}));
  if(created.failed)throw Error('create_agent failed: '+JSON.stringify(created.failure));
  const tokenId=created.value||(await until(async()=>(await api(`/studio/owned?owner=${owner}`)).items,items=>items.length>0)).at(-1).tokenId;
  const release=(await api('/studio/releases')).releases.find(r=>r.url&&r.services?.includes('scout'));
  const provisioned=await send(owner,await prepared({kind:'outlayer_provision',tokenId,wasmUrl:release.url,versionKey:release.versionKey,deposit:'100000000000000000000000'}));
  if(provisioned.failed)throw Error('provision_outlayer failed');
  const skill=(await api('/studio/skills')).items.find(s=>s.id==='scout');
  const policy=await send(owner,await prepared({kind:'service_policy',tokenId,serviceId:'scout',schemaHash:skill.schemaHash,enabled:true,
    margin:'10000000000000000000000',maxDeposit:'500000000000000000000000',limits:{max_instructions:1_000_000_000,max_memory_mb:64,max_execution_seconds:10}}));
  if(policy.failed)throw Error('configure_service failed');
  // Views read final state, which trails execution by a block or two.
  const services=(await until(()=>api(`/v1/nfas/${tokenId}/services`),s=>s.items?.some(i=>i.id==='scout'&&i.available))).items;
  return {tokenId,owner,vault:(await api(`/studio/nfas/${tokenId}`)).identity.vaultAccountId,services:services.map(({id,available,reason})=>({id,available,reason})),
    transactions:{create:created.hash,provision:provisioned.hash,policy:policy.hash}};
}
async function hire({tokenId,question,sources}){
  const {customer}=await sandbox();token(tokenId);
  const quote=await api(`/v1/nfas/${tokenId}/services/scout/quotes`,{input:{question,sources}});
  const paid=await send(customer,quote.unsignedAction);
  if(paid.failed)throw Error('payment failed: '+JSON.stringify(paid.failure));
  const receipt=await api('/studio/transactions/inspect',{tokenId,hash:paid.hash,sender:customer});
  const jobId=receipt.assignedJobId;if(!jobId)throw Error('payment has no assigned job yet; inspect '+paid.hash);
  const start=await api(`/v1/nfas/${tokenId}/services/scout/jobs/${jobId}/prepare-start`,{inputData:quote.inputData});
  const started=await send(customer,start.unsignedAction);
  const job=await until(()=>api(`/v1/nfas/${tokenId}/services/scout/jobs/${jobId}`),r=>['FINALIZED','FAILED','UNCERTAIN'].includes(r.job?.status));
  return {tokenId,jobId,customer,feeYocto:quote.feeYocto,status:job.job?.status,outputHash:job.job?.output_hash||null,
    transactions:{payment:paid.hash,start:started.hash},record:job};
}
async function sell({tokenId,priceYocto='1000000000000000000000000'}){
  const {owner,buyer}=await sandbox();token(tokenId);
  const before=(await api(`/studio/nfas/${tokenId}`)).identity;
  const seller=before.ownerAccountId;if(![owner,buyer].includes(seller))throw Error('NFA is not owned by a sandbox account');
  const purchaser=seller===owner?buyer:owner;
  // Reuse an existing listing (for example after an interrupted call); otherwise list now.
  const listed=before.listing?{hash:null,reused:true}:await send(seller,await prepared({kind:'list',tokenId,price:priceYocto,
    expiresAtNs:Number((BigInt(Date.now())+3_600_000n)*1_000_000n)}));
  if(listed.failed)throw Error('listing refused (is an operation pending?): '+JSON.stringify(listed.failure));
  const listing=(await until(()=>api(`/studio/nfas/${tokenId}`),s=>s.identity?.listing)).identity.listing;
  if(!listing)throw Error('Listing not visible yet; retry');
  const bought=await send(purchaser,await prepared({kind:'buy',tokenId,nonce:listing.nonce,price:listing.price}));
  if(bought.failed)throw Error('purchase failed');
  const after=(await until(()=>api(`/studio/nfas/${tokenId}`),s=>s.identity?.ownerAccountId===purchaser)).identity;
  // The former owner must now be refused an owner-only action.
  const denied=await send(seller,await prepared({kind:'claim',tokenId,yocto:'1'}));
  return {tokenId,seller,buyer:purchaser,ownerAfter:after.ownerAccountId,epochBefore:before.ownerEpoch,epochAfter:after.ownerEpoch,
    sameVault:after.vaultAccountId===before.vaultAccountId,vault:after.vaultAccountId,formerOwnerDenied:denied.failed,
    transactions:{list:listed.hash,buy:bought.hash,formerOwnerAttempt:denied.hash}};
}

const object=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false});
const tokenArg={tokenId:{type:'string',description:'NFA token id, for example nfa-1'}};
const tools=[
  {name:'nfa_overview',description:'What NFA.gent is, which network this API serves, and the claims ledger summary. Start here.',inputSchema:object({}),
    run:async()=>{const claims=JSON.parse(await readFile(join(root,'docs/CLAIMS.json'),'utf8'));
      return {about:'An NFT that controls a persistent agent account (vault, Sepolia identity, paid services, memory). Selling the NFT hands over the working agent.',
        api:API,config:await api('/config'),claims:claims.claims.map(c=>({id:c.id,status:c.status,level:c.level,statement:c.statement}))}}},
  {name:'nfa_claims',description:'Full machine-readable claims with evidence files, explorer links and how each is verified.',
    inputSchema:object({status:{type:'string',enum:['verified','disclosed','open','not-claimed']}}),
    run:async({status})=>{const c=JSON.parse(await readFile(join(root,'docs/CLAIMS.json'),'utf8'));return status?c.claims.filter(x=>x.status===status):c}},
  {name:'nfa_profile',description:'Owner, vault, lifecycle, treasury, services, economics, buyer inventory and available recovery actions of one NFA.',
    inputSchema:object(tokenArg,['tokenId']),run:async({tokenId})=>pick(await api(`/studio/nfas/${token(tokenId)}`))},
  {name:'nfa_owned',description:'NFAs owned by an account.',inputSchema:object({owner:{type:'string'}},['owner']),
    run:async({owner})=>api(`/studio/owned?owner=${encodeURIComponent(owner)}`)},
  {name:'nfa_services',description:'Services an NFA sells right now, with input schemas and why any is unavailable.',inputSchema:object(tokenArg,['tokenId']),
    run:async({tokenId})=>api(`/v1/nfas/${token(tokenId)}/services`)},
  {name:'nfa_quote',description:'Quote a paid job. Returns the exact input commitment and an UNSIGNED wallet action; nothing is charged.',
    inputSchema:object({...tokenArg,service:{type:'string',enum:SERVICE},input:{type:'object'},useMemory:{type:'boolean'}},['tokenId','service','input']),
    run:async({tokenId,service:s,input,useMemory})=>api(`/v1/nfas/${token(tokenId)}/services/${service(s)}/quotes`,{input,...(useMemory===undefined?{}:{useMemory})})},
  {name:'nfa_prepare_start',description:'Unsigned action that starts a paid job with its exact committed input.',
    inputSchema:object({...tokenArg,service:{type:'string',enum:SERVICE},jobId:{type:'integer'},inputData:{type:'string'}},['tokenId','service','jobId','inputData']),
    run:async({tokenId,service:s,jobId,inputData})=>api(`/v1/nfas/${token(tokenId)}/services/${service(s)}/jobs/${jobId}/prepare-start`,{inputData})},
  {name:'nfa_job',description:'Status and output commitment of a paid job.',
    inputSchema:object({...tokenArg,service:{type:'string',enum:SERVICE},jobId:{type:'integer'}},['tokenId','service','jobId']),
    run:async({tokenId,service:s,jobId})=>api(`/v1/nfas/${token(tokenId)}/services/${service(s)}/jobs/${jobId}`)},
  {name:'nfa_sandbox_bootstrap',description:'SANDBOX ONLY. Create a new NFA as the sandbox owner, give it a vault-owned OutLayer Project and enable paid Scout.',
    inputSchema:object({}),run:bootstrap},
  {name:'nfa_sandbox_hire',description:'SANDBOX ONLY. As the sandbox customer: quote, pay, start and wait for a Scout job on an NFA. Returns the finalized job.',
    inputSchema:object({...tokenArg,question:{type:'string'},sources:{type:'array',items:object({title:{type:'string'},url:{type:'string'},text:{type:'string'}},['title','url','text'])}},
      ['tokenId','question','sources']),run:hire},
  {name:'nfa_sandbox_sell',description:'SANDBOX ONLY. List the NFA and buy it with the other sandbox account; shows owner/epoch change, the same vault, and that the former owner is refused.',
    inputSchema:object({...tokenArg,priceYocto:{type:'string'}},['tokenId']),run:sell},
  {name:'nfa_sandbox_send',description:'SANDBOX ONLY. Sign and send an unsigned action (from nfa_quote, nfa_prepare_start or a recovery action) as a sandbox account.',
    inputSchema:object({accountId:{type:'string'},action:{type:'object'}},['accountId','action']),
    run:async({accountId,action})=>{const {config}=await sandbox();if(!config.localSandbox.accounts.includes(accountId))throw Error('Unknown sandbox account');return send(accountId,action)}},
];

export async function handle(message){
  const {id,method,params}=message;
  if(method==='initialize')return {protocolVersion:params?.protocolVersion||'2025-06-18',capabilities:{tools:{}},
    serverInfo:{name:'nfa-gent',version:'1.0.0'},instructions:'Call nfa_overview first. Against a local sandbox, nfa_sandbox_bootstrap → nfa_sandbox_hire → nfa_sandbox_sell demonstrates the whole product.'};
  if(method==='ping')return {};
  if(method==='tools/list')return {tools:tools.map(({run,...t})=>t)};
  if(method==='tools/call'){
    const tool=tools.find(t=>t.name===params?.name);if(!tool)throw Object.assign(Error('Unknown tool'),{code:-32602});
    try{return {content:[{type:'text',text:JSON.stringify(await tool.run(params.arguments||{}),null,2)}]}}
    catch(error){return {content:[{type:'text',text:String(error.message||error)}],isError:true}}
  }
  if(id===undefined)return undefined;
  throw Object.assign(Error('Method not found'),{code:-32601});
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
  let buffer='';process.stdin.setEncoding('utf8');
  process.stdin.on('data',async chunk=>{buffer+=chunk;let i;
    while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i).trim();buffer=buffer.slice(i+1);if(!line)continue;
      let message;try{message=JSON.parse(line)}catch{process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}})+'\n');continue}
      try{const result=await handle(message);if(message.id!==undefined)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result})+'\n')}
      catch(error){if(message.id!==undefined)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,error:{code:error.code||-32603,message:error.message}})+'\n')}
    }});
}
