#!/usr/bin/env node
// Caleb: a Research NFA on NEAR testnet, created by Alice and hired twice by Bob.
// Phased and journaled (deployments/caleb-research.json); every phase is safe to re-run.
//   node scripts/caleb-research-testnet.mjs status|mint|provision|secret|configure|key|fund
//   node scripts/caleb-research-testnet.mjs job1|job2 pay|prepare|submit|bind|poll|settle|verify
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {parseEnv} from 'node:util';
import {createHash,randomBytes} from 'node:crypto';
import {transactions,KeyPair,keyStores,connect} from 'near-api-js';
import {NfaSdk} from '@nfa/sdk';
import {testnet,pause} from './testnet-lib.mjs';
import {AvatarRenderer} from '../services/api/render.mjs';
import {characterCatalog} from '../services/api/studio.mjs';
import {quoteService,schemaHashFor} from '../services/api/service-runtime.mjs';
import {OutlayerHttpsAsync,paymentKeyOwner} from '../services/worker/outlayer-https-async.mjs';
import {paymentKeyEncryptionKey,sealOutlayerPaymentKey,researchEncryptionKey,researchSecretAccess,
  sealOutlayerSecrets} from '../services/worker/outlayer-secrets.mjs';

const [first,second]=process.argv.slice(2);
const SETUP=['status','mint','provision','secret','configure','key','fund','resume'],JOB=['pay','prepare','submit','bind','poll','settle','verify'];
const label=/^job[1-6]$/.test(first??'')?first:null,phase=label?second:first;
if(label?!JOB.includes(phase):!SETUP.includes(phase))throw Error(`Use ${SETUP.join('|')} or job1|job2 ${JOB.join('|')}`);

const registryId='nfagent-registry-0e9b2a.testnet',requestId='caleb-research-v1',profile='caleb-research-v1';
// The reviewed, hosted-verified Research runtime (releases/catalog.json scout-compare-research-6-long-model).
const wasmHash='a8513acd137f37ce21a820e8d2e9b92b9712970e3c3710b41a4e26df06137588';
const wasmUrl=`https://test.fastfs.io/nfa-studio-mwd3mksx.testnet/outlayer.testnet/studio/${wasmHash}.wasm`;
const POLICY={margin:'10000000000000000000000',maxDeposit:'500000000000000000000000',
  limits:{max_instructions:1000000000,max_memory_mb:128,max_execution_seconds:30}};
const QUESTIONS={
  job1:{question:'How do NEAR access keys limit what an application can do with an account?',
    sources:[{title:'NEAR access keys',url:'https://docs.near.org/protocol/accounts-contracts/access-keys'}]},
  job2:{question:'How can a NEAR account control an address on another chain?',
    sources:[{title:'Chain Signatures',url:'https://docs.near.org/chain-abstraction/chain-signatures'}]}};
// Retries after an operator-side failure reuse the same two questions.
for(const n of [3,5])QUESTIONS[`job${n}`]=QUESTIONS.job1;for(const n of [4,6])QUESTIONS[`job${n}`]=QUESTIONS.job2;
const sha=b=>'sha256:'+createHash('sha256').update(b).digest('hex');
const near=n=>BigInt(Math.round(n*1000))*10n**21n;

const ctx=await testnet('deployments/caleb-research.json');
const operator=await ctx.signer('t004-operator'),alice=await ctx.signer('t006-alice'),
  bob=await ctx.signer('t008-bob'),funder=await ctx.signer('studio-funder');
const sdk=new NfaSdk({registryAccountId:registryId,rpcUrl:ctx.rpcUrl});
const until=async(work,check,what)=>{for(let i=0;i<120;i++){const v=await work();if(check(v))return v;await pause(500)}
  throw Error(`${what} not observed; inspect deployments/caleb-research.json before retrying`)};
