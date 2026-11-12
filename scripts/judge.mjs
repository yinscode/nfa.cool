#!/usr/bin/env node
// One command for judges (people or agents): re-derives NFA.gent's claims locally, with no
// secrets, keys, testnet tokens or Rust toolchain. Writes judge-report.json and exits non-zero
// if any check fails.
//   npm run judge            full run (about 3 minutes after npm ci)
//   npm run judge -- --quick skip the native contract tests and the upgrade rehearsal
//   npm run judge -- --out path/report.json
import {spawn,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,writeFile,mkdir,access,readdir} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir,platform,arch} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));process.chdir(root);
const args=process.argv.slice(2),quick=args.includes('--quick');
const outPath=resolve(args[args.indexOf('--out')+1]&&args.includes('--out')?args[args.indexOf('--out')+1]:'judge-report.json');
const work=await mkdtemp(join(tmpdir(),'nfa-judge-')),logs=join(work,'logs');await mkdir(logs);
const wasm=f=>join(root,'judge/wasm',f);
const started=Date.now(),steps=[];
const color=process.stdout.isTTY?(c,s)=>`\x1b[${c}m${s}\x1b[0m`:(c,s)=>s;
const exists=async p=>{try{await access(p);return true}catch{return false}};
const has=cmd=>spawnSync(cmd,['--version'],{stdio:'ignore'}).status===0;
const freePort=()=>new Promise(r=>{const s=createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p))})});

function run(name,command,argv,{env={},timeoutMs=300_000}={}){
  return new Promise(done=>{
    const t0=Date.now(),log=join(logs,name+'.log');let out='',err='';
    const child=spawn(command,argv,{cwd:root,env:{...process.env,...env},stdio:['ignore','pipe','pipe']});
    const timer=setTimeout(()=>child.kill('SIGTERM'),timeoutMs);
    child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>err+=d);
    child.on('close',async code=>{clearTimeout(timer);await writeFile(log,out+'\n--- stderr ---\n'+err);
      done({code,out,err,ms:Date.now()-t0,log})});
  });
}
function record(step){
  steps.push(step);
  const mark=step.status==='pass'?color(32,'PASS'):step.status==='skipped'?color(33,'SKIP'):color(31,'FAIL');
  console.log(`${mark} ${step.name.padEnd(22)} ${String(Math.round((step.durationMs||0)/1000)).padStart(4)}s  ${step.detail||''}`);
}
const tail=text=>text.split('\n').filter(l=>!/deprecated/.test(l)).slice(-12).join('\n');

console.log(`NFA.gent judge — ${platform()}-${arch()}, node ${process.versions.node}${quick?', quick':''}\n`);

// 0. The SDK and shared packages are built (npm ci does not build them).
if(!(await exists('packages/sdk/dist/index.js'))||!(await exists('packages/shared/dist/index.js'))){
  const r=await run('build','npm',['run','build']);
  record({name:'build',status:r.code===0?'pass':'fail',durationMs:r.ms,detail:r.code===0?'SDK, shared types and web built':tail(r.err),log:r.log});
}

