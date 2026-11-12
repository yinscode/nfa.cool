import {profileLink} from './profile-link.mjs';
import {nearDisplay,walletCanceled} from './launch-state.mjs';
import {transactionHashes,quoteExpired} from './studio-flow.mjs';
const $=id=>document.getElementById(id);
export const serviceSamples={scout:{question:'How does the agent retain its treasury?',sources:[{title:'Vault',url:'https://example.org/vault',text:'The agent retains its treasury in the same NEAR vault after the NFT transfers to its new owner.'}]},compare:{question:'Which option has cost and speed evidence?',criteria:['cost','speed'],sources:[{title:'Option A',url:'https://example.org/a',text:'The cost of option A is five units per run. The speed of option A is two seconds per run.'},{title:'Option B',url:'https://example.org/b',text:'The cost of option B is seven units for a single run.'}]}};
export function startProfile({api,config,wallet,review,navigate,escape:esc}){
  let snapshot=null,quote=null,busy=false;
  const token=()=>$('token-id').value.trim();
  const key=()=>`nfa-public-checkout:${config.registryAccountId}:${config.workspace?.id||'testnet'}:${token()}:${wallet()?.accountId||'guest'}`;
  const saved=()=>{try{return JSON.parse(localStorage.getItem(key())||'null')}catch{return null}};
  const save=value=>localStorage.setItem(key(),JSON.stringify(value));
  const note=(id,text)=>{$(id).textContent=text};
  const pair=(label,value)=>`<dt>${esc(label)}</dt><dd>${esc(value??'Unavailable')}</dd>`;
  function inputChanged(){quote=null;$('profile-pay').classList.add('hidden')}
  function fillInput(input){
    $('profile-question').value=input.question||'';
    for(const [i,suffix] of [[0,''],[1,'2']]){const source=input.sources?.[i]||{};
      $('profile-title'+suffix).value=source.title||'';$('profile-url'+suffix).value=source.url||'';$('profile-text'+suffix).value=source.text||'';
    }
    $('profile-criteria').value=(input.criteria||['cost','speed']).join(', ');
    $('profile-input').value=JSON.stringify(input,null,2);
    $('profile-compare-fields').classList.toggle('hidden',$('profile-service').value!=='compare');
  }
  function typedInput(){if($('profile-use-json').checked)return JSON.parse($('profile-input').value);
    const input={question:$('profile-question').value,sources:[{title:$('profile-title').value,url:$('profile-url').value,text:$('profile-text').value}]};
    if($('profile-service').value==='compare'){input.criteria=$('profile-criteria').value.split(',').map(s=>s.trim()).filter(Boolean);
      input.sources.push({title:$('profile-title2').value,url:$('profile-url2').value,text:$('profile-text2').value})}
    return input;
  }
  $('profile-service').onchange=()=>{fillInput(serviceSamples[$('profile-service').value]);inputChanged();describe()};
  for(const field of ['profile-question','profile-title','profile-url','profile-text','profile-criteria','profile-title2','profile-url2','profile-text2','profile-use-json'])$(field).oninput=inputChanged;
  $('profile-input').oninput=inputChanged;
  function describe(){const service=$('profile-service').value,p=snapshot?.policies?.[service],available=snapshot?.availability?.find(s=>s.id===service);
    $('profile-service-description').innerHTML=`<p>${service==='scout'?'Cited findings from supplied documents.':'Compare supplied options by evidence coverage.'}</p><p>${p?.enabled?'Enabled':'Not configured'}${p?` · NFA earnings floor ${esc(nearDisplay(p.min_margin))} NEAR per job`:''}</p><p class="small">${config.readOnly?'Public testnet viewer. Checkout needs a connected, working testnet API.':available?.available?'Get a fresh quote before paying.':esc(available?.reason||'Service availability will be checked before quoting.')}</p>`;
    $('profile-quote').disabled=!!config.readOnly||!snapshot||!p?.enabled;
  }
  async function reconcile(){
    const state=saved();if(!state)return;
    const params=new URLSearchParams(location.search);
    if(params.has('errorCode')&&walletCanceled({code:params.get('errorCode'),message:params.get('errorMessage')})){state.pending=null;save(state);history.replaceState(null,'',profileLink(location.origin,token(),config));note('profile-job-status','Wallet action canceled. No new payment was sent.')}
    const hash=params.get('transactionHashes')?.split(',')[0]||$('profile-tx-hash').value.trim();
    if(hash&&state.pending)state[state.pending==='payment'?'paymentHash':'startHash']=hash;
    save(state);
    if(state.pending){
      const hash=state.pending==='payment'?state.paymentHash:state.startHash;
      if(!hash){note('profile-job-status','Wallet outcome unresolved. Inspect the original transaction in Studio before retrying.');return state}
      const receipt=await api('/studio/transactions/inspect',{tokenId:token(),hash,sender:state.sender});
      if(receipt.status==='PENDING')return state;
      if(receipt.status==='FAILED'){state.failed=state.pending;state.pending=null;save(state);throw Error('The transaction failed definitively. Its receipt is saved; refresh state before another payment.')}
      if(state.pending==='payment'){
        if(!Number.isSafeInteger(receipt.assignedJobId))throw Error('No assigned job ID in this payment receipt');
        const committed=await api(`/v1/nfas/${token()}/services/${state.service}/jobs/${receipt.assignedJobId}`);
        const job=committed.job;
        if(!job||job.input_hash!==state.quote.inputHash||job.requester!==state.sender||job.version_key!==state.quote.versionKey||job.fee!==state.quote.feeYocto)throw Error('Receipt differs from the reviewed quote');
        state.jobId=receipt.assignedJobId;
      }
      if(state.pending==='start'&&!receipt.events.some(e=>e.event==='service_job_started'&&e.data.id===state.jobId))throw Error('Start receipt belongs to another job');
      state.pending=null;save(state);history.replaceState(null,'',profileLink(location.origin,token(),config));
    }
    if(state.jobId){
      $('profile-job-id').value=state.jobId;
      const record=await api(`/v1/nfas/${token()}/services/${state.service}/jobs/${state.jobId}`),job=record.job||record.paid||record;
      state.status=job.status;save(state);$('profile-result').textContent=JSON.stringify(record,null,2);$('profile-result-summary').innerHTML=`<dl class="kv">${pair('Service',state.service)}${pair('Job',state.jobId)}${pair('Status',job.status)}${pair('Output commitment',job.output_hash||'Not finalized yet')}</dl>`;
      note('profile-job-status',job.status==='FINALIZED'?`Job #${state.jobId} finalized. Output commitment: ${job.output_hash}`:job.status==='FAILED'?'Service failed definitively. The customer refund is a separate payout credit.':`Job #${state.jobId}: ${job.status||'Awaiting confirmation'}`);
      $('profile-start').classList.toggle('hidden',job.status!=='REQUESTED'||!!state.pending);
      $('profile-refresh-job').classList.remove('hidden');
    }
    return state;
  }
  async function load(){try{
    note('profile-status','Loading finalized agent state…');
    snapshot=await api('/studio/nfas/'+token());let manifest=null;try{manifest=await api('/studio/nfas/'+token()+'/manifest')}catch{}
    const i=snapshot.identity,c=manifest?.publicCharacter;
    const image=c?.imageUri?.startsWith('https://test.fastfs.io/')?c.imageUri:c?.imageUri?.startsWith('nfa://image/')?'/studio/artifacts/'+c.imageHash.slice(7)+'.png':null;
    $('passport-content').innerHTML=`<div class="card profile-identity">${image?`<img class="profile-character" src="${esc(image)}" alt="NFA character">`:''}<h2>${esc(manifest?.displayName||token())}</h2><p>${esc(manifest?.description||'A transferable agent account with reviewed services.')}</p><span class="badge">${esc(i.lifecycle)}</span><dl class="kv">${pair('NFT',token())}${pair('Owner',i.ownerAccountId)}${pair('Vault',i.vaultAccountId)}${pair('OutLayer UUID',snapshot.project?.project_uuid)}${pair('Unclaimed income',nearDisplay(i.income)+' NEAR')}</dl><button id="profile-copy" class="secondary">Copy public link</button></div><div class="card"><h2>Services &amp; ownership</h2>${['scout','compare'].map(s=>`<p><b>${s==='scout'?'Research':'Comparison'}</b> · ${snapshot.policies?.[s]?.enabled?'Enabled':'Not enabled'}</p>`).join('')}<p>The vault, approved runtime, finalized work and unclaimed income stay with this NFT. Personal credentials do not transfer.</p><button id="profile-manage" class="secondary">Open in Studio</button></div>`;
    $('profile-copy').onclick=async()=>{try{await navigator.clipboard.writeText(profileLink(location.origin,token(),config));note('profile-status','Public link copied')}catch{note('profile-status',profileLink(location.origin,token(),config))}};
    $('profile-manage').onclick=()=>{navigate('studio',token());window.dispatchEvent(new CustomEvent('nfa-open-token',{detail:token()}))};
    const economics=snapshot.economics;
    $('passport-content').insertAdjacentHTML('beforeend',`<div class="card"><h2>Business history</h2><dl class="kv">${pair('Customer revenue',economics?.grossCustomerReceipts==null?'Unavailable':nearDisplay(economics.grossCustomerReceipts)+' NEAR')}${pair('Credited service earnings',economics?.creditedServiceEarnings==null?'Unavailable':nearDisplay(economics.creditedServiceEarnings)+' NEAR')}${pair('Execution replenishment',economics?.executionReplenishment==null?'Unavailable':nearDisplay(economics.executionReplenishment)+' NEAR')}${pair('Net profit','Not yet measured')}${pair('History coverage',economics?.coverage==='complete_job_history'?'Complete recorded history':'Partial or unavailable')}</dl><p class="small">Execution replenishment is a reserve, not measured compute cost. Prefunding and NFT sale proceeds are separate from service revenue.</p></div>`);
    const jobs=(snapshot.jobs||[]).filter(row=>row.service?.job.status==='FINALIZED');
    $('profile-work').innerHTML=jobs.map(row=>`<p><b>${esc(row.service.service_id)} #${row.id}</b><br><span class="small">${esc(row.service.job.output_hash)}<br>Runtime ${esc(row.service.job.version_key)}</span></p>`).join('')||'<p>No finalized service jobs in this page.</p>';
    const prior=saved();if(prior?.jobId&&prior.quote){$('profile-service').value=prior.service;fillInput(JSON.parse(prior.quote.inputData))}
    note('profile-status',snapshot.readOnlyReason||'Identity and service policies loaded from finalized chain state.');describe();await reconcile();
  }catch(error){note('profile-status',error.message)}}
  $('load-passport').onclick=load;
  $('profile-quote').onclick=async()=>{try{
    const current=saved();if(current?.pending||current?.jobId&&!['FINALIZED','FAILED'].includes(current.status))throw Error('Complete or inspect your existing paid job first');
    quote=await api(`/v1/nfas/${token()}/services/${$('profile-service').value}/quotes`,{input:typedInput()});
    $('profile-price').innerHTML=`<dl class="kv">${pair('Total customer fee',nearDisplay(quote.feeYocto)+' NEAR')}${pair('Execution reserve',nearDisplay(quote.replenishYocto)+' NEAR')}${pair('NFA earnings',nearDisplay((BigInt(quote.feeYocto)-BigInt(quote.replenishYocto)).toString())+' NEAR')}</dl><p class="small">Quote binds the current runtime, policy version and exact supplied input.</p>`;
    $('profile-pay').classList.remove('hidden');note('profile-job-status','Quote ready. Review the exact payment before signing.');
  }catch(e){note('profile-job-status',e.message)}};
  async function transact(kind){if(busy)return;busy=true;try{
    if(!wallet()?.accountId)throw Error('Connect a customer wallet');let state=saved(),action;
    if(kind==='payment'){
      if(quoteExpired(quote))throw Error('Get a fresh quote');if(state?.pending||state?.jobId&&!['FINALIZED','FAILED'].includes(state.status))throw Error('Resolve your existing job before paying again');
      state={service:quote.service,quote,sender:wallet().accountId};action=quote.unsignedAction;
    }else{
      if(!state?.jobId||state.pending)throw Error('Reconcile the existing payment first');
      action=(await api(`/v1/nfas/${token()}/services/${state.service}/jobs/${state.jobId}/prepare-start`,{inputData:state.quote.inputData})).unsignedAction;
    }
    const result=await review(action,kind==='payment'?`Pay for ${state.service}`:`Start ${state.service} #${state.jobId}`,{beforeSign:()=>{state.pending=kind;save(state)}});
    if(result){const hash=transactionHashes(result)[0];if(hash){state[kind==='payment'?'paymentHash':'startHash']=hash;save(state)}}
    await reconcile();
  }catch(e){if(walletCanceled(e)){const state=saved();if(state){state.pending=null;save(state)}}note('profile-job-status',e.message)}finally{busy=false}}
  $('profile-inspect').onclick=()=>reconcile().catch(e=>note('profile-job-status',e.message));
  $('profile-pay').onclick=()=>transact('payment');$('profile-start').onclick=()=>transact('start');$('profile-refresh-job').onclick=()=>reconcile().catch(e=>note('profile-job-status',e.message));
  window.addEventListener('nfa-wallet-changed',()=>{if(!$('passport').classList.contains('hidden')){quote=null;$('profile-job-id').value='';$('profile-start').classList.add('hidden');$('profile-pay').classList.add('hidden');load()}});
  $('profile-service').onchange();
  window.addEventListener('nfa-profile',event=>{$('token-id').value=event.detail;navigate('passport',event.detail);load()});
  if(location.pathname.startsWith('/nfa/')){$('token-id').value=location.pathname.split('/')[2];load()}
  return {load};
}