const call=(method,args,deposit=0n,gas=300_000_000_000_000n)=>[transactions.functionCall(method,Buffer.from(JSON.stringify(args)),gas,BigInt(deposit))];
const transact=(name,who,a)=>ctx.send(name,who,a.receiverId,[transactions.functionCall(a.methodName,a.args,BigInt(a.gas),BigInt(a.deposit))]);
const balance=async id=>BigInt((await ctx.account(id)).amount);
const tokenId=await sdk.view(registryId,'request_token',{owner:alice.id,request_id:requestId});
const keyPath=()=>`.data/outlayer-payment-key-${tokenId}.private.json`;

if(phase==='status'){
  const out={tokenId,balances:{}};
  for(const [k,v] of Object.entries({alice,bob,operator,funder}))out.balances[k]=Number(await balance(v.id)/10n**20n)/1e4;
  if(tokenId){const [id,project,config,setup,research]=await Promise.all([sdk.get(tokenId),sdk.getOutlayerProject(tokenId),
    sdk.getResearchConfig(tokenId),sdk.view(registryId,'payment_key_setup',{token_id:tokenId}),sdk.getServicePolicy(tokenId,'research')]);
    Object.assign(out,{vault:id.vaultAccountId,owner:id.ownerAccountId,project:project?.state??null,runtime:project?.version_key??null,
      configured:!!config,paymentKey:setup?.state??null,research:!!research?.enabled})}
  console.log(JSON.stringify(out,null,2));process.exit(0);
}

if(phase==='mint'){
  if(tokenId){console.log(JSON.stringify({phase,tokenId,already:true}));process.exit(0)}
  const needed=near(6.2);
  if(await balance(alice.id)<needed)throw Error(`Alice needs ${Number(needed/10n**20n)/1e4} NEAR for the 6 NEAR mint deposit and fees; fund ${alice.id} first`);
  if(!ctx.evidence.character){
    const renderer=new AvatarRenderer('.data/caleb/render'),catalog=await characterCatalog();
    const preview=await renderer.render({seed:'caleb-scholar',traits:{}});
    const image=await ctx.upload('calebImage',funder,await renderer.image(preview.key),'image/png','png');
    const cutout=await ctx.upload('calebCutout',funder,await renderer.cutout(preview.key),'image/png','png');
    const manifest={schemaVersion:2,revision:0,displayName:'Caleb',template:'research@1.0.0',
      description:'A research agent: cited answers from approved NEAR documentation, reasoned with NEAR AI.',
      publicCharacter:{collection:'nfa-v2',seed:preview.seed,renderSeed:preview.metadata.seed,traits:preview.metadata.traits,
        rendererVersion:catalog.rendererVersion,assetDigest:catalog.assetDigest,imageHash:'sha256:'+image.hash,imageUri:image.url,
        cutoutHash:'sha256:'+cutout.hash,cutoutUri:cutout.url},
      skills:[{id:'research',version:'1.0.0'}],services:[{id:'research',schemaHash:schemaHashFor('research')}]};
    const published=await ctx.upload('calebManifest',funder,Buffer.from(JSON.stringify(manifest)),'application/json','json');
    ctx.evidence.character={hash:'sha256:'+published.hash,url:published.url};await ctx.save();
  }
  await ctx.send('mintCaleb',alice,registryId,call('create_agent',{request_id:requestId,
    manifest_hash:ctx.evidence.character.hash,manifest_uri:ctx.evidence.character.url},near(6)));
  const minted=await until(()=>sdk.view(registryId,'request_token',{owner:alice.id,request_id:requestId}),Boolean,'Caleb token');
  const identity=await until(()=>sdk.get(minted).catch(()=>null),Boolean,'Caleb identity');
  ctx.evidence.tokenId=minted;ctx.evidence.vault=identity.vaultAccountId;await ctx.save();
  console.log(JSON.stringify({phase,tokenId:minted,vault:identity.vaultAccountId}));process.exit(0);
}
if(!tokenId)throw Error('Mint Caleb first');
const identity=await sdk.get(tokenId),vault=identity.vaultAccountId;
if(identity.ownerAccountId!==alice.id)throw Error('Caleb is no longer owned by Alice');
const projectId=`${vault}/scout`;

