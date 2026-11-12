#!/usr/bin/env node
// Read-only operator snapshot. Never advances a job or releases escrow.
import {NfaSdk} from '@nfa/sdk';
import {KeeperJournal} from '../services/worker/keeper-journal.mjs';
import {reconcileKeeperIntent} from '../services/worker/outlayer-keeper.mjs';

const [tokenId,rawJobId]=process.argv.slice(2);
const jobId=Number(rawJobId);
if(!/^nfa-[1-9][0-9]*$/.test(tokenId||'')||!Number.isSafeInteger(jobId)||jobId<1){
  console.error('Usage: node scripts/inspect-outlayer-job.mjs nfa-1 3');
  process.exit(2);
}
const sdk=new NfaSdk({registryAccountId:process.env.NFA_REGISTRY_ID||'nfagent-registry-0e9b2a.testnet',
  rpcUrl:process.env.NEAR_RPC_URL||'https://rpc.testnet.near.org'});
try{
  const [job,project,agent]=await Promise.all([sdk.getServiceJob(tokenId,jobId),
    sdk.getOutlayerProject(tokenId),sdk.getAgentState(tokenId)]);
  let keeper=null;
  if(process.env.NFA_KEEPER_JOURNAL_DIR){
    const journal=new KeeperJournal(process.env.NFA_KEEPER_JOURNAL_DIR);
    try{keeper=await reconcileKeeperIntent({sdk,journal,tokenId,jobId})}
    catch(error){if(error.code!=='ENOENT')throw error}
  }
  console.log(JSON.stringify({tokenId,jobId,job,project,agent,keeper},null,2));
}catch(error){console.error(error.message);process.exitCode=1}
