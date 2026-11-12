#!/usr/bin/env node
// A reproducible metadata-only component revision exercises version continuity.
import {readFile,writeFile} from 'node:fs/promises';
import {transactions} from 'near-api-js';
import {testnet,sha} from './testnet-lib.mjs';
import {inspectWasm} from '../services/api/wasm-release.mjs';
const base=await readFile('releases/nfa-scout-compare-b2cf2dd2b606ec15.wasm');
const metadata={revision:'studio-continuity-v2',baseSha256:sha(base),change:'Release metadata only; executable logic unchanged'};
const leb=n=>{const a=[];do{let b=n&127;n>>>=7;if(n)b|=128;a.push(b)}while(n);return Buffer.from(a)};
const name=Buffer.from('nfa.release'),content=Buffer.concat([leb(name.length),name,Buffer.from(JSON.stringify(metadata))]);
const bytes=Buffer.concat([base,Buffer.from([0]),leb(content.length),content]);inspectWasm(bytes);
await writeFile('releases/nfa-scout-compare-v2.wasm',bytes);
const ctx=await testnet('deployments/outlayer-v2-public.json');
const alice=await ctx.signer('t006-alice'),funder=await ctx.signer('studio-funder');
const balance=await ctx.account(alice.id),target=5n*10n**23n;
if(BigInt(balance.amount)<target)await ctx.send('fundProbeSigner',funder,alice.id,[transactions.transfer(target-BigInt(balance.amount))]);
const published=await ctx.upload('uploadRuntimeV2',funder,bytes,'application/wasm','wasm');
ctx.evidence.release={...metadata,versionKey:sha(bytes),url:published.url,bytes:bytes.length};await ctx.save();
const source={WasmUrl:{url:published.url,hash:sha(bytes),build_target:'wasm32-wasip2'}};
const query={request_type:'call_function',finality:'final',account_id:'outlayer.testnet',method_name:'get_version',
  args_base64:Buffer.from(JSON.stringify({project_id:'nfagent-alice-fe53d8.testnet/nfa-probe',version_key:sha(bytes)})).toString('base64')};
const current=JSON.parse(Buffer.from((await ctx.rpc('query',query)).result).toString());
if(!current){
  const reconciled=ctx.evidence.steps.addProbeVersion?.state==='SUBMITTED'&&!ctx.evidence.steps.addProbeVersion.outcome;
  if(reconciled){ctx.evidence.addVersionReconciliation={at:new Date().toISOString(),versionPresent:false,
    note:'Original async broadcast is unknown to RPC. A version hash is unique within the Project; a duplicate add is rejected with its deposit refunded.'};await ctx.save()}
  await ctx.send(reconciled?'addProbeVersionReconciled':'addProbeVersion',alice,'outlayer.testnet',[transactions.functionCall('add_version',
    {project_name:'nfa-probe',source,set_active:false},250_000_000_000_000n,50n*10n**21n)]);
}
const probe=JSON.parse(await readFile('deployments/outlayer-probe-public.json'));
const input={operation:'recall',service:'scout',jobId:10002,expectedHash:probe.warmRun.value.outputHash};
const label=process.argv.includes('--cached-retry')?'warmV2Cached':'warmV2';
const result=await ctx.send(label,alice,'outlayer.testnet',[transactions.functionCall('request_execution',{
  source:{Project:{project_id:probe.projectId,version_key:sha(bytes)}},input_data:JSON.stringify(input),
  resource_limits:{max_instructions:1_000_000_000,max_memory_mb:64,max_execution_seconds:10},response_format:'Json'},250_000_000_000_000n,5n*10n**21n)]);
if(result.value?.outputHash!==probe.warmRun.value.outputHash||result.value?.status!=='ok')throw Error('V2 did not recall the finalized V1 memory');
ctx.evidence.verifiedRecall=result;await ctx.save();
for(const service of ['scout','compare']){
  const input=JSON.parse(service==='scout'?probe.warmRunInput:probe.compareRunInput);
  input.jobId=service==='scout'?20004:20005;
  const verified=await ctx.send(`verifyV2${service}`,alice,'outlayer.testnet',[transactions.functionCall('request_execution',{
    source:{Project:{project_id:probe.projectId,version_key:sha(bytes)}},input_data:JSON.stringify(input),
    resource_limits:{max_instructions:1_000_000_000,max_memory_mb:64,max_execution_seconds:10},response_format:'Json'},250_000_000_000_000n,5n*10n**21n)]);
  const expected=service==='scout'?probe.warmRun.value.outputHash:probe.compareRun.value.outputHash;
  if(verified.value?.status!=='ok'||verified.value.outputHash!==expected)throw Error('V2 fixture output mismatch');
  ctx.evidence[service]=verified;await ctx.save();
}
const catalog=JSON.parse(await readFile('releases/catalog.json'));
const release={id:'scout-compare-2',versionKey:sha(bytes),url:published.url,services:['scout','compare'],artifactCodec:'scout-compare-v1',
  hostedStatus:'verified',reason:'Scout, Compare and V1 memory recall passed under the new hash in the same staging Project',
  diff:metadata,hostedEvidence:{scout:ctx.evidence.scout.hash,compare:ctx.evidence.compare.hash,recall:result.hash,projectUuid:probe.project.uuid}};
const existing=catalog.releases.findIndex(r=>r.id===release.id);if(existing>=0)catalog.releases[existing]=release;else catalog.releases.push(release);
await writeFile('releases/catalog.json',JSON.stringify(catalog,null,2)+'\n');console.log(JSON.stringify(release,null,2));