if(phase==='resume'){
  // After an operator-side failure the registry drains the NFA; the owner resumes it.
  const agent=await sdk.getAgentState(tokenId);
  if(agent.lifecycle==='Draining'){
    const failed=Number(second);if(!Number.isSafeInteger(failed)||failed<1)throw Error('Use resume <failedJobId>');
    await ctx.send(`resumeCalebAfter${failed}`,alice,registryId,call('resume_failed_service',{token_id:tokenId,failed_job_id:failed},1n,100_000_000_000_000n));
  }
  const resumed=await until(()=>sdk.getAgentState(tokenId),a=>a.lifecycle==='Active'&&a.pending_op==null,'Active Caleb');
  console.log(JSON.stringify({phase,lifecycle:resumed.lifecycle}));process.exit(0);
}
if(phase==='provision'){
  let project=await sdk.getOutlayerProject(tokenId);
  if(!project){
    const check=await fetch(wasmUrl,{signal:AbortSignal.timeout(20000)});
    if(!check.ok||sha(Buffer.from(await check.arrayBuffer()))!==`sha256:${wasmHash}`)throw Error('Published Research runtime changed');
    await transact('provisionCalebProject',alice,sdk.provisionOutlayer(tokenId,wasmUrl,wasmHash,'100000000000000000000000'));
  }
  project=await until(()=>sdk.getOutlayerProject(tokenId),p=>p?.state==='READY'&&p.version_key===wasmHash,'READY Project');
  console.log(JSON.stringify({phase,projectId:project.project_id,projectUuid:project.project_uuid,versionKey:project.version_key}));process.exit(0);
}
const project=await sdk.getOutlayerProject(tokenId);
if(project?.state!=='READY'||project.version_key!==wasmHash||project.project_id!==projectId)throw Error('Provision Caleb first');
const accessor={Project:{project_id:projectId}},access=researchSecretAccess(vault,wasmHash);
const env=parseEnv(await readFile('.env.research','utf8'));
if(env.NFA_RESEARCH_PROVIDER!=='near-ai'||!env.NFA_RESEARCH_API_KEY||!env.NFA_RESEARCH_MODEL)throw Error('Dedicated near-ai credential/model required');

