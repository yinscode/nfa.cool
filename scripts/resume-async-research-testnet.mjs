#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import {transactions} from 'near-api-js';
import {NfaSdk} from '@nfa/sdk';
import {testnet,pause} from './testnet-lib.mjs';
const label=process.argv[2];if(!/^(first|buyer)(?:[2-9][0-9]*)?$/.test(label??''))throw Error('Failed Research label required');
const evidence=JSON.parse(await readFile(`docs/evidence/paid-async-research-${label}.json`));
if(evidence.status!=='FAILED')throw Error('Failed Research job required');
const ctx=await testnet('deployments/paid-async-research.json'),owner=await ctx.signer(label.startsWith('first')?'t006-alice':'t008-bob');
const sdk=new NfaSdk({registryAccountId:'nfagent-registry-0e9b2a.testnet',rpcUrl:ctx.rpcUrl});
const agent=await sdk.getAgentState('nfa-2');
if(agent.lifecycle==='Active'){console.log(JSON.stringify({alreadyActive:true,label}));process.exit(0)}
const pending=await sdk.view(sdk.registryAccountId,'service_resume',{token_id:'nfa-2'});
if(agent.lifecycle!=='Draining'||(agent.pending_op!=null&&
  (pending?.id!==agent.pending_op||pending.failed_job_id!==evidence.jobId)))
  throw Error('Failed NFA state differs');
const step=ctx.evidence.steps[`${label}ResearchResume`]?.outcome?
  `${label}ResearchResumeRetry`:`${label}ResearchResume`;
await ctx.send(step,owner,sdk.registryAccountId,[transactions.functionCall(
  'resume_failed_service',Buffer.from(JSON.stringify({token_id:'nfa-2',failed_job_id:evidence.jobId})),
  100_000_000_000_000n,1n)]);
for(let i=0;i<80;i++){if((await sdk.getAgentState('nfa-2')).lifecycle==='Active'){
  console.log(JSON.stringify({resumed:true,label,jobId:evidence.jobId}));process.exit(0)}await pause(500)}
throw Error('Resume not observed; inspect journal');
