import {NfaServicesClient} from '@nfa/sdk';

/** Inject wallet adapters and a durable checkpoint; this example contains no private keys. */
export async function createAndRun({sdk,baseUrl,ownerId,ownerWallet,customerId,customerWallet,
  requestId,displayName,input,maxCustomerFeeYocto,checkpoint}){
  if(!requestId||!checkpoint?.load||!checkpoint?.save||!maxCustomerFeeYocto)throw Error('Stable request ID, durable checkpoint and fee cap required');
  const api=new NfaServicesClient({baseUrl});
  const config=await api.request('/config');
  if(config.registryAccountId!==sdk.registryAccountId)throw Error('API and SDK registries differ');
  const state=await checkpoint.load()||{requestId,ownerId,registry:sdk.registryAccountId,baseUrl,steps:{}};
  if(state.requestId!==requestId||state.ownerId!==ownerId||state.registry!==sdk.registryAccountId||state.baseUrl!==baseUrl)throw Error('Checkpoint belongs to another creation request');
  const save=()=>checkpoint.save(state);
  async function sendOnce(label,action,wallet,sender,inspect){
    let step=state.steps[label];
    if(step&&JSON.stringify(step.action)!==JSON.stringify(action))throw Error('Saved action differs; inspect checkpoint');
    if(step?.confirmed)return step.confirmed;
    if(!step){step=state.steps[label]={action,claimed:true};await save();
      const result=await wallet.signAndSendTransaction(action);
      step.hash=result?.transaction?.hash||result?.transaction_outcome?.id;
      await save();
    }
    if(!step.hash)throw Error('Submission outcome is unknown; inspect wallet history and save its exact hash before continuing');
    const receipt=await inspect(step.hash,sender);
    if(receipt.status!=='SUCCEEDED')throw Error('Action is not finalized successfully; inspect before retrying');
    step.confirmed=receipt;await save();
    return receipt;
  }
  const inspectLaunch=action=>(hash,sender)=>api.request('/studio/launch/inspect',{hash,sender,action});
  let lookup=await api.request(`/requests?owner=${encodeURIComponent(ownerId)}&requestId=${encodeURIComponent(requestId)}`);
  if(!lookup.tokenId){
    if(!state.manifest){
      const preview=await api.request('/preview',{seed:requestId,traits:{body:'sphere',eyewear:'round-wire',attachment:'none',hat:'none',ornament:'none'}});
      state.manifest=await api.request('/manifests',{previewKey:preview.key,displayName,templateId:'scout'});await save();
    }
    const action=sdk.create({requestId,manifestHash:state.manifest.manifestHash,manifestUri:state.manifest.manifestUri});
    await sendOnce('mint',action,ownerWallet,ownerId,inspectLaunch(action));
    lookup=await api.request(`/requests?owner=${encodeURIComponent(ownerId)}&requestId=${encodeURIComponent(requestId)}`);
  }
  if(!lookup.minted)throw Error('Mint is awaiting finalized provisioning; rerun using the same checkpoint');
  const tokenId=lookup.tokenId,identity=await sdk.get(tokenId);
  if(identity.ownerAccountId!==ownerId)throw Error('Creator no longer owns this NFA');
  let project=await sdk.getOutlayerProject(tokenId);
  if(!project){
    if(!state.release){state.release=(await api.request('/studio/releases')).releases.find(r=>r.hostedStatus==='verified'&&r.services.includes('scout'));await save()}
    if(!state.release)throw Error('No reviewed hosted release');
    if(!config.localSandbox)await api.request('/studio/releases/verify',{versionKey:state.release.versionKey});
    const action=sdk.provisionOutlayer(tokenId,state.release.url,state.release.versionKey,'100000000000000000000000');
    await sendOnce('project',action,ownerWallet,ownerId,inspectLaunch(action));project=await sdk.getOutlayerProject(tokenId);
  }
  if(project?.state!=='READY')throw Error('Project setup is unresolved; inspect before continuing');
  const policy=await sdk.getServicePolicy(tokenId,'scout');
  if(!policy){
    const pkg=(await api.request('/v1/service-packages')).items.find(p=>p.id==='scout');
    const action=sdk.configureService(tokenId,'scout',pkg.inputSchemaHash,true,'10000000000000000000000','500000000000000000000000',pkg.limits);
    await sendOnce('policy',action,ownerWallet,ownerId,inspectLaunch(action));
  }
  if(!state.quote){state.quote=await api.quote(tokenId,'scout',input);await save()}
  if(state.quote.inputData!==JSON.stringify({question:input.question,sources:input.sources}))throw Error('Saved paid input differs; use a separate request/checkpoint');
  if(BigInt(state.quote.feeYocto)>BigInt(maxCustomerFeeYocto))throw Error('Quote exceeds customer fee cap');
  const receipt=await sendOnce('payment',state.quote.unsignedAction,customerWallet,customerId,
    async hash=>({status:'SUCCEEDED',...await api.inspectPayment({quote:state.quote,hash,sender:customerId})}));
  const jobId=receipt.jobId,record=await api.job(tokenId,'scout',jobId);
  if(record.service_id!=='scout'||record.policy_version!==state.quote.policyVersion||record.job.requester!==customerId||
    record.job.input_hash!==state.quote.inputHash||record.job.version_key!==state.quote.versionKey||record.job.fee!==state.quote.feeYocto)
    throw Error('Saved assignment differs from the current on-chain job');
  if(record.job.status==='REQUESTED'){
    const action=(await api.prepareStart(tokenId,'scout',jobId,state.quote.inputData)).unsignedAction;
    await sendOnce('start',action,customerWallet,customerId,async(hash,sender)=>{
      const inspected=await api.request('/studio/transactions/inspect',{tokenId,hash,sender});
      if(!inspected.events.some(e=>e.event==='service_job_started'&&e.data.id===jobId))throw Error('Start receipt belongs to another job');return inspected;
    });
  }
  return {tokenId,jobId,...await api.job(tokenId,'scout',jobId)};
}