if(phase==='secret'){
  if(!await sdk.view('outlayer.testnet','get_secrets',{accessor,profile,owner:operator.id})){
    const pubkey=await researchEncryptionKey({owner:operator.id,profile,projectId});
    const sealed=sealOutlayerSecrets(pubkey,{NFA_RESEARCH_API_KEY:env.NFA_RESEARCH_API_KEY,NFA_RESEARCH_PROVIDER:env.NFA_RESEARCH_PROVIDER});
    await ctx.send('storeCalebResearchSecret',operator,'outlayer.testnet',call('store_secrets',{accessor,profile,
      encrypted_secrets_base64:sealed,access,vault_id:null},100_000_000_000_000_000_000_000n,50_000_000_000_000n));
  }
  const row=await until(()=>sdk.view('outlayer.testnet','get_secrets',{accessor,profile,owner:operator.id}),Boolean,'Research secret');
  if(JSON.stringify(row.access)!==JSON.stringify(access))throw Error('Secret is not bound to Caleb and the exact runtime');
  console.log(JSON.stringify({phase,profile,projectId,bound:true}));process.exit(0);
}
if(phase==='configure'){
  const settings={version_key:wasmHash,secrets_ref:{account_id:operator.id,profile},
    allowed_sources:[{host:'docs.near.org',path_prefix:'/'}],model:env.NFA_RESEARCH_MODEL,
    max_input_tokens:12000,max_output_tokens:2048,input_microusd_per_token:1,output_microusd_per_token:2,
    max_cost_microusd:30000,daily_budget_microusd:150000};
  const configured=await sdk.getResearchConfig(tokenId);
  if(JSON.stringify(configured?.settings)!==JSON.stringify(settings))
    await transact('configureCalebResearch',alice,sdk.configureResearch(tokenId,settings));
  await until(()=>sdk.getResearchConfig(tokenId),c=>c?.settings?.version_key===wasmHash,'Research configuration');
  const policy=await sdk.getServicePolicy(tokenId,'research');
  if(!policy?.enabled||policy.schema_hash!==schemaHashFor('research'))
    await transact('enableCalebResearch',alice,sdk.configureService(tokenId,'research',schemaHashFor('research'),true,
      POLICY.margin,POLICY.maxDeposit,POLICY.limits));
  const enabled=await until(()=>sdk.getServicePolicy(tokenId,'research'),p=>p?.enabled,'Research policy');
  console.log(JSON.stringify({phase,configurationHash:(await sdk.getResearchConfig(tokenId)).configuration_hash,policyVersion:enabled.version}));process.exit(0);
}
if(phase==='key'){
  let setup=await sdk.view(registryId,'payment_key_setup',{token_id:tokenId}).catch(()=>null);
  if(setup?.state!=='READY'){
    let pkg;try{pkg=JSON.parse(await readFile(keyPath(),'utf8'))}catch(error){if(error.code!=='ENOENT')throw error}
    if(!pkg){
      const nonce=await sdk.view('outlayer.testnet','get_next_payment_key_nonce',{account_id:vault});
      const secret=randomBytes(32).toString('hex');
      const secrets={key:secret,project_ids:[projectId],max_per_call:'100000',initial_balance:'0'};
      const ciphertext=sealOutlayerPaymentKey(await paymentKeyEncryptionKey({owner:vault,nonce,secrets}),secrets);
      pkg={network:'testnet',owner:vault,nonce,projectIds:[projectId],maxPerCallMicrousd:'100000',apiKey:`${vault}:${nonce}:${secret}`,
        encryptedSecretsBase64:ciphertext,ciphertextHash:createHash('sha256').update(ciphertext).digest('hex'),createdAt:new Date().toISOString()};
      await mkdir('.data',{recursive:true});await writeFile(keyPath(),JSON.stringify(pkg,null,2)+'\n',{flag:'wx',mode:0o600});
    }
    if(!setup)await ctx.send('approveCalebPaymentKey',alice,registryId,call('approve_payment_key',
      {token_id:tokenId,nonce:pkg.nonce,ciphertext_hash:pkg.ciphertextHash},1n,80_000_000_000_000n));
    setup=await until(()=>sdk.view(registryId,'payment_key_setup',{token_id:tokenId}),s=>['APPROVED','READY'].includes(s?.state),'Approval');
    if(setup.state==='APPROVED')await ctx.send('issueCalebPaymentKey',operator,registryId,
      call('issue_payment_key',{token_id:tokenId,encrypted_secrets_base64:pkg.encryptedSecretsBase64}));
    setup=await until(()=>sdk.view(registryId,'payment_key_setup',{token_id:tokenId}),s=>s?.state==='READY','READY Payment Key');
  }
  console.log(JSON.stringify({phase,state:setup.state,nonce:setup.nonce}));process.exit(0);
}
const setup=await sdk.view(registryId,'payment_key_setup',{token_id:tokenId});
if(setup?.state!=='READY')throw Error('Issue Caleb\'s Payment Key first');
const keyPackage=JSON.parse(await readFile(keyPath(),'utf8'));
if(paymentKeyOwner(keyPackage.apiKey)!==vault||keyPackage.nonce!==setup.nonce)throw Error('Payment Key package changed');
const keyBalance=async()=>{const r=await fetch(`https://testnet-api.outlayer.ai/public/payment-keys/${vault}/${setup.nonce}/balance`,{signal:AbortSignal.timeout(15000)});
  if(!r.ok)throw Error(`Payment Key balance unavailable (HTTP ${r.status})`);return Number((await r.json()).available)};

