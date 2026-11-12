import {nearAmount,nearDisplay,selectedServices,nextLaunchStep,DEFAULT_LIMITS,validateLaunchPlan,walletCanceled} from './launch-state.mjs';
import {transactionHashes} from './studio-flow.mjs';
const $=id=>document.getElementById(id);
const fields=['body','palette','expression','tool','eyewear','attachment','ornament','hat','finish','marking','background','frame'];
const titles=['Purpose','Identity','Services & budget','Review & launch'];
export function startCreation({api,config,wallet,review,navigate,escape:esc}){
  const scope=`${config.registryAccountId}:${config.workspace?.id||config.localSandbox?.instanceId||'legacy'}`;
  const key='nfa-launch-v3:'+scope;
  let plan=null,preview=null,catalog=null,skills=[],releases=[],step=0,next=null,busy=false;
  const note=text=>{$('create-status').textContent=text};
  const save=()=>localStorage.setItem(key,JSON.stringify(plan));
  try{plan=JSON.parse(localStorage.getItem(key)||'null')}catch{}
  plan ||= {id:crypto.randomUUID(),name:'Scout One',description:'',purpose:'scout',seed:crypto.randomUUID().slice(0,12),traits:{},locks:{},margin:'0.01',reserve:'0.2',chainKey:false,receipts:[]};
  const purpose=()=>document.querySelector('input[name="purpose"]:checked').value;
  const traits=()=>Object.fromEntries(fields.map(n=>[n,$('create-'+n).value]));
  function readDraft(){if(plan.active)return;
    Object.assign(plan,{name:$('name').value,description:$('create-description').value,purpose:purpose(),seed:$('seed').value,traits:traits(),
      locks:Object.fromEntries(fields.map(n=>[n,$('create-lock-'+n).checked])),margin:$('create-margin').value,reserve:$('create-reserve').value,chainKey:$('create-chain-key').checked});save();
  }
  function renderSteps(){
    $('create-stepper').innerHTML=titles.map((t,i)=>`<button class="${i===step?'active':''}" data-wizard-step="${i}" ${plan.active&&i!==3?'disabled':''}><span>${i+1}</span>${t}</button>`).join('');
    for(const b of $('create-stepper').querySelectorAll('button'))b.onclick=()=>go(+b.dataset.wizardStep);
    for(const pane of document.querySelectorAll('[data-create-step]'))pane.classList.toggle('hidden',+pane.dataset.createStep!==step);
    $('create-back').disabled=step===0||plan.active;$('create-back').classList.toggle('hidden',step===3&&!!plan.active);
    $('create-next').classList.toggle('hidden',step===3);
    $('create-preview-name').textContent=plan.name||'Your NFA';$('create-preview-purpose').textContent=selectedServices(plan.purpose).map(s=>s==='scout'?'Research':'Comparison').join(' + ');
    $('create-service-summary').innerHTML=selectedServices(plan.purpose).map(s=>`<p><span class="badge">${esc(s)}</span> Reviewed supplied-text service</p>`).join('');
    $('create-review').innerHTML=`<dl class="kv"><dt>Agent</dt><dd>${esc(plan.name)}</dd><dt>Services</dt><dd>${selectedServices(plan.purpose).join(', ')}</dd><dt>Network</dt><dd>${esc(config.network)}</dd><dt>Mint deposit</dt><dd>6 NEAR (5.8 funds the vault including code storage; 0.2 funds registry storage)</dd><dt>Project storage</dt><dd>Up to 0.1 NEAR from the vault</dd><dt>Operating target</dt><dd>${esc(plan.reserve)} NEAR available; only a confirmed shortfall is topped up</dd><dt>NFA earnings</dt><dd>${esc(plan.margin)} NEAR per successful job, plus customer execution reserve</dd></dl><p class="small">Transaction gas is additional. Source inputs and recall summaries are public. New artwork uses the configured API artifact store.</p>`;
    $('create-button').disabled=busy||config.readOnly||config.serverVersion!==3;
    if(config.readOnly)note('The public testnet viewer cannot create agents. Switch back to your workspace.');
  }
  async function go(value){try{
    if(busy)return;readDraft();
    if(plan.active&&value!==3)return;
    if(value>step){if(step===1){if(!plan.name.trim())throw Error('Give your NFA a name');if(!preview)await renderCharacter()}
      if(step===2){if(BigInt(nearAmount(plan.margin))<10n**22n)throw Error('Minimum earnings are 0.01 NEAR per job');const reserve=BigInt(nearAmount(plan.reserve));if(reserve<10n**22n||reserve>10n**25n)throw Error('Choose an operating target between 0.01 and 10 NEAR')}}
    step=Math.max(0,Math.min(3,value));plan.step=step;save();renderSteps();if(step===1&&!preview)await renderCharacter();if(step===3&&plan.active)await sync();
  }catch(error){note(error.message)}}
  async function renderCharacter(){
    if(!catalog)return;readDraft();const result=await api('/preview',{seed:plan.seed,traits:plan.traits});preview=result;
    $('art').innerHTML=`<img src="${esc(result.imageUrl)}" alt="Your NFA character">`;
    $('traits').textContent='Character can be changed later in Studio.';save();
  }
  function draftChanged(){readDraft();preview=null;renderSteps()}
  function randomize(){if(!catalog||plan.active)return;
    $('seed').value=crypto.randomUUID().slice(0,12);
    for(const name of fields){if($('create-lock-'+name).checked)continue;const choices=catalog.traits[name];$('create-'+name).value=choices[Math.floor(Math.random()*choices.length)]}
    let t=traits();const head=['attachment','ornament','hat'].filter(n=>t[n]!=='none');const chosen=head.find(n=>$('create-lock-'+n).checked)||head[0];
    for(const n of head)if(n!==chosen&&!$('create-lock-'+n).checked)$('create-'+n).value='none';
    if($('create-hat').value!=='none'&&!['sphere','capsule'].includes(t.body)){
      if($('create-lock-hat').checked&&!$('create-lock-body').checked)$('create-body').value='sphere';else if(!$('create-lock-hat').checked)$('create-hat').value='none';
    }
    draftChanged();renderCharacter().catch(e=>note(e.message));
  }
  function lockDraft(){for(const element of document.querySelectorAll('#create input:not(#launch-tx-hash),#create textarea,#create-traits select,#randomize,#preview-button'))element.disabled=!!plan.active||element.id==='create-chain-key'&&config.network==='sandbox'}
  function progress(){
    const stages=[['mint','NFT & vault'],['project','OutLayer Project'],...selectedServices(plan.purpose).map(s=>['policy:'+s,s+' service']),['reserve','Operating reserve'],...(plan.chainKey?[['key','Chain identity']]:[])];
    const activeIndex=stages.findIndex(([id])=>id===next?.id);
    $('launch-progress').innerHTML=stages.map(([id,label],i)=>`<p><span class="badge">${next?.ready?'✓':id===next?.id?'Next':activeIndex>=0&&i<activeIndex?'✓':'·'}</span> ${esc(label)}</p>`).join('');
    $('create-button').textContent=next?.ready?'Ready to accept jobs':next?.waiting?'Waiting — refresh progress':next?.label||'Begin launch';
    $('create-button').disabled=busy||!!next?.waiting||!!next?.blocked||!!next?.ready||!!config.readOnly||config.serverVersion!==3;
    $('launch-open-studio').classList.toggle('hidden',!plan.tokenId);$('launch-new').classList.toggle('hidden',!next?.ready);
    $('launch-recovery').classList.toggle('hidden',!plan.pending);lockDraft();
  }
  async function inspect(){
    if(!plan.pending)return;
    const params=new URLSearchParams(location.search);
    const callbackHash=params.get('transactionHashes')?.split(',')[0];
    if(callbackHash)plan.pending.hash=callbackHash;
    if($('launch-tx-hash').value.trim())plan.pending.hash=$('launch-tx-hash').value.trim();
    if(params.get('errorCode')&&walletCanceled({code:params.get('errorCode'),message:params.get('errorMessage')})){plan.pending=null;save();history.replaceState(null,'',`/create?launch=${plan.id}`);return}
    if(!plan.pending.hash){save();return}
    save();const receipt=await api('/studio/launch/inspect',{hash:plan.pending.hash,sender:plan.owner,action:plan.pending.action});
    if(receipt.status==='PENDING')return;
    const failed=receipt.status==='FAILED';plan.receipts.push({...receipt,step:plan.pending.step});plan.pending=null;save();
    history.replaceState(null,'',`/create?launch=${plan.id}`);if(failed)throw Error('The wallet action failed definitively. Refresh, review and retry this step.');
  }
  async function sync(){
    if(!plan.active)return;validateLaunchPlan(plan,releases);await inspect();
    const request=await api('/requests?owner='+encodeURIComponent(plan.owner)+'&requestId='+encodeURIComponent(plan.requestId));
    if(request.minted){plan.tokenId=request.tokenId;save()}
    const snapshot=plan.tokenId?await api('/studio/nfas/'+plan.tokenId):null;
    next=nextLaunchStep(plan,request,snapshot,skills);plan.ready=!!next.ready;save();progress();
    note(next.ready?'Ready to accept jobs. Open the workspace or public profile.':next.label+(next.waiting?' No duplicate action will be sent.':''));
    return {request,snapshot};
  }
  async function advance(){
    if(busy)return;busy=true;renderSteps();try{
      if(!wallet()?.accountId)throw Error('Connect your workspace wallet before launching');
      if(plan.owner&&plan.owner!==wallet().accountId)throw Error('Reconnect the wallet that started this launch');
      if(!plan.active){readDraft();if(!plan.name.trim())throw Error('Give the NFA a name');
        const marginYocto=nearAmount(plan.margin),reserveYocto=nearAmount(plan.reserve);
        if(BigInt(marginYocto)<10n**22n||BigInt(reserveYocto)<10n**22n||BigInt(reserveYocto)>10n**25n)throw Error('Check the earnings and reserve amounts');
        if(!preview)await renderCharacter();
        const manifest=await api('/manifests',{previewKey:preview.key,displayName:plan.name,description:plan.description,templateId:plan.purpose});
        const release=releases.findLast(r=>r.hostedStatus==='verified'&&selectedServices(plan.purpose).every(s=>r.services.includes(s)));
        if(!release)throw Error('No reviewed, hosted-verified runtime supports these services');
        Object.assign(plan,{active:true,owner:wallet().accountId,requestId:'launch-'+plan.id,manifest,release,serviceIds:selectedServices(plan.purpose),marginYocto,reserveYocto,maxDepositYocto:'500000000000000000000000'});save();
        history.replaceState(null,'',`/create?launch=${plan.id}`);
      }
      const {snapshot}=await sync();if(next.waiting||next.blocked||next.ready)return;
      let body;
      if(next.id==='mint')body={kind:'create',requestId:plan.requestId,manifestHash:plan.manifest.manifestHash,manifestUri:plan.manifest.manifestUri};
      if(next.id==='project')body={kind:'outlayer_provision',tokenId:plan.tokenId,wasmUrl:plan.release.url,versionKey:plan.release.versionKey,deposit:'100000000000000000000000'};
      if(next.service)body={kind:'service_policy',tokenId:plan.tokenId,serviceId:next.service,schemaHash:skills.find(s=>s.id===next.service).schemaHash,enabled:true,margin:plan.marginYocto,maxDeposit:plan.maxDepositYocto,limits:DEFAULT_LIMITS};
      if(next.id==='reserve')body={kind:'fund',vaultAccountId:snapshot.identity.vaultAccountId,yocto:next.amount};
      if(next.id==='key')body={kind:'derive_wallet',tokenId:plan.tokenId};
      if(!body)throw Error('This step needs a fresh confirmed state');
      const {unsignedAction}=await api('/prepare',body),stage=next.id;
      const result=await review(unsignedAction,next.label,{beforeSign:()=>{plan.pending={step:stage,action:unsignedAction};save()}});
      if(result){const hash=transactionHashes(result)[0];if(hash&&plan.pending){plan.pending.hash=hash;save()}}
      await sync();
    }catch(error){if(walletCanceled(error)&&plan.pending){plan.pending=null;save()}note(error.message)}
    finally{busy=false;renderSteps();if(plan.active)progress()}
  }
  $('create-back').onclick=()=>go(step-1);$('create-next').onclick=()=>go(step+1);
  $('randomize').onclick=randomize;$('preview-button').onclick=()=>renderCharacter().catch(e=>note(e.message));
  $('create-button').onclick=advance;$('create-check-outcome').onclick=()=>sync().catch(e=>note(e.message));
  $('launch-inspect').onclick=()=>sync().catch(e=>note(e.message));
  $('launch-open-studio').onclick=()=>{navigate('studio',plan.tokenId);window.dispatchEvent(new CustomEvent('nfa-open-token',{detail:plan.tokenId}))};
  $('launch-new').onclick=()=>{if(!plan.ready)return;localStorage.removeItem(key);location.href='/create'};
  window.addEventListener('nfa-resume-launch',()=>{navigate('create');step=3;renderSteps();sync().catch(e=>note(e.message))});
  async function init(){
    [catalog,{items:skills},{releases}]=await Promise.all([api('/studio/catalog'),api('/studio/skills'),api('/studio/releases')]);
    $('create-traits').innerHTML=fields.map(name=>`<div><label>${esc(name)}<select id="create-${name}">${catalog.traits[name].map(v=>`<option value="${esc(v)}">${esc(v)}</option>`).join('')}</select></label><label class="inline"><input id="create-lock-${name}" type="checkbox">Lock</label></div>`).join('');
    $('name').value=plan.name;$('create-description').value=plan.description;$('seed').value=plan.seed;$('create-margin').value=plan.margin;$('create-reserve').value=plan.reserve;$('create-chain-key').checked=config.network==='sandbox'&&!plan.active?false:plan.chainKey;
    if(config.network==='sandbox')$('create-chain-key').closest('details').insertAdjacentHTML('beforeend','<p class="small">Sepolia identity setup needs the testnet signer; it is disabled in the local OutLayer mock.</p>');
    document.querySelector(`input[name="purpose"][value="${plan.purpose}"]`).checked=true;
    for(const name of fields){const values=catalog.traits[name],selected=plan.traits[name]||(values.includes('none')?'none':values[0]);$('create-'+name).value=selected;$('create-lock-'+name).checked=!!plan.locks[name];$('create-'+name).onchange=draftChanged;$('create-lock-'+name).onchange=readDraft}
    for(const element of document.querySelectorAll('#create input:not(#launch-tx-hash),#create textarea')){if(!element.id.startsWith('create-lock-'))element.addEventListener('input',draftChanged)}
    readDraft();step=plan.active?3:plan.step||0;renderSteps();lockDraft();
    if(plan.manifest){$('art').innerHTML=`<img src="${esc(plan.manifest.previewUrl)}" alt="Saved NFA character">`}else await renderCharacter();
    if(plan.active)await sync();
  }
  init().catch(e=>note(e.message));
  return {resumeToken:()=>plan.active&&!plan.ready?plan.tokenId:null};
}
