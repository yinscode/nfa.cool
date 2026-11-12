import {startStudioControls} from './studio-controls.js';
import {transactionHashes} from './studio-flow.mjs';
const $=id=>document.getElementById(id);
const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fields=['body','palette','expression','tool','eyewear','attachment','ornament','hat','finish','marking','background','frame'];
const y=amount=>{try{if(amount==null)throw Error();return (Number(BigInt(amount)/10n**20n)/10_000).toFixed(4)+' NEAR'}catch{return 'Unavailable'}};

export function startStudio({api,wallet,signed,config={}}){
  let catalog=null,snapshot=null,preview=null,releaseCatalog=[];
  const id=()=>$('studio-token').value.trim();
  const owner=()=>snapshot?.capabilities?.writable&&wallet()?.accountId===snapshot?.identity?.ownerAccountId;
  const note=(target,value)=>{$(target).textContent=value};
  const pair=(label,value)=>`<dt>${escape(label)}</dt><dd>${escape(value??'Unavailable')}</dd>`;
  const draftKey=()=>`nfa-studio-draft:${config.registryAccountId}:${config.workspace?.id||'legacy'}:${wallet()?.accountId||'guest'}:${id()}`;
  function traits(){return Object.fromEntries(fields.map(name=>[name,$(`studio-trait-${name}`).value]))}
  function saveDraft(){if(!catalog||!snapshot)return;
    localStorage.setItem(draftKey(),JSON.stringify({name:$('studio-name').value,seed:$('studio-seed').value,
      traits:traits(),locks:Object.fromEntries(fields.map(name=>[name,$(`studio-lock-${name}`).checked])),
      tokenId:id(),epoch:snapshot.identity.ownerEpoch}))}
  function drawTraits(selected={}){
    $('studio-traits').innerHTML=fields.map(name=>`<div class="trait-field"><label>${escape(name)}<select id="studio-trait-${name}">${catalog.traits[name].map(value=>
      `<option value="${escape(value)}" ${selected[name]===value?'selected':''}>${escape(value)}</option>`).join('')}</select></label>
      <label class="inline"><input type="checkbox" id="studio-lock-${name}"> Lock</label></div>`).join('');
    for(const name of fields){$(`studio-trait-${name}`).onchange=()=>{preview=null;$('studio-save-character').disabled=true;saveDraft()};
      $(`studio-lock-${name}`).onchange=saveDraft}
  }
  function validateHead(t){
    if(['attachment','ornament','hat'].filter(n=>t[n]!=='none').length>1)throw Error('Choose one attachment, ornament or hat');
    if(t.hat!=='none'&&!['sphere','capsule'].includes(t.body))throw Error('Hats fit sphere or capsule only');
  }
  async function readManifest(uri){
    if(!uri)return null;
    try{return uri.startsWith('nfa://manifest/')?await api('/manifests/'+encodeURIComponent(uri.split('/').pop())):
      await api('/studio/nfas/'+encodeURIComponent(id())+'/manifest')}catch{return null}
  }
  function showArt(manifest){
    const img=manifest?.publicCharacter;
    if(img?.imageUri?.startsWith('nfa://image/')){
      const hex=img.imageUri.slice('nfa://image/'.length).replace(/\.png$/,'');
      if(/^[0-9a-f]{64}$/.test(hex))return `/studio/artifacts/${hex}.png`;
    }
    if(/^[0-9a-f]{64}$/.test(img?.previewKey||''))return `/preview/${img.previewKey}.png`;
    if(/^https:\/\/(test|main)\.fastfs\.io\//.test(img?.imageUri||'')&&/^sha256:[0-9a-f]{64}$/.test(img?.imageHash||''))
      return img.imageUri;
    return null;
  }
  async function updateOwned(){
    const account=wallet()?.accountId;
    $('studio-wallet-note').textContent=account?`Finalized ownership for ${account}`:'Connect a testnet wallet to see your NFAs.';
    $('studio-owned').replaceChildren();
    if(!account){$('studio-wallet-note').textContent=config.readOnly?'Public testnet collection. Inspect any NFA below without a wallet.':'Connect a workspace wallet to manage your NFAs, or browse the collection below.';return;}
    try{const {items}=await api('/studio/owned?owner='+encodeURIComponent(account));
      $('studio-owned').innerHTML=items.map(n=>`<button class="secondary" data-token="${escape(n.tokenId)}">${escape(n.tokenId)} · ${escape(n.lifecycle)}</button>`).join('')||'<p class="small">No NFAs held by this wallet.</p>';
      for(const b of $('studio-owned').querySelectorAll('button'))b.onclick=()=>{$('studio-token').value=b.dataset.token;load()};
    }catch(error){note('studio-status',error.message)}
  }
  function display(snapshot,manifest){
    const {identity:i,treasury:t,project:p,agent:a,policies}=snapshot;
    const isOwner=owner();
    $('studio-title').textContent=`${manifest?.displayName||i.tokenId} · ${i.tokenId}`;
    $('studio-summary').textContent=`Owner ${i.ownerAccountId} · epoch ${i.ownerEpoch} · vault ${i.vaultAccountId}`;
    $('studio-badges').innerHTML=`<span class="badge">${escape(i.lifecycle)}</span> <span class="badge">${isOwner?'Owner controls':'Public passport'}</span> <span class="badge">${snapshot.runtimeGate==='verified'?'Runtime verified':snapshot.runtimeGate==='identity_verified'?'Project identity checked':'Runtime unverified'}</span>${snapshot.capabilities?.writable?'':' <span class="badge">Read-only</span>'}`;
    const art=showArt(manifest);$('studio-avatar').innerHTML=art?`<img src="${escape(art)}" alt="NFA character">`:'No published character';
    $('studio-treasury').innerHTML=[pair('Balance',y(t?.balance)),pair('Unreserved balance',a?.pending_op!=null?'Locked while an operation is pending':y(t?.available)),
      pair('Gas reserve',y(t?.gas_reserve)),
      pair('Storage reserve',y(t?.storage_reserve)),pair('Unclaimed income',y(i.income)),
      pair('Pending lock',a?.pending_op??'None'),
      pair('Customer revenue',y(snapshot.economics?.grossCustomerReceipts)),
      pair('Execution replenishment',y(snapshot.economics?.executionReplenishment)),
      pair('Credited service earnings',y(snapshot.economics?.creditedServiceEarnings)),
      pair('Customer escrow',y(snapshot.economics?.customerEscrow)),
      pair('Net profit','Unknown until compute, storage, inference and gas costs reconcile'),
      pair('History coverage',snapshot.economics?.coverage==='complete_job_history'?'Complete recorded history':'Partial or unavailable')].join('');
    $('studio-chain').innerHTML=[pair('Network','Sepolia'),pair('Address',snapshot.chainKey?.address||i.foreignWallet?.address||'Not pinned'),
      pair('Path',snapshot.chainKey?.path||i.foreignWallet?.path||'eth-sepolia-v1'),
      pair('Signer',snapshot.chainKey?.signer_id||i.foreignWallet?.signer_id),
      pair('Signer version',snapshot.chainKey?.signer_version||'v1'),
      pair('Domain',snapshot.chainKey?.domain_id??0),pair('Chain ID',snapshot.chainKey?.chain_id??11155111),
      pair('Owner epoch',i.ownerEpoch)].join('');
    $('studio-project').innerHTML=[pair('State',p?.state||'Not provisioned'),pair('Project',p?.project_id),
      pair('UUID',p?.project_uuid),pair('Active hash',p?.version_key),
      pair('Candidate hash',p?.candidate_version)].join('');
    $('studio-service-list').innerHTML=['scout','compare'].map(s=>`<p><b>${s}</b> · ${escape(policies[s]?.enabled?'Enabled':'Not enabled')} · ${escape(policies[s]?.schema_hash||'No schema hash')}</p>`).join('');
    $('studio-operations').innerHTML=snapshot.history.map(o=>`<p class="small">#${escape(o.id)} · ${escape(o.kind)} · ${escape(o.status)} · epoch ${escape(o.ownerEpoch)}</p>`).join('')||'<p class="small">No operations in this page.</p>';
    $('studio-jobs').innerHTML='<p class="small">Use a finalized job ID to inspect and recall its memory. History above shows pending and settled operations.</p>';
    $('studio-inventory').innerHTML=`<dl class="kv">${[pair('Vault',i.vaultAccountId),pair('Balance',y(t?.balance)),
      pair('Liabilities',t?.pending_liabilities||'See vault state'),pair('Sepolia address',i.foreignWallet?.address||'Not pinned'),
      pair('OutLayer UUID',p?.project_uuid),pair('Runtime',p?.version_key),pair('Manifest',i.manifestHash),
      pair('Enabled services',Object.entries(policies).filter(([,v])=>v?.enabled).map(([s])=>s).join(', ')||'None'),
      pair('Unclaimed income',y(i.income)),
      pair('Finalized work',(snapshot.inventory?.included.eligibleWork||[]).length+' jobs in available history'),
      pair('Customer escrow',y(snapshot.economics?.customerEscrow)),
      pair('Trust dependencies',snapshot.inventory?.dependencies?.join('; ')||'Guardian, settlement reporter and runtime availability'),
      pair('Personal connectors','Reconnect required')].join('')}</dl>`;
    for(const element of $('studio-workspace').querySelectorAll('button')){
      if(['studio-load','studio-hire','studio-public-profile','studio-preview','studio-random','studio-inspect-job','studio-simulate'].includes(element.id))continue;
      if(element.id==='studio-activate'){const r=releaseCatalog.find(r=>r.versionKey===p?.candidate_version);
        element.disabled=!isOwner||r?.hostedStatus!=='verified';continue}
      if(element.id?.startsWith('studio-'))element.disabled=!isOwner;
    }
    $('studio-save-character').disabled=true;
    $('studio-list').disabled=!isOwner||a?.pending_op!=null||i.lifecycle!=='ACTIVE';
    $('studio-transfer').disabled=!isOwner||a?.pending_op!=null||i.lifecycle!=='ACTIVE';
    $('studio-derive').disabled=config.network==='sandbox'||!isOwner||a?.pending_op!=null||!!i.foreignWallet;
    $('studio-provision').disabled=!isOwner||a?.pending_op!=null||!!p;
    $('studio-add-version').disabled=!isOwner||a?.pending_op!=null||p?.state!=='READY';
    $('studio-workspace').classList.remove('hidden');
    controls.draw(snapshot);
    try{const launch=JSON.parse(localStorage.getItem('nfa-launch-v3:'+config.registryAccountId+':'+(config.workspace?.id||config.localSandbox?.instanceId||'legacy'))||'null');
      $('studio-resume-launch').classList.toggle('hidden',!(launch?.active&&!launch.ready&&launch.tokenId===id()&&isOwner));}catch{$('studio-resume-launch').classList.add('hidden')}
  }
  async function load(){
    try{
      catalog ||= await api('/studio/catalog');
      preview=null;
      snapshot=await api('/studio/nfas/'+encodeURIComponent(id()));
      const manifest=await readManifest(snapshot.identity.manifestUri);
      display(snapshot,manifest);
      const character=manifest?.publicCharacter||{};
      $('studio-name').value=manifest?.displayName||snapshot.identity.tokenId;
      $('studio-seed').value=character.seed?.split(':')[0]||snapshot.identity.tokenId;
      drawTraits(character.traits||{});
      const saved=localStorage.getItem(draftKey());
      if(saved){const draft=JSON.parse(saved);
        if(draft.epoch===snapshot.identity.ownerEpoch){$('studio-name').value=draft.name;$('studio-seed').value=draft.seed?.split(':')[0]||snapshot.identity.tokenId;
          for(const name of fields){if(catalog.traits[name].includes(draft.traits[name]))$(`studio-trait-${name}`).value=draft.traits[name];
            $(`studio-lock-${name}`).checked=!!draft.locks[name]}
          note('studio-character-status','Recovered an unpublished draft.');
        }else localStorage.removeItem(draftKey())}
      note('studio-status',snapshot.readOnlyReason|| (owner()?'Owner views loaded from finalized chain state.':snapshot.capabilities?.writable?'Public view; owner actions disabled.':'The deployed registry lacks Studio methods. Read-only legacy view; upgrade required for owner controls.'));
      if(await reconcileIntent())return load();
      await controls.manifestHistory(manifest);
      if(!$('studio').classList.contains('hidden'))history.replaceState(null,'',`/studio?token=${encodeURIComponent(id())}`);
    }catch(error){note('studio-status',error.message);$('studio-workspace').classList.add('hidden')}
  }
  async function reconcileIntent(){
    const raw=localStorage.getItem('nfa-studio-intent');if(!raw)return;
    const intent=JSON.parse(raw);if(intent.tokenId!==id())return;
    if(intent.registry&&intent.registry!==snapshot.identity.registryAccountId){note('studio-status','A wallet action for another registry is unresolved.');return}
    const urlHash=new URLSearchParams(location.search).get('transactionHashes')?.split(',')[0];
    if(urlHash&&/^[1-9A-HJ-NP-Za-km-z]{40,44}$/.test(urlHash)){intent.hash=urlHash;localStorage.setItem('nfa-studio-intent',JSON.stringify(intent))}
    if(intent.hash){
      try{const receipt=await api('/studio/transactions/inspect',{tokenId:id(),hash:intent.hash,sender:intent.sender});
        if(receipt.status!=='PENDING'){
          const rows=JSON.parse(localStorage.getItem('nfa-studio-receipts')||'[]');
          if(!rows.some(r=>r.hash===receipt.hash))rows.push({...receipt,registry:snapshot.identity.registryAccountId});
          localStorage.setItem('nfa-studio-receipts',JSON.stringify(rows.slice(-100)));
          if(receipt.status==='SUCCEEDED'&&intent.kind==='service_payment'&&receipt.assignedJobId){
            controls.saveCheckout({quote:intent.quote,service:intent.quote.service,sender:intent.sender,
              jobId:receipt.assignedJobId,requestHash:receipt.hash});
            $('ctl-job-id').value=receipt.assignedJobId;
          }
          if(receipt.status==='SUCCEEDED'&&intent.kind==='service_start'){
            const saved=controls.checkout();if(saved)controls.saveCheckout({...saved,startHash:receipt.hash,startSender:intent.sender});
            $('ctl-start-hash').value=receipt.hash;$('ctl-start-sender').value=intent.sender;
          }
          localStorage.removeItem('nfa-studio-intent');$('studio-clear-intent').classList.add('hidden');
          note('studio-status',`${intent.label}: transaction ${receipt.status.toLowerCase()}. Current operation state remains authoritative.`);return true;
        }
      }catch(error){note('studio-status',`${intent.label}: receipt unresolved (${error.message}).`);$('studio-clear-intent').classList.remove('hidden');return}
    }
    note('studio-status',`${intent.label} is unresolved. Add its transaction hash to reconcile its receipt.`);
    $('studio-clear-intent').classList.remove('hidden');
  }
  async function review(action,label,statusId,{ownerRequired=true,kind=null,quote=null}={}){
    if(!wallet()?.accountId)throw Error('Connect a wallet to sign');
    if(ownerRequired&&!owner())throw Error('Current wallet does not own this NFA');
    if(localStorage.getItem('nfa-studio-intent'))throw Error('Previous wallet action is unresolved; inspect finalized state before continuing');
    const before={owner:snapshot.identity.ownerAccountId,epoch:snapshot.identity.ownerEpoch,
      manifest:snapshot.identity.manifestHash,pending:snapshot.agent?.pending_op??null};
    const dialog=$('studio-review');
    $('studio-review-context').textContent=`${label} · ${id()} · owner epoch ${before.epoch}. Wallet pays ${y(action.deposit)} to ${action.receiverId}. Refresh chain state after signing.`;
    $('studio-review-json').textContent=JSON.stringify({action,before},null,2);
    const accepted=await new Promise(resolve=>{
      $('studio-review-sign').onclick=()=>{dialog.close();resolve(true)};
      $('studio-review-cancel').onclick=()=>{dialog.close();resolve(false)};
      dialog.oncancel=()=>resolve(false);
      dialog.showModal();
    });
    if(!accepted)return;
    const latest=await api('/studio/nfas/'+encodeURIComponent(id()));
    if(ownerRequired&&(latest.identity.ownerAccountId!==wallet()?.accountId||latest.identity.ownerEpoch!==before.epoch))throw Error('Ownership changed during review; reload');
    const intent={tokenId:id(),registry:snapshot.identity.registryAccountId,label,before,action,kind,quote,
      sender:wallet().accountId,at:new Date().toISOString()};
    localStorage.setItem('nfa-studio-intent',JSON.stringify(intent));
    const result=await signed(action,statusId);
    const hashes=transactionHashes(result);
    if(hashes[0]){intent.hash=hashes[0];localStorage.setItem('nfa-studio-intent',JSON.stringify(intent))}
    note(statusId,`${$(statusId).textContent} Check finalized chain state before sending another action.`);
    try{await load()}
    catch{note(statusId,'Outcome uncertain. Inspect transaction and chain state before retrying.')}
  }
  async function prepare(kind,body,label,statusId){
    try{const latest=await api('/studio/nfas/'+encodeURIComponent(id()));
      if(latest.identity.ownerAccountId!==wallet()?.accountId||latest.identity.ownerEpoch!==snapshot.identity.ownerEpoch)
        throw Error('Ownership changed; reload the NFA');
      if(latest.agent?.pending_op!=null&&['outlayer_provision','outlayer_add_version','transfer','list'].includes(kind))
        throw Error('NFA has a pending operation');
      const {unsignedAction}=await api('/prepare',{kind,tokenId:id(),...body});
      await review(unsignedAction,label,statusId);
    }catch(error){note(statusId,error.message)}
  }
  async function init(){
    catalog=await api('/studio/catalog');
    releaseCatalog=(await api('/studio/releases')).releases;
    const candidate=releaseCatalog.at(-1);
    if(candidate){$('studio-wasm-url').value=candidate.url;$('studio-wasm-hash').value=candidate.versionKey;
      note('studio-runtime-status',`Reviewed candidate ${candidate.id}: ${candidate.reason}`)}
    $('studio-token').value=new URLSearchParams(location.search).get('token')||localStorage.getItem('nfa-studio-last')||'';
    await Promise.allSettled([updateOwned(),browse(),$('studio-token').value&&['/studio','/'].includes(location.pathname)?load():Promise.resolve()]);
    if(snapshot&&localStorage.getItem('nfa-studio-intent'))await reconcileIntent();
  }
  let browseFrom=0;
  async function browse(more=false){
    if(!more){browseFrom=0;$('studio-discovered').replaceChildren()}
    try{const page=await api('/studio/discover?from='+browseFrom);
      for(const n of page.items){const card=document.createElement('article');card.className='collection-card';
        const art=showArt({publicCharacter:n.publicCharacter});
        card.innerHTML=`${art?`<img class="collection-avatar" src="${escape(art)}" alt="NFA character">`:''}<h3>${escape(n.displayName||n.tokenId)}</h3><span class="small">${escape(n.tokenId)}</span><span class="badge">${escape(n.lifecycle)}</span><p>${escape(n.setupStatus||'Inspect setup')}</p><p class="small">Owner ${escape(n.ownerAccountId)}</p><div class="actions"><button data-open>Manage / inspect</button><button class="secondary" data-profile>Public profile</button></div>`;
        card.querySelector('[data-open]').onclick=()=>{$('studio-token').value=n.tokenId;load()};
        card.querySelector('[data-profile]').onclick=()=>window.dispatchEvent(new CustomEvent('nfa-profile',{detail:n.tokenId}));$('studio-discovered').append(card);
      }
      if(!page.items.length&&!more)$('studio-discovered').textContent='No agents in this workspace yet. Create an NFA to launch your first service.';
      browseFrom=page.next;$('studio-more').classList.toggle('hidden',browseFrom==null);
    }catch(error){$('studio-discovered').textContent='Collection unavailable: '+error.message}
  }
  $('studio-browse').onclick=()=>browse();$('studio-more').onclick=()=>browse(true);
  $('studio-load').onclick=()=>{localStorage.setItem('nfa-studio-last',id());load()};
  $('studio-clear-intent').onclick=()=>{if(!window.confirm('Clear the local pending marker only after checking the transaction and finalized chain state. This does not undo an on-chain action.'))return;
    localStorage.removeItem('nfa-studio-intent');$('studio-clear-intent').classList.add('hidden');
    note('studio-status','Local marker cleared. Reload the NFA before another action.');load()};
  $('studio-new').onclick=()=>document.querySelector('[data-tab="create"]').click();
  $('studio-hire').onclick=()=>window.dispatchEvent(new CustomEvent('nfa-profile',{detail:id()}));
  $('studio-public-profile').onclick=$('studio-hire').onclick;
  $('studio-resume-launch').onclick=()=>window.dispatchEvent(new Event('nfa-resume-launch'));

  for(const button of document.querySelectorAll('[data-studio]'))button.onclick=()=>{
    for(const pane of document.querySelectorAll('.studio-pane'))pane.classList.toggle('hidden',pane.id!==`studio-${button.dataset.studio}`);
    for(const b of document.querySelectorAll('[data-studio]'))b.classList.toggle('active',b===button)};
  $('studio-random').onclick=()=>{for(const name of fields){const select=$(`studio-trait-${name}`);
      if(!$(`studio-lock-${name}`).checked)select.value=catalog.traits[name][Math.floor(Math.random()*catalog.traits[name].length)];}
    const lockedHead=['attachment','ornament','hat'].find(n=>$(`studio-lock-${n}`).checked&&$(`studio-trait-${n}`).value!=='none');
    if(lockedHead)for(const n of ['attachment','ornament','hat'])if(n!==lockedHead&&!$(`studio-lock-${n}`).checked)$(`studio-trait-${n}`).value='none';
    const t=traits();if(['attachment','ornament','hat'].filter(n=>t[n]!=='none').length>1){
      const chosen=['attachment','ornament','hat'].find(n=>t[n]!=='none');
      for(const n of ['attachment','ornament','hat'])if(n!==chosen&&!$(`studio-lock-${n}`).checked)$(`studio-trait-${n}`).value='none';
    }
    if(t.hat!=='none'&&$('studio-lock-hat').checked&&!$('studio-lock-body').checked)
      $('studio-trait-body').value=['sphere','capsule'][Math.floor(Math.random()*2)];
    else if(!['sphere','capsule'].includes(t.body)&&t.hat!=='none'&&!$('studio-lock-hat').checked)$('studio-trait-hat').value='none';
    $('studio-seed').value=crypto.randomUUID().slice(0,12);preview=null;$('studio-save-character').disabled=true;saveDraft()};
  for(const field of ['studio-name','studio-seed'])$(field).oninput=()=>{preview=null;$('studio-save-character').disabled=true;saveDraft()};
  $('studio-preview').onclick=async()=>{try{const t=traits();validateHead(t);
    preview=await api('/preview',{seed:$('studio-seed').value,traits:t});
    $('studio-art').innerHTML=`<img src="${escape(preview.imageUrl)}" alt="New character preview">`;
    $('studio-trait-summary').textContent=Object.entries(preview.metadata.traits).map(([k,v])=>`${k}: ${v}`).join(' · ');
    $('studio-save-character').disabled=!owner();saveDraft();note('studio-character-status','Preview ready. Publish and sign to update the NFT.');
  }catch(error){note('studio-character-status',error.message)}};
  $('studio-save-character').onclick=async()=>{try{if(!preview)throw Error('Preview a revision first');
    const response=await api('/studio/appearance',{tokenId:id(),previewKey:preview.key,displayName:$('studio-name').value,
      expectedOwner:wallet()?.accountId,expectedEpoch:snapshot.identity.ownerEpoch});
    await prepare('manifest',{manifestHash:response.manifestHash,manifestUri:response.manifestUri},
      `Publish character revision ${response.manifest.revision}`,'studio-character-status');
    if(snapshot.identity.manifestHash===response.manifestHash)localStorage.removeItem(draftKey());
  }catch(error){note('studio-character-status',error.message)}};
  $('studio-fund').onclick=()=>prepare('fund',{vaultAccountId:snapshot.identity.vaultAccountId,yocto:$('studio-fund-amount').value},'Fund vault','studio-status');
  $('studio-derive').onclick=()=>prepare('derive_wallet',{},'Pin Sepolia identity','studio-status');
  const release=kind=>{
    const url=$('studio-wasm-url').value.trim(),versionKey=$('studio-wasm-hash').value.trim();
    if(!releaseCatalog.some(r=>r.url===url&&r.versionKey===versionKey)){
      note('studio-runtime-status','Use a reviewed release from the catalog; arbitrary URLs are not supported.');return}
    prepare(kind,{wasmUrl:url,versionKey,deposit:$('studio-project-deposit').value},
      kind==='outlayer_provision'?'Provision Project':'Stage version','studio-runtime-status');
  };
  $('studio-reconcile-tx').onclick=async()=>{const raw=localStorage.getItem('nfa-studio-intent');if(!raw)return;
    const intent=JSON.parse(raw);intent.hash=$('studio-txhash').value.trim();intent.sender=$('studio-txsender').value.trim()||intent.sender;
    localStorage.setItem('nfa-studio-intent',JSON.stringify(intent));await load()};
  $('studio-provision').onclick=()=>release('outlayer_provision');
  $('studio-add-version').onclick=()=>release('outlayer_add_version');
  $('studio-activate').onclick=()=>prepare('outlayer_activate',{},'Activate verified runtime','studio-runtime-status');
  $('studio-service').onchange=()=>{const p=snapshot?.policies[$('studio-service').value];
    $('studio-enabled').checked=!!p?.enabled;
    if(p){$('studio-schema').value=p.schema_hash||'';$('studio-margin').value=p.min_margin||'';
      $('studio-max-deposit').value=p.max_deposit||'';$('studio-instructions').value=p.limits.max_instructions;
      $('studio-memory-mb').value=p.limits.max_memory_mb;$('studio-seconds').value=p.limits.max_execution_seconds}}
  $('studio-policy').onclick=()=>prepare('service_policy',{serviceId:$('studio-service').value,schemaHash:$('studio-schema').value,
    enabled:$('studio-enabled').checked,margin:$('studio-margin').value,maxDeposit:$('studio-max-deposit').value,
    limits:{max_instructions:Number($('studio-instructions').value),max_memory_mb:Number($('studio-memory-mb').value),
      max_execution_seconds:Number($('studio-seconds').value)}},'Configure service policy','studio-policy-status');
  $('studio-simulate').onclick=async()=>{try{
    const result=await api('/studio/simulate',{service:$('studio-service').value,input:JSON.parse($('studio-sample').value)});
    $('studio-sim-result').textContent=JSON.stringify(result,null,2);
  }catch(error){$('studio-sim-result').textContent=error.message}};
  $('studio-recall').onclick=()=>prepare('recall',{jobId:Number($('studio-recall-id').value),
    deposit:$('studio-recall-deposit').value},'Recall finalized memory','studio-memory-status');
  $('studio-inspect-job').onclick=async()=>{try{
    const jobId=Number($('studio-recall-id').value);
    if(!Number.isSafeInteger(jobId)||jobId<1)throw Error('Enter a valid job ID');
    const result=await api(`/studio/nfas/${encodeURIComponent(id())}/jobs/${jobId}`);
    $('studio-job-detail').textContent=JSON.stringify(result,null,2);
    note('studio-memory-status',result.status==='FINALIZED'?'Finalized commitment; recall requires current owner and a wallet deposit.':
      `Job ${result.status}. Do not treat a pending or uncertain result as finalized.`);
  }catch(error){note('studio-memory-status',error.message)}};
  $('studio-list').onclick=()=>prepare('list',{price:$('studio-price').value,
    expiresAtNs:Math.floor((Date.now()+86_400_000)*1e6)},'List whole NFA','studio-handoff-status');
  $('studio-transfer').onclick=()=>prepare('transfer',{receiverId:$('studio-recipient').value.trim()},
    'Transfer whole NFA','studio-handoff-status');
  const controls=startStudioControls({api,wallet,getSnapshot:()=>snapshot,id,prepare,review,reload:load,escape,money:y});
  window.addEventListener('nfa-wallet-changed',()=>{updateOwned();if(snapshot)load()});
  window.addEventListener('nfa-open-token',event=>{$('studio-token').value=event.detail;localStorage.setItem('nfa-studio-last',event.detail);updateOwned();load()});
  init().catch(error=>note('studio-status',error.message));
  return {load,updateOwned};
}