if(phase==='fund'){
  const available=await keyBalance();
  if(available<70000){
    const token=await sdk.view('outlayer.testnet','get_payment_token_contract',{});
    const amount=BigInt(await sdk.view(token,'ft_balance_of',{account_id:funder.id}));
    if(amount<70000n)throw Error('Funder holds less than $0.07 of the OutLayer payment token');
    await ctx.send('fundCalebPaymentKey',funder,token,call('ft_transfer_call',{receiver_id:'outlayer.testnet',amount:amount.toString(),
      msg:JSON.stringify({action:'top_up_payment_key',nonce:setup.nonce,owner:vault})},1n,100_000_000_000_000n));
  }
  console.log(JSON.stringify({phase,availableMicrousd:await keyBalance()}));process.exit(0);
}

// ---- Bob hires Caleb: one journaled paid Research job per label ----
const model=await sdk.getResearchConfig(tokenId);
const restricted=JSON.parse(await readFile('deployments/reporter-async-research.key.json'));
if(restricted.account_id!==operator.id||JSON.stringify(restricted.method_names)!==JSON.stringify(['bind_async_research_call','settle_async_research_job']))
  throw Error('Restricted async reporter key changed');
const store=new keyStores.InMemoryKeyStore();await store.setKey('testnet',operator.id,KeyPair.fromString(restricted.secret_key));
const reporter={id:operator.id,account:await (await connect({networkId:'testnet',nodeUrl:ctx.rpcUrl,deps:{keyStore:store}})).account(operator.id)};
const client=new OutlayerHttpsAsync({paymentKey:keyPackage.apiKey,vaultId:vault,projectId,versionKey:wasmHash,computeLimitMicrousd:30000,executionLimitSeconds:90});
const privatePath=`.data/caleb-research-${label}.private.json`;
const read=async()=>{try{return JSON.parse(await readFile(privatePath,'utf8'))}catch(error){if(error.code==='ENOENT')return null;throw error}};
const save=async value=>{await mkdir('.data',{recursive:true});await writeFile(privatePath,JSON.stringify(value,null,2)+'\n',{mode:0o600})};
let row=await read();
const done=value=>{console.log(JSON.stringify({label,...value}));process.exit(0)};
if(phase==='pay'){
  if(row)throw Error('This job already has a journal; resume from its phase');
  const agent=await sdk.getAgentState(tokenId);if(agent.pending_op!=null||agent.lifecycle!=='Active')throw Error('Caleb is busy');
  if(await keyBalance()<30000)throw Error('Payment Key below 30,000 microUSD; run fund');
  const policy=await sdk.getServicePolicy(tokenId,'research');
  const quote=await quoteService({sdk,tokenId,service:'research',body:{input:QUESTIONS[label]},
    policy:{research:{limits:policy.limits,marginYocto:policy.min_margin,maxDepositYocto:policy.max_deposit}},allowResearchCandidate:true});
  if(quote.transport!=='https-async'||quote.versionKey!==wasmHash)throw Error('Quote is not async Research on the pinned runtime');
  await save({label,phase:'pay_pending',quote,inputData:quote.inputData,ownerEpoch:identity.ownerEpoch,projectUuid:project.project_uuid});
  await transact(`${label}Pay`,bob,quote.unsignedAction);
  const jobId=ctx.evidence.steps[`${label}Pay`].outcome.value;
  if(!Number.isSafeInteger(jobId)||jobId<1)throw Error('Paid job ID missing');
  row={...await read(),jobId,phase:'paid'};await save(row);done({phase:row.phase,jobId,feeYocto:quote.feeYocto});
}
if(!row||row.ownerEpoch!==identity.ownerEpoch||row.projectUuid!==project.project_uuid)throw Error('Journal or ownership changed');
if(phase==='prepare'){
  if(row.phase==='paid'){
    const result=await transact(`${label}Prepare`,bob,sdk.prepareAsyncResearchJob(tokenId,row.jobId,row.inputData));
    const execution=JSON.parse(result.value);
    if(execution.jobId!==row.jobId||execution.service!=='research'||execution.context?.vaultAccountId!==vault||
      execution.research?.configuration_hash!==model.configuration_hash)throw Error('Prepared execution differs from the paid job');
    row={...row,phase:'prepared',execution,executionHash:sha(result.value)};await save(row);
  }
  done({phase:row.phase,jobId:row.jobId,priorWork:row.execution.context.priorWork});
}
if(!row.execution||row.executionHash!==sha(JSON.stringify(row.execution)))throw Error('Prepared execution missing or changed');
if(phase==='submit'){
  if(row.phase!=='prepared')throw Error('Submission already attempted; an unknown POST is never retried');
  row.phase='submission_unknown';await save(row);
  const admission=await client.submit(row.execution,model.settings.secrets_ref);
  row={...row,phase:'admitted',callId:admission.callId,...(admission.status==='completed'?{result:admission.result}:{})};await save(row);
  done({phase:row.phase,callId:row.callId});
}
if(phase==='bind'){
  if(row.phase==='admitted'){
    await ctx.send(`${label}Bind`,reporter,registryId,call('bind_async_research_call',{token_id:tokenId,id:row.jobId,
      call_id:row.callId,execution_hash:row.executionHash,version_key:wasmHash,epoch:row.ownerEpoch},0n,230_000_000_000_000n));
    row.phase='bound';await save(row);
  }
  done({phase:row.phase,callId:row.callId});
}
if(phase==='poll'){
  if(!['bound','completed'].includes(row.phase))throw Error('Bind first');
  const result=await client.poll(row.callId);
  if(result.status==='pending')done({phase:'pending',callId:row.callId});
  row={...row,phase:'completed',result};await save(row);done({phase:row.phase,status:result.status,computeCostMicrousd:result.compute_cost??null});
}
if(phase==='settle'){
  if(row.phase!=='completed')throw Error('Poll a finished call first');
  const result=row.result,output=result.status==='failed'?null:(typeof result.output==='string'?JSON.parse(result.output):result.output);
  const compute=Number(result.compute_cost);
  if(result.call_id!==row.callId||!Number.isSafeInteger(compute)||compute<0||compute>30000)throw Error('Hosted result identity or compute cost changed');
  await ctx.send(`${label}Settle`,reporter,registryId,call('settle_async_research_job',{token_id:tokenId,id:row.jobId,call_id:row.callId,
    execution_hash:row.executionHash,version_key:wasmHash,epoch:row.ownerEpoch,output,compute_cost_microusd:compute},0n,230_000_000_000_000n));
  row.phase='settled';await save(row);done({phase:row.phase,accepted:output?.status==='ok',outputHash:output?.outputHash??null});
}
if(phase==='verify'){
  const job=await until(()=>sdk.getServiceJob(tokenId,row.jobId),v=>['FINALIZED','FAILED'].includes(v?.job?.status),'Settled job');
  const output=row.result.status==='failed'?null:(typeof row.result.output==='string'?JSON.parse(row.result.output):row.result.output);
  const usage=await sdk.view(registryId,'research_usage',{token_id:tokenId,id:row.jobId});
  const evidence={checkedAt:new Date().toISOString(),network:'NEAR testnet',tokenId,name:'Caleb',owner:identity.ownerAccountId,
    customer:bob.id,label,question:QUESTIONS[label].question,jobId:row.jobId,status:job.job.status,outputHash:output?.outputHash??null,
    fault:output?.fault??null,priorWork:row.execution.context.priorWork,pricedUsageMicrousd:usage?.priced_usage_microusd??null,
    feeYocto:row.quote.feeYocto,incomeYocto:await sdk.getAgentIncome(tokenId),callId:row.callId,
    transactions:Object.fromEntries(Object.entries(ctx.evidence.steps).filter(([k])=>k.startsWith(label)).map(([k,v])=>[k,{hash:v.hash,failed:v.outcome?.failed}])),
    trust:'The restricted operator reports the HTTPS result; on-chain checks bind job, runtime, epoch, output and cost cap.'};
  await writeFile(`docs/evidence/caleb-research-${label}.json`,JSON.stringify(evidence,null,2)+'\n');
  row.phase='verified';await save(row);done({phase:row.phase,jobId:row.jobId,status:job.job.status,outputHash:evidence.outputHash});
}
