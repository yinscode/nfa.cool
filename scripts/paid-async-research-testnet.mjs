#!/usr/bin/env node
// Journaled paid Research acceptance. Submit is one-shot; an unknown POST is never retried.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {parseEnv} from 'node:util';
import {createHash} from 'node:crypto';
import {transactions,KeyPair,keyStores,connect} from 'near-api-js';
import {NfaSdk} from '@nfa/sdk';
import {testnet,pause} from './testnet-lib.mjs';
import {quoteService} from '../services/api/service-runtime.mjs';
import {OutlayerHttpsAsync,paymentKeyOwner} from '../services/worker/outlayer-https-async.mjs';

const label=process.argv[2],phase=process.argv[3];
if(!/^(first|buyer)(?:[2-9][0-9]*)?$/.test(label??'')||
  !['pay','prepare','submit','bind','poll','settle','verify'].includes(phase))
  throw Error('Use first|first2|buyer|buyer2 pay|prepare|submit|bind|poll|settle|verify');
const registryId='nfagent-registry-0e9b2a.testnet',tokenId='nfa-2';
const wasmHash='a8513acd137f37ce21a820e8d2e9b92b9712970e3c3710b41a4e26df06137588';
const sha=b=>'sha256:'+createHash('sha256').update(b).digest('hex');
const privatePath=`.data/paid-async-research-${label}.private.json`;
const ctx=await testnet('deployments/paid-async-research.json');
const registry=await ctx.signer('t006-registry'),operator=await ctx.signer('t004-operator'),
  alice=await ctx.signer('t006-alice'),bob=await ctx.signer('t008-bob'),
  funder=await ctx.signer('studio-funder');
if(registry.id!==registryId)throw Error('Registry mismatch');
const sdk=new NfaSdk({registryAccountId:registryId,rpcUrl:ctx.rpcUrl});
const restricted=JSON.parse(await readFile('deployments/reporter-async-research.key.json'));
if(restricted.account_id!==operator.id||restricted.receiver_id!==registryId||
  JSON.stringify(restricted.method_names)!==JSON.stringify(['bind_async_research_call','settle_async_research_job']))
  throw Error('Restricted async reporter key changed');
const reporterStore=new keyStores.InMemoryKeyStore();
await reporterStore.setKey('testnet',operator.id,KeyPair.fromString(restricted.secret_key));
const reporterNode=await connect({networkId:'testnet',nodeUrl:ctx.rpcUrl,deps:{keyStore:reporterStore}});
const reporter={id:operator.id,account:await reporterNode.account(operator.id)};
const identity=await sdk.get(tokenId),project=await sdk.getOutlayerProject(tokenId),
  agent=await sdk.getAgentState(tokenId),setup=await sdk.view(registryId,'payment_key_setup',{token_id:tokenId});
const sellerJob=label.startsWith('first'),customer=sellerJob?funder:bob;
if(identity.ownerAccountId!==(sellerJob?alice.id:bob.id)||
  project.version_key!==wasmHash||project.state!=='READY'||setup?.state!=='READY')
  throw Error('Expected owner, runtime or Payment Key changed');
const keyPackage=JSON.parse(await readFile('.data/outlayer-payment-key-nfa-2.private.json'));
if(paymentKeyOwner(keyPackage.apiKey)!==identity.vaultAccountId||
  keyPackage.nonce!==setup.nonce||keyPackage.projectIds?.[0]!==project.project_id)
  throw Error('Vault-owned Payment Key changed');
const env=parseEnv(await readFile('.env.research','utf8'));
if(env.NFA_RESEARCH_PROVIDER!=='near-ai'||!env.NFA_RESEARCH_API_KEY||!env.NFA_RESEARCH_MODEL)
  throw Error('Dedicated near-ai credential/model required');
const model=await sdk.getResearchConfig(tokenId);
if(model?.settings?.version_key!==wasmHash||
  ![env.NFA_RESEARCH_MODEL,'openai/gpt-4.1-mini'].includes(model.settings.model)||
  model.settings.secrets_ref.profile!=='research-v8')throw Error('Pinned model configuration changed');
const client=new OutlayerHttpsAsync({paymentKey:keyPackage.apiKey,vaultId:identity.vaultAccountId,
  projectId:project.project_id,versionKey:wasmHash,computeLimitMicrousd:30000,
  executionLimitSeconds:90});
const read=async()=>{try{return JSON.parse(await readFile(privatePath,'utf8'))}
  catch(error){if(error.code==='ENOENT')return null;throw error}};
const save=async value=>{await mkdir('.data',{recursive:true});await writeFile(privatePath,JSON.stringify(value,null,2)+'\n',{mode:0o600})};
const until=async(work,check)=>{for(let i=0;i<80;i++){const v=await work();if(check(v))return v;await pause(500)}
  throw Error('Final state not observed; inspect private journal')};
const call=(method,args,deposit='0')=>[transactions.functionCall(method,Buffer.from(JSON.stringify(args)),
  230_000_000_000_000n,BigInt(deposit))];