// 1. JavaScript tests: workers, API, SDK, web helpers, claims ledger consistency.
{
  const files=['test.cjs'];
  for(const dir of ['services/worker/test','services/api/test','packages/sdk/test','apps/web/test','scripts/test'])
    for(const f of (await readdir(dir)).sort())if(f.endsWith('.test.mjs'))files.push(join(dir,f));
  const r=await run('unit-js',process.execPath,['--test',...files]);
  const pass=+(r.out.match(/# pass (\d+)/)?.[1]||0),fail=+(r.out.match(/# fail (\d+)/)?.[1]||0);
  record({name:'unit-js',status:r.code===0&&fail===0?'pass':'fail',durationMs:r.ms,detail:`${pass} passed, ${fail} failed`,counts:{pass,fail},log:r.log});
}

// 2. Native contract tests (optional: needs Rust). The registry embeds the committed vault.
for(const [name,manifest] of [['contracts-vault','contracts/vault-v2/Cargo.toml'],['contracts-registry','contracts/registry/Cargo.toml']]){
  if(quick||!has('cargo')){record({name,status:'skipped',detail:quick?'--quick':'cargo not installed (prebuilt WASMs are used below)'});continue}
  const r=await run(name,'cargo',['test','--offline','--features','near-sdk/unit-testing','--manifest-path',manifest],
    {env:{CARGO_TARGET_DIR:join(root,'.deps/judge-target/test-'+name),NFA_VAULT_WASM_PATH:wasm('vault.wasm')},timeoutMs:600_000});
  const passed=[...r.out.matchAll(/test result: ok\. (\d+) passed/g)].reduce((a,m)=>a+ +m[1],0);
  const offline=/offline|failed to download|no matching package/i.test(r.err);
  record({name,status:r.code===0?'pass':offline?'skipped':'fail',durationMs:r.ms,log:r.log,
    detail:r.code===0?`${passed} passed`:offline?'cargo dependencies not cached offline':tail(r.err)});
}

// 3. Prebuilt WASMs match their manifest.
{
  const manifest=JSON.parse(await readFile(wasm('manifest.json'),'utf8'));const bad=[];
  for(const [file,meta] of Object.entries(manifest.files)){
    const hash=createHash('sha256').update(await readFile(wasm(file))).digest('hex');if(hash!==meta.sha256)bad.push(file);
  }
  record({name:'prebuilt-wasm',status:bad.length?'fail':'pass',detail:bad.length?`hash mismatch: ${bad}`:`4 files match manifest (source ${manifest.sourceCommit.slice(0,8)})`,
    sourceCommit:manifest.sourceCommit});
}

// 4. A local NEAR sandbox node.
let sandboxBin=process.env.NEAR_SANDBOX_BIN_PATH||join(root,'.deps/bin/near-sandbox');
if(!(await exists(sandboxBin))){
  console.log('     installing NEAR sandbox 2.14.0 (one-time download, about 70 MB)…');
  const r=await run('install-sandbox','sh',['scripts/install-sandbox.sh'],{timeoutMs:600_000});
  if(r.code!==0){record({name:'near-sandbox',status:'fail',detail:tail(r.err||r.out),log:r.log});sandboxBin=null}
}
if(sandboxBin)record({name:'near-sandbox',status:'pass',detail:sandboxBin.replace(root+'/','')});

// 5. Sandbox suites: real NEAR receipts, deterministic OutLayer mock, committed WASMs.
const assertions={};
const sandboxEnv={NEAR_SANDBOX_BIN_PATH:sandboxBin||'',NFA_SANDBOX_OUTLAYER:'1',
  NFA_SANDBOX_REGISTRY_WASM:wasm('registry-sandbox.wasm'),NFA_SANDBOX_MOCK_WASM:wasm('outlayer-mock.wasm')};
const suites=[
  ['sandbox','scripts/sandbox-check.mjs','NFA_SANDBOX_METRICS_OUTPUT','sandbox.json',j=>j.assertions,'handover, paid jobs, payouts, transfer-call rollback'],
  ['recovery','scripts/recovery-sandbox-check.mjs','NFA_RECOVERY_OUTPUT','recovery.json',j=>j.results,'liveness, slot pricing, refunds, liabilities'],
  ['research','scripts/research-sandbox-check.mjs','NFA_RESEARCH_EVIDENCE_OUTPUT','research.json',j=>j.checks,'memory across sale, billing ledgers'],
  ['rehearsal','scripts/rehearse-studio-upgrade.mjs','NFA_REHEARSAL_OUTPUT','rehearsal.json',j=>j.assertions,'upgrade from prior deployed bytes'],
];
for(const [name,script,outVar,file,read,about] of suites){
  if(!sandboxBin){record({name,status:'skipped',detail:'no NEAR sandbox'});continue}
  if(quick&&name==='rehearsal'){record({name,status:'skipped',detail:'--quick'});continue}
  const output=join(work,file);
  const r=await run(name,process.execPath,[script],{env:{...sandboxEnv,[outVar]:output,
    NFA_NEW_REGISTRY_WASM:wasm('registry.wasm'),NFA_NEW_VAULT_WASM:wasm('vault.wasm')}});
  let list=[];try{list=read(JSON.parse(await readFile(output,'utf8')))||[]}catch{}
  assertions[name]=r.code===0?list:[];
  record({name,status:r.code===0&&list.length?'pass':'fail',durationMs:r.ms,log:r.log,assertions:list,
    detail:r.code===0?`${list.length} checks: ${about}`:tail(r.err)});
}

// 6. Agent interface: drive the MCP server against an isolated sandbox Studio.
if(!sandboxBin)record({name:'mcp-agent-flow',status:'skipped',detail:'no NEAR sandbox'});
else{
  const t0=Date.now(),port=await freePort(),data=join(work,'studio');
  const studio=spawn(process.execPath,['scripts/sandbox-check.mjs','--serve-fast'],{cwd:root,stdio:['ignore','pipe','pipe'],
    env:{...process.env,...sandboxEnv,NFA_PORT:String(port),NFA_SANDBOX_DATA_DIR:data}});
  let studioOut='';studio.stdout.on('data',d=>studioOut+=d);studio.stderr.on('data',()=>{});
  const result={};
  try{
    for(let i=0;i<120&&!/Studio sandbox at/.test(studioOut);i++)await new Promise(r=>setTimeout(r,500));
    if(!/Studio sandbox at/.test(studioOut))throw Error('sandbox Studio did not start');
    const mcp=spawn(process.execPath,['scripts/mcp-server.mjs'],{cwd:root,stdio:['pipe','pipe','pipe'],env:{...process.env,NFA_API_URL:`http://127.0.0.1:${port}`}});
    let buffer='';const waiting=new Map();
    mcp.stdout.on('data',d=>{buffer+=d;let i;while((i=buffer.indexOf('\n'))>=0){const m=JSON.parse(buffer.slice(0,i));buffer=buffer.slice(i+1);waiting.get(m.id)?.(m);}});
    let next=1;const rpc=(method,params)=>new Promise((ok,fail)=>{const id=next++;const timer=setTimeout(()=>fail(Error(method+' timed out')),180_000);
      waiting.set(id,m=>{clearTimeout(timer);m.error?fail(Error(m.error.message)):ok(m.result)});mcp.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n')});
    const tool=async(name,args={})=>{const r=await rpc('tools/call',{name,arguments:args});const text=r.content[0].text;if(r.isError)throw Error(`${name}: ${text}`);return JSON.parse(text)};
    try{
      await rpc('initialize',{protocolVersion:'2025-06-18',clientInfo:{name:'nfa-judge'}});
      result.tools=(await rpc('tools/list')).tools.map(t=>t.name);
      const created=await tool('nfa_sandbox_bootstrap');
      const hired=await tool('nfa_sandbox_hire',{tokenId:created.tokenId,question:'Does the agent keep its vault after a sale?',
        sources:[{title:'Vault',url:'https://example.org/vault',text:'The NFA vault stays the same account when the NFT is sold to a new owner.'}]});
      const sold=await tool('nfa_sandbox_sell',{tokenId:created.tokenId});
      Object.assign(result,{tokenId:created.tokenId,jobStatus:hired.status,outputHash:hired.outputHash,sale:sold});
      const ok=hired.status==='FINALIZED'&&sold.sameVault&&sold.formerOwnerDenied&&sold.epochAfter===sold.epochBefore+1;
      assertions['mcp-agent-flow']=ok?['agent created an NFA','agent hired it and the job finalized','agent sold it: same vault, new epoch, former owner refused']:[];
      record({name:'mcp-agent-flow',status:ok?'pass':'fail',durationMs:Date.now()-t0,assertions:assertions['mcp-agent-flow'],result,
        detail:ok?`created ${created.tokenId}, hired (FINALIZED), sold to ${sold.buyer}`:JSON.stringify(result).slice(0,300)});
    }finally{mcp.kill('SIGTERM')}
  }catch(error){record({name:'mcp-agent-flow',status:'fail',durationMs:Date.now()-t0,detail:String(error.message||error),result})}
  finally{studio.kill('SIGTERM');await new Promise(r=>{studio.once('exit',r);setTimeout(r,5000).unref()})}
}

// 7. Claims: each claim's judge checks must all have run and passed.
const ledger=JSON.parse(await readFile('docs/CLAIMS.json','utf8'));
const stepPassed=name=>steps.find(s=>s.name===name)?.status==='pass';
const claims=ledger.claims.map(claim=>{
  const checks=(claim.judge||[]).map(check=>{const [step,...rest]=check.split(':'),assertion=rest.join(':');
    const ran=step==='contracts'?steps.find(s=>s.name==='contracts-'+assertion):steps.find(s=>s.name===step);
    const verified=step==='contracts'?stepPassed('contracts-'+assertion):!!assertions[step]?.includes(assertion);
    return {check,verified,skipped:ran?.status==='skipped'}});
  const judged=checks.length?(checks.every(c=>c.verified)?'verified':checks.some(c=>!c.verified&&!c.skipped)?'failed':'partially-skipped'):'not-judged-locally';
  return {id:claim.id,status:claim.status,level:claim.level,statement:claim.statement,judged,checks,
    readOnly:claim.readOnly||null,transactions:(claim.transactions||[]).map(t=>({label:t.label,url:t.url})),limits:claim.limits||null};
});
const failed=steps.filter(s=>s.status==='fail');
const report={schema:1,tool:'npm run judge',generatedAt:new Date().toISOString(),durationMs:Date.now()-started,
  commit:(spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).stdout||'').trim()||process.env.NFA_COMMIT||null,platform:`${platform()}-${arch()}`,node:process.versions.node,quick,
  result:failed.length?'fail':'pass',steps,claims,
  summary:{steps:{pass:steps.filter(s=>s.status==='pass').length,fail:failed.length,skipped:steps.filter(s=>s.status==='skipped').length},
    claims:Object.fromEntries(['verified','failed','partially-skipped','not-judged-locally'].map(k=>[k,claims.filter(c=>c.judged===k).length]))},
  next:{liveFacts:'npm run verify:testnet (read-only, no keys)',agentInterface:'NFA_API_URL=<studio> node scripts/mcp-server.mjs',claims:'docs/CLAIMS.json',logs:logs}};
await writeFile(outPath,JSON.stringify(report,null,2)+'\n');
console.log(`\nClaims: ${claims.map(c=>`${c.judged==='verified'?color(32,'✓'):c.judged==='failed'?color(31,'✗'):'·'} ${c.id}`).join('  ')}`);
console.log(`\n${report.result==='pass'?color(32,'PASS'):color(31,'FAIL')} in ${Math.round(report.durationMs/1000)}s — report ${outPath.replace(root+'/','')}, logs ${logs}`);
if(failed.length)process.exitCode=1;