const transact=(name,who,a)=>ctx.send(name,who,a.receiverId,[transactions.functionCall(
  a.methodName,a.args,BigInt(a.gas),BigInt(a.deposit))]);
let row=await read();
if(phase==='pay'){
  if(row)throw Error('Paid Research journal already exists; resume from its phase');
  if(agent.pending_op!=null||agent.lifecycle!=='Active')throw Error('NFA is busy');
  const input={question:sellerJob?'How do NEAR access keys authorize actions?':
    'How do the prior findings about NEAR access keys help explain NFA ownership transfer?',
    sources:[{title:'NEAR access keys',url:'https://docs.near.org/protocol/accounts-contracts/access-keys'}]};
  const policy=await sdk.getServicePolicy(tokenId,'research');
  const quote=await quoteService({sdk,tokenId,service:'research',body:{input},
    policy:{research:{limits:policy.limits,marginYocto:policy.min_margin,maxDepositYocto:policy.max_deposit}},
    allowResearchCandidate:true});
  if(quote.transport!=='https-async'||quote.versionKey!==wasmHash||
    quote.computeLimitMicrousd!=='30000'||quote.httpsExecutionLimitSeconds!==90)
    throw Error('Quote is not exact async Research');
  await save({label,phase:'pay_pending',inputData:quote.inputData,inputHash:quote.inputHash,
    quote,owner:identity.ownerAccountId,ownerEpoch:identity.ownerEpoch,projectUuid:project.project_uuid});
  await transact(`${label}ResearchPay`,customer,quote.unsignedAction);
  const jobId=ctx.evidence.steps[`${label}ResearchPay`].outcome.value;
  if(!Number.isSafeInteger(jobId)||jobId<1)throw Error('Paid job ID missing');
  row={...await read(),jobId,phase:'paid'};await save(row);
  console.log(JSON.stringify({phase:row.phase,label,jobId,feeYocto:quote.feeYocto}));
  process.exit(0);
}
if(!row||row.label!==label||row.ownerEpoch!==identity.ownerEpoch||
  row.projectUuid!==project.project_uuid)throw Error('Paid Research journal or ownership changed');
if(phase==='prepare'){
  if(row.phase!=='paid'&&row.phase!=='prepared')throw Error('Prepare phase changed');
  if(row.phase==='paid'){
    const a=sdk.prepareAsyncResearchJob(tokenId,row.jobId,row.inputData);
    const result=await transact(`${label}ResearchPrepare`,customer,a);
    if(typeof result.value!=='string')throw Error('Prepared execution missing');
    const execution=JSON.parse(result.value),executionHash=sha(result.value);
    if(execution.jobId!==row.jobId||execution.service!=='research'||
      execution.context?.vaultAccountId!==identity.vaultAccountId||
      execution.context?.ownerEpoch!==identity.ownerEpoch||
      execution.research?.settings?.version_key!==wasmHash||
      execution.research?.configuration_hash!==model.configuration_hash)
      throw Error('Prepared execution differs from pinned paid job');
    if(!sellerJob){
      const prior=JSON.parse(await readFile('docs/evidence/paid-async-research-seller.json'));
      if(!execution.context.priorWork?.some(p=>p.jobId===prior.jobId&&p.outputHash===prior.outputHash))
        throw Error('Buyer continuation omitted the seller-era finalized Research commitment');
    }
    row={...row,phase:'prepared',execution,executionHash};await save(row);
  }
  console.log(JSON.stringify({phase:row.phase,label,jobId:row.jobId,executionHash:row.executionHash}));
  process.exit(0);
}
if(!row.execution||row.executionHash!==sha(JSON.stringify(row.execution)))
  throw Error('Prepared execution is missing or changed');
const onchain=await sdk.view(registryId,'async_research_job',{token_id:tokenId,id:row.jobId});
if(onchain?.execution_hash!==row.executionHash)throw Error('On-chain execution hash differs');
if(phase==='submit'){
  if(row.phase!=='prepared')throw Error('Submission already attempted or phase changed');
  const balance=await fetch(`https://testnet-api.outlayer.ai/public/payment-keys/${identity.vaultAccountId}/${setup.nonce}/balance`,
    {signal:AbortSignal.timeout(15000)});
  if(!balance.ok||Number((await balance.json()).available)<30000)throw Error('Payment Key balance below 30,000 microUSD');
  row.phase='submission_unknown';await save(row);
  const admission=await client.submit(row.execution,model.settings.secrets_ref);
  row={...row,phase:'admitted',callId:admission.callId,admissionStatus:admission.status,
    ...(admission.status==='completed'?{result:admission.result}:{})};await save(row);
  console.log(JSON.stringify({phase:row.phase,label,jobId:row.jobId,callId:row.callId}));
  process.exit(0);
}
if(phase==='bind'){
  if(!row.callId||!['admitted','bound','completed'].includes(row.phase))throw Error('Admitted call required');
  if(row.phase==='admitted'){
    await ctx.send(`${label}ResearchBind`,reporter,registryId,call('bind_async_research_call',{
      token_id:tokenId,id:row.jobId,call_id:row.callId,execution_hash:row.executionHash,
      version_key:wasmHash,epoch:row.ownerEpoch}));
    row.phase='bound';await save(row);
  }
  console.log(JSON.stringify({phase:row.phase,label,callId:row.callId}));process.exit(0);
}
if(phase==='poll'){
  if(!row.callId||!['bound','completed'].includes(row.phase))throw Error('Bound call required');
  const result=await client.poll(row.callId);
  if(result.status==='pending'){console.log(JSON.stringify({phase:'pending',label,callId:row.callId}));process.exit(0)}
  row={...row,phase:'completed',result};await save(row);
  console.log(JSON.stringify({phase:row.phase,label,callId:row.callId,status:result.status,
    computeCostMicrousd:result.compute_cost??null}));process.exit(0);
}
if(phase==='settle'){
  if(row.phase!=='completed'||!['completed','failed'].includes(row.result?.status))
    throw Error('Finished hosted call required');
  const result=row.result,output=result.status==='failed'?null:
    (typeof result.output==='string'?JSON.parse(result.output):result.output);
  const compute=Number(result.compute_cost);
  if(result.call_id!==row.callId||!Number.isSafeInteger(compute)||compute<0||compute>30000||
    (result.status==='completed'&&(output?.schemaVersion!==1||output?.jobId!==row.jobId||
    !['ok','failed'].includes(output.status))))throw Error('Hosted result identity or compute cost changed');
  await ctx.send(`${label}ResearchSettle`,reporter,registryId,call('settle_async_research_job',{
    token_id:tokenId,id:row.jobId,call_id:row.callId,execution_hash:row.executionHash,
    version_key:wasmHash,epoch:row.ownerEpoch,output,compute_cost_microusd:compute}));
  row.phase='settled';await save(row);
  console.log(JSON.stringify({phase:row.phase,label,jobId:row.jobId,accepted:output?.status==='ok',
    outputHash:output?.outputHash??null}));process.exit(0);
}
if(phase==='verify'){
  if(row.phase!=='settled'&&row.phase!=='verified')throw Error('Settled job required');
  const job=await until(()=>sdk.getServiceJob(tokenId,row.jobId),v=>['FINALIZED','FAILED'].includes(v?.job?.status));
  const record=await sdk.view(registryId,'async_research_job',{token_id:tokenId,id:row.jobId});
  const usage=await sdk.view(registryId,'research_usage',{token_id:tokenId,id:row.jobId}),
    income=await sdk.getAgentIncome(tokenId);
  const output=row.result.status==='failed'?null:
    (typeof row.result.output==='string'?JSON.parse(row.result.output):row.result.output);
  if(row.result.call_id!==record.call_id)throw Error('Settled call ID changed');
  const accepted=job.job.status==='FINALIZED'&&record.state==='FINALIZED'&&
    usage.state==='PRICED_USAGE'&&job.job.output_hash===output?.outputHash;
  if(!accepted&&(job.job.status!=='FAILED'||record.state!=='FAILED'||
    !(output?.status==='failed'||row.result.status==='failed')))
    throw Error('Paid Research settlement is inconsistent');
  const publicEvidence={checkedAt:new Date().toISOString(),network:'NEAR testnet',label,tokenId,
    owner:row.owner,ownerEpoch:row.ownerEpoch,projectUuid:row.projectUuid,jobId:row.jobId,
    inputHash:row.inputHash,executionHash:row.executionHash,callId:row.callId,
    priorWorkCommitments:(row.execution.context?.priorWork??[]).map(p=>({jobId:p.jobId,outputHash:p.outputHash})),
    status:job.job.status,fault:output?.fault??'operator',outputHash:output?.outputHash??null,
    pricedUsageMicrousd:usage.priced_usage_microusd,
    computeCostMicrousd:record.compute_cost_microusd,feeYocto:row.quote.feeYocto,
    incomeYocto:income,attestationUrl:row.result.attestation_url??null,
    transactions:Object.fromEntries(Object.entries(ctx.evidence.steps).filter(([k])=>k.startsWith(label))
      .map(([k,v])=>[k,{hash:v.hash,failed:v.outcome?.failed}])),
    trust:'The restricted operator reports the HTTPS result; on-chain checks bind job, runtime, epoch, output and cap. No on-chain OutLayer attestation verification.'};
  await writeFile(`docs/evidence/paid-async-research-${label}.json`,JSON.stringify(publicEvidence,null,2)+'\n');
  if(accepted)await writeFile(`docs/evidence/paid-async-research-${sellerJob?'seller':'buyer-accepted'}.json`,
    JSON.stringify(publicEvidence,null,2)+'\n');
  row.phase='verified';await save(row);
  console.log(JSON.stringify({phase:row.phase,label,jobId:row.jobId,status:job.job.status,
    outputHash:output?.outputHash??null,
    pricedUsageMicrousd:usage.priced_usage_microusd,incomeYocto:income}));
}
