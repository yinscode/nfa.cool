import {quoteExpired} from './studio-flow.mjs';
const $=id=>document.getElementById(id);
const split=value=>value.split(/[\s,]+/).map(s=>s.trim()).filter(Boolean);
export function startStudioControls({api,wallet,getSnapshot,id,prepare,review,reload,escape:esc,money}){
  let quote=null,simulation=null,skills=[],releases=[];
  const note=(target,text)=>{$(target).textContent=text};
  const pair=(name,value)=>`<dt>${esc(name)}</dt><dd>${esc(value??'Unavailable')}</dd>`;
  const checkoutKey=()=>`nfa-checkout:${getSnapshot()?.identity.registryAccountId}:${id()}:${wallet()?.accountId||'guest'}`;
  const checkout=()=>{try{return JSON.parse(localStorage.getItem(checkoutKey())||'null')}catch{return null}};
  const saveCheckout=data=>localStorage.setItem(checkoutKey(),JSON.stringify(data));
  $('studio-vault').insertAdjacentHTML('beforeend',`<div class="grid"><div class="card"><h2>Transaction policy</h2>
    <p class="small">Recipients are allowlisted. The vault uses the fixed Sepolia transfer adapter with 21,000 gas. Transfer to a new NFT owner invalidates this policy and old grants.</p>
    <label class="inline"><input id="ctl-near-enabled" type="checkbox"> Allow NEAR transfers</label>
    <label>NEAR recipients, one per line<textarea id="ctl-near-recipients" rows="2"></textarea></label>
    <label>Maximum NEAR per transfer (yoctoNEAR)<input id="ctl-max-near" value="1000000000000000000000000"></label>
    <label class="inline"><input id="ctl-evm-enabled" type="checkbox"> Allow Sepolia transfers</label>
    <label>Sepolia recipients<textarea id="ctl-evm-recipients" rows="2"></textarea></label>
    <label>Maximum ETH per transfer (wei)<input id="ctl-max-evm" value="10000000000000000"></label>
    <label>Maximum gas price (wei)<input id="ctl-policy-fee" type="number" value="10000000000"></label>
    <button id="ctl-save-policy" data-owner>Review transaction policy</button><p id="ctl-policy-status" class="status"></p></div>
    <div class="card"><h2>Simulate a transfer</h2><label>Asset<select id="ctl-transfer-kind"><option value="near_transfer">NEAR</option><option value="evm_transfer">Sepolia ETH</option></select></label>
    <label>Recipient<input id="ctl-transfer-recipient"></label><label>Amount in yoctoNEAR or wei<input id="ctl-transfer-amount" value="1000000000000000000000"></label>
    <label>Priority gas price (wei)<input id="ctl-priority" type="number" value="1000000000"></label>
    <label>Maximum gas price (wei)<input id="ctl-fee" type="number" value="2000000000"></label>
    <div class="actions"><button id="ctl-sim-transfer" data-owner class="secondary">Simulate</button><button id="ctl-sign-transfer" data-owner disabled>Review transfer</button></div>
    <pre id="ctl-transfer-output"></pre><p id="ctl-transfer-status" class="status"></p></div></div>
    <div class="grid"><div class="card"><h2>Delegate an allowance</h2><label>Delegate account<input id="ctl-delegate"></label>
    <label>Permission<select id="ctl-grant-method"><option value="NEAR_TRANSFER">NEAR transfer to one recipient</option><option value="SCOUT_RUN">Legacy Scout job count</option></select></label>
    <label>NEAR recipient<input id="ctl-grant-recipient"></label><label>Budget in yoctoNEAR, or job count<input id="ctl-grant-budget" value="1"></label>
    <label>Expires in hours<input id="ctl-grant-hours" type="number" min="1" max="8760" value="24"></label>
    <button id="ctl-grant" data-owner>Review grant</button><div id="ctl-grants"></div><p id="ctl-grant-status" class="status"></p></div>
    <div class="card"><h2>Recovery</h2><div id="ctl-recovery"></div><p id="ctl-recovery-status" class="status"></p>
    <p class="small">Unknown execution results keep the vault locked. Only actions applicable to finalized state appear here.</p>
    <h3>Earnings and payout credits</h3><label>Amount (yoctoNEAR)<input id="ctl-claim-amount" value="10000000000000000000000"></label>
    <div class="actions"><button id="ctl-claim" data-owner>Claim NFA income</button><button id="ctl-withdraw" data-owner class="secondary">Withdraw wallet credit</button></div><p id="ctl-earn-status" class="status"></p></div></div>`);
  $('studio-runtime').insertAdjacentHTML('beforeend',`<div class="card"><h2>Inspect release bytes</h2><label>Reviewed release<select id="ctl-release"></select></label><pre id="ctl-release-diff"></pre><button id="ctl-verify-release" class="secondary">Download and verify pinned release</button><pre id="ctl-release-result"></pre></div>`);
  $('studio-memory').insertAdjacentHTML('beforeend',`<div class="grid"><div class="card"><h2>Hire a service</h2>
    <p class="small">Customer payment uses native testNEAR. Supplied source text becomes public transaction data.</p>
    <label>Service<select id="ctl-checkout-service"><option value="scout">Scout</option><option value="compare">Compare</option></select></label>
    <label>Input JSON<textarea id="ctl-checkout-input" rows="8"></textarea></label>
    <div class="actions"><button id="ctl-quote" class="secondary">Get current quote</button><button id="ctl-pay" disabled>Review payment</button></div><pre id="ctl-quote-output"></pre>
    <label>Assigned job ID<input id="ctl-job-id" type="number" min="1"></label>
    <div class="actions"><button id="ctl-start" class="secondary">Start confirmed job</button><button id="ctl-refresh-job" class="secondary">Refresh job</button></div>
    <p id="ctl-checkout-status" class="status"></p></div><div class="card"><h2>Finalized work artifact</h2>
    <label>Start transaction hash<input id="ctl-start-hash"></label><label>Start transaction signer<input id="ctl-start-sender"></label>
    <button id="ctl-open-work" data-owner>Open owned artifact</button><pre id="ctl-work-output"></pre>
    <p class="small">Scout and Compare artifacts can be reconstructed from public input and checked against their finalized hash. This check does not establish the sources' factual accuracy.</p>
    <p id="ctl-work-status" class="status"></p></div></div>`);
  $('studio-appearance').insertAdjacentHTML('beforeend','<div class="card"><h2>Published character revisions</h2><div id="ctl-manifest-history"></div></div>');
  $('studio-handoff').insertAdjacentHTML('beforeend',`<div class="card"><div class="actions"><button id="ctl-unlist" data-owner class="secondary">Cancel listing</button><button id="ctl-buy">Review purchase</button></div><p id="ctl-buy-status" class="status"></p></div>
    <div class="card"><h2>Audit timeline</h2><p class="small">On-chain events include block height and commitments. Transaction links appear when this browser has inspected their finalized receipts. Earlier contract versions may lack audit records.</p><div id="ctl-audit"></div></div>`);
  $('ctl-save-policy').onclick=()=>prepare('transaction_policy',{nearEnabled:$('ctl-near-enabled').checked,
    evmEnabled:$('ctl-evm-enabled').checked,nearRecipients:split($('ctl-near-recipients').value),
    evmRecipients:split($('ctl-evm-recipients').value),maxNear:$('ctl-max-near').value,maxEvm:$('ctl-max-evm').value,
    maxFee:Number($('ctl-policy-fee').value)},'Set transaction policy','ctl-policy-status');
  $('ctl-sim-transfer').onclick=async()=>{try{const s=getSnapshot();simulation=await api('/studio/transactions/simulate',{
    tokenId:id(),expectedOwner:wallet()?.accountId,expectedEpoch:s.identity.ownerEpoch,kind:$('ctl-transfer-kind').value,
    recipient:$('ctl-transfer-recipient').value.trim(),yocto:$('ctl-transfer-amount').value,valueWei:$('ctl-transfer-amount').value,
    priorityFee:Number($('ctl-priority').value),maxFee:Number($('ctl-fee').value)});
    $('ctl-transfer-output').textContent=JSON.stringify(simulation,null,2);$('ctl-sign-transfer').disabled=false;
  }catch(error){note('ctl-transfer-status',error.message);$('ctl-sign-transfer').disabled=true}};
  for(const element of ['ctl-transfer-kind','ctl-transfer-recipient','ctl-transfer-amount','ctl-priority','ctl-fee'])
    $(element).oninput=()=>{simulation=null;$('ctl-sign-transfer').disabled=true};
  $('ctl-sign-transfer').onclick=async()=>{try{if(!simulation)throw Error('Simulate the exact transfer first');
    await review(simulation.unsignedAction,'Send reviewed transfer','ctl-transfer-status');
    simulation=null;$('ctl-sign-transfer').disabled=true;}catch(error){note('ctl-transfer-status',error.message)}};
  $('ctl-grant').onclick=()=>prepare('grant',{delegate:$('ctl-delegate').value.trim(),method:$('ctl-grant-method').value,
    recipient:$('ctl-grant-method').value==='NEAR_TRANSFER'?$('ctl-grant-recipient').value.trim():null,
    budget:$('ctl-grant-budget').value,expiresAtNs:Math.floor((Date.now()+Number($('ctl-grant-hours').value)*3600000)*1e6)},'Set epoch-bound delegate allowance','ctl-grant-status');
  $('ctl-claim').onclick=()=>prepare('claim',{yocto:$('ctl-claim-amount').value},'Claim NFA income','ctl-earn-status');
  $('ctl-withdraw').onclick=()=>prepare('withdraw',{yocto:$('ctl-claim-amount').value},'Withdraw wallet credit','ctl-earn-status');
  $('ctl-verify-release').onclick=async()=>{try{$('ctl-release-result').textContent='Checking bytes…';
    const result=await api('/studio/releases/verify',{versionKey:$('studio-wasm-hash').value});
    $('ctl-release-result').textContent=JSON.stringify(result,null,2);
  }catch(error){$('ctl-release-result').textContent=error.message}};
  $('ctl-release').onchange=()=>{const r=releases.find(r=>r.id===$('ctl-release').value);if(!r)return;
    $('studio-wasm-url').value=r.url;$('studio-wasm-hash').value=r.versionKey;
    $('ctl-release-diff').textContent=JSON.stringify({activeRuntime:getSnapshot()?.project?.version_key,
      selectedRuntime:r.versionKey,diff:r.diff||'Initial reviewed runtime',hostedEvidence:r.hostedEvidence||null},null,2);
    note('studio-runtime-status',`${r.hostedStatus}: ${r.reason}`)};
  const samples={scout:{question:'How does the agent retain its treasury?',sources:[{title:'Vault',url:'https://example.org/vault',text:'The agent retains its treasury in the same NEAR vault after the NFT transfers to its new owner.'}]},
    compare:{question:'Which option has cost and speed evidence?',criteria:['cost','speed'],sources:[
      {title:'Option A',url:'https://example.org/a',text:'The cost of option A is five units per run. The speed of option A is two seconds per run.'},
      {title:'Option B',url:'https://example.org/b',text:'The cost of option B is seven units for a single run.'}]}};
  const setSample=()=>{$('ctl-checkout-input').value=JSON.stringify(samples[$('ctl-checkout-service').value],null,2);quote=null;$('ctl-pay').disabled=true};
  $('ctl-checkout-service').onchange=setSample;$('ctl-checkout-input').oninput=()=>{quote=null;$('ctl-pay').disabled=true};setSample();
  $('ctl-quote').onclick=async()=>{try{quote=await api(`/v1/nfas/${id()}/services/${$('ctl-checkout-service').value}/quotes`,
    {input:JSON.parse($('ctl-checkout-input').value)});$('ctl-quote-output').textContent=JSON.stringify(quote,null,2);$('ctl-pay').disabled=false;
  }catch(error){note('ctl-checkout-status',error.message)}};
  $('ctl-pay').onclick=async()=>{try{if(quoteExpired(quote))throw Error('Quote expired; request a new quote');
    saveCheckout({quote,sender:wallet()?.accountId,service:quote.service});
    await review(quote.unsignedAction,`Pay for ${quote.service}`,'ctl-checkout-status',{ownerRequired:false,kind:'service_payment',quote});
  }catch(error){note('ctl-checkout-status',error.message)}};
  $('ctl-start').onclick=async()=>{try{const saved=checkout(),jobId=Number($('ctl-job-id').value);
    if(!saved?.quote||!Number.isSafeInteger(jobId)||jobId<1)throw Error('Reconcile the paid transaction to obtain its assigned job ID');
    const prepared=await api(`/v1/nfas/${id()}/services/${saved.service}/jobs/${jobId}/prepare-start`,{inputData:saved.quote.inputData});
    await review(prepared.unsignedAction,`Start ${saved.service} job #${jobId}`,'ctl-checkout-status',{ownerRequired:false,kind:'service_start'});
  }catch(error){note('ctl-checkout-status',error.message)}};
  $('ctl-refresh-job').onclick=async()=>{await reload();const saved=checkout();if(saved?.jobId)$('studio-recall-id').value=saved.jobId;$('studio-inspect-job').click()};
  $('ctl-unlist').onclick=()=>prepare('unlist',{},'Cancel listing','ctl-buy-status');
  $('ctl-buy').onclick=async()=>{try{const fresh=await api('/studio/nfas/'+id()),listing=fresh.identity.listing;
    if(!listing||fresh.identity.lifecycle!=='LISTED'||fresh.agent?.pending_op!=null)throw Error('No current transferable listing');
    const {unsignedAction}=await api('/prepare',{kind:'buy',tokenId:id(),nonce:listing.nonce,price:listing.price});
    await review(unsignedAction,'Buy the complete NFA','ctl-buy-status',{ownerRequired:false});
  }catch(error){note('ctl-buy-status',error.message)}};
  async function ownedWork(session,saved){
    const response=await fetch(`/studio/nfas/${saved.tokenId}/work/${saved.jobId}`,{method:saved.startHash?'POST':'GET',
      headers:{authorization:`Bearer ${session}`,...(saved.startHash?{'content-type':'application/json'}:{})},
      ...(saved.startHash?{body:JSON.stringify({startHash:saved.startHash,sender:saved.sender})}:{})});
    const result=await response.json();if(!response.ok)throw Error(result.error);
    $('ctl-work-output').textContent=JSON.stringify(result,null,2);note('ctl-work-status','Current owner and finalized output hash verified.');
  }
  $('ctl-open-work').onclick=async()=>{try{if(!wallet()?.accountId)throw Error('Connect the current owner wallet');
    const saved={tokenId:id(),jobId:Number($('ctl-job-id').value||$('studio-recall-id').value),
      startHash:$('ctl-start-hash').value.trim(),sender:$('ctl-start-sender').value.trim()};
    const challenge=await api('/auth/challenge',{accountId:wallet().accountId,tokenId:id(),studio:true});
    sessionStorage.setItem('nfa-studio-auth:'+challenge.challengeId,JSON.stringify(saved));
    const proof=await wallet().signMessage(challenge);if(!proof)return;
    const {session}=await api('/auth/session',{challengeId:challenge.challengeId,...proof});
    sessionStorage.removeItem('nfa-studio-auth:'+challenge.challengeId);await ownedWork(session,saved);
  }catch(error){note('ctl-work-status',error.message)}};
  async function handleAuthReturn(){const p=new URLSearchParams(location.hash.slice(1)),state=p.get('state');
    const raw=state&&sessionStorage.getItem('nfa-studio-auth:'+state);if(!raw)return;
    try{if(p.has('error'))throw Error('Wallet signature rejected');
      const {session}=await api('/auth/session',{challengeId:state,state,accountId:p.get('accountId'),publicKey:p.get('publicKey'),signature:p.get('signature')});
      await ownedWork(session,JSON.parse(raw));sessionStorage.removeItem('nfa-studio-auth:'+state);
      history.replaceState(null,'',location.pathname+location.search);
    }catch(error){note('ctl-work-status',error.message)}}
  function draw(s){
    const isOwner=wallet()?.accountId===s.identity.ownerAccountId&&s.capabilities.writable;
    for(const button of document.querySelectorAll('[data-owner]'))button.disabled=!isOwner;
    $('ctl-sign-transfer').disabled=true;simulation=null;
    const f=s.financial,b=s.vaultState?.daily_budget,cap=s.vaultState?.daily_cap;
    $('studio-treasury').insertAdjacentHTML('beforeend',[
      pair('Customer escrow',s.financialComplete?money(f?.customerEscrow):'Unavailable / incomplete'),
      pair('Replenishment liability (within escrow)',s.financialComplete?money(f?.replenishmentLiability):'Unavailable / incomplete'),
      pair('Recall funding pending',s.financialComplete?money(f?.recallFunding):'Unavailable / incomplete'),
      pair('OutLayer deposits today',s.vaultState?(b&&Number(b.day)===Math.floor(Date.now()/86400000)?money(b.deposits):money('0')):'Unavailable'),
      pair('Daily deposit cap',cap?money(cap):'Unavailable'),pair('Wallet payout credit',s.payout?money(s.payout.available):'Unavailable'),
      pair('Worst-case jobs funded',s.treasury?.available&&s.policies.scout?.max_deposit?
        String(BigInt(s.treasury.available)/BigInt(s.policies.scout.max_deposit)):'Configure a service to estimate')].join(''));
    const policy=s.transactionPolicy;
    if(policy){$('ctl-near-enabled').checked=policy.near_enabled;$('ctl-evm-enabled').checked=policy.evm_enabled;
      $('ctl-near-recipients').value=policy.near_recipients.join('\n');$('ctl-evm-recipients').value=policy.evm_recipients.join('\n');
      $('ctl-max-near').value=policy.max_near;$('ctl-max-evm').value=policy.max_evm;$('ctl-policy-fee').value=policy.max_fee;
      note('ctl-policy-status',`Active transaction policy for owner epoch ${policy.epoch}.`)}
    else note('ctl-policy-status','No current owner policy saved. Existing contract transfer limits apply.');
    $('ctl-grants').innerHTML=s.grants.map((g,i)=>`<p>${esc(g.delegate)} · ${esc(g.method)} · remaining ${esc(g.remaining)} · recipient ${esc(g.recipient||'N/A')} · expires ${esc(new Date(Number(BigInt(g.expires_at_ns)/1000000n)).toISOString())} <button class="secondary" data-revoke="${i}" ${isOwner?'':'disabled'}>Revoke</button></p>`).join('')||'<p class="small">No indexed active grants. Earlier contract grants can be inspected by delegate and method.</p>';
    for(const button of $('ctl-grants').querySelectorAll('[data-revoke]'))button.onclick=()=>{const g=s.grants[Number(button.dataset.revoke)];prepare('revoke',{delegate:g.delegate,method:g.method},'Revoke allowance','ctl-grant-status')};
    $('ctl-recovery').innerHTML=s.recovery.map((r,i)=>`<button class="secondary" data-recovery="${i}">${esc(r.label)}</button>`).join('')||`<p>${s.agent?.pending_op!=null?'Operation is pending; no safe retry is currently available. Inspect worker/receipt evidence.':'No operation requires recovery.'}</p>`;
    for(const button of $('ctl-recovery').querySelectorAll('[data-recovery]'))button.onclick=async()=>{try{const r=s.recovery[Number(button.dataset.recovery)],a=r.unsignedAction;
      const fresh=await api('/studio/recovery',{tokenId:id(),method:a.methodName,id:a.args.id,failedJobId:a.args.failed_job_id});
      await review(fresh.unsignedAction,fresh.label,'ctl-recovery-status',{ownerRequired:!!fresh.ownerRequired});
    }catch(error){note('ctl-recovery-status',error.message)}};
    $('studio-jobs').innerHTML=s.jobs.filter(r=>r.service||r.recall||r.legacy_job).map(r=>`<p><b>#${r.id}</b> ${esc(r.service?.service_id||r.recall&&'recall'||'legacy Scout')} · ${esc(r.service?.job.status||r.recall?.state||r.legacy_job?.status)}<br><span class="small">${esc(r.service?.job.output_hash||r.service?.job.input_hash||r.recall?.output_hash||'')}</span></p>`).join('')||'<p>No jobs recorded.</p>';
    $('studio-project').insertAdjacentHTML('beforeend',pair('Registry / vault / OutLayer agreement',s.projectAgreement?'Verified by current views':'Not verified'));
    const address=s.chainKey?.address||s.identity.foreignWallet?.address;
    if(/^0x[0-9a-fA-F]{40}$/.test(address||''))$('studio-chain').insertAdjacentHTML('beforeend',`<dt>Explorer</dt><dd><a href="https://sepolia.etherscan.io/address/${esc(address)}" target="_blank" rel="noreferrer">Sepolia account</a></dd>`);
    $('studio-service-list').innerHTML=s.availability.map(v=>`<p><b>${esc(v.id)}</b> · ${v.available?'Available':esc(v.reason)}<br><span class="small">Expected schema ${esc(v.schemaHash)}<br>API quote policy ${esc(JSON.stringify(v.quotePolicy))}</span></p>`).join('')||'<p>Service availability unavailable.</p>';
    const saved=checkout();if(saved?.jobId)$('ctl-job-id').value=saved.jobId;
    if(saved?.startHash)$('ctl-start-hash').value=saved.startHash;
    if(saved?.startSender)$('ctl-start-sender').value=saved.startSender;
    $('ctl-unlist').disabled=!isOwner||s.identity.lifecycle!=='LISTED';
    $('ctl-buy').disabled=!s.identity.listing||s.agent?.pending_op!=null||isOwner;
    $('studio-inventory').insertAdjacentHTML('beforeend',`<dl class="kv">${pair('Finalized service jobs',s.jobs.filter(r=>r.service?.job.status==='FINALIZED').length)}${pair('Customer escrow',s.financialComplete?money(f?.customerEscrow):'Unavailable')}${pair('Active epoch grants',s.grants.length+' (invalidated on transfer)')}${pair('Transaction policy',policy?'Invalidated on transfer':'None for current epoch')}</dl>`);
    const journal=JSON.parse(localStorage.getItem('nfa-studio-receipts')||'[]').filter(r=>r.tokenId===id()&&r.registry===s.identity.registryAccountId);
    $('ctl-audit').innerHTML=[...s.audit].reverse().map(e=>{const receipt=journal.find(r=>r.events?.some(x=>x.event===e.event&&JSON.stringify(x.data)===JSON.stringify(e.data)));
      return `<p><b>${esc(e.event)}</b> · block ${esc(e.block_height)} ${receipt?`· <a href="https://testnet.nearblocks.io/txns/${esc(receipt.hash)}" target="_blank" rel="noreferrer">Transaction</a>`:''}<br><span class="small">${esc(JSON.stringify(e.data))}</span></p>`}).join('')||'<p>No indexed audit events.</p>';
  }
  async function manifestHistory(manifest){const rows=[];let current=manifest;
    for(let i=0;current&&i<25;i++){rows.push(`<p>Revision ${esc(current.revision??0)} · ${esc(current.displayName)} · ${esc(current.publicCharacter?.imageHash)}</p>`);
      if(!current.previousManifestHash)break;try{current=current.previousManifestUri?.startsWith('https:')?
        await api('/studio/published-manifest?hash='+encodeURIComponent(current.previousManifestHash)+'&uri='+encodeURIComponent(current.previousManifestUri)):
        await api('/manifests/'+current.previousManifestHash.slice(7))}catch{rows.push('<p class="small">Earlier manifest is outside this store.</p>');break}}
    $('ctl-manifest-history').innerHTML=rows.join('')||'<p>No manifest revisions available.</p>';
  }
  async function init(){skills=(await api('/studio/skills')).items;
    $('studio-skills').innerHTML=skills.map(s=>`<div class="skill-card"><h3>${esc(s.id)}</h3><dl class="kv">${pair('Input schema',s.schemaHash)}${pair('Output schema',s.outputSchemaHash)}${pair('Memory namespace',s.namespace)}${pair('Operations',s.operations.join(', '))}${pair('Tools',s.tools.join(', '))}${pair('Reviewed releases',JSON.stringify(s.releases))}</dl></div>`).join('');
    const storage=await api('/studio/storage');if(!storage.durableConfigured)note('studio-character-status','Artifacts use local disk. Configure durable storage before a public mint.');
    releases=(await api('/studio/releases')).releases;
    $('ctl-release').innerHTML=releases.map(r=>`<option value="${esc(r.id)}">${esc(r.id)} · ${esc(r.hostedStatus)}</option>`).join('');
    $('ctl-release').value=releases.at(-1)?.id||'';$('ctl-release').onchange();
    $('studio-service').addEventListener('change',()=>{const skill=skills.find(s=>s.id===$('studio-service').value);if(skill)$('studio-schema').value=skill.schemaHash;
      $('studio-sample').value=JSON.stringify(samples[$('studio-service').value],null,2)});
    $('studio-schema').value=skills.find(s=>s.id==='scout').schemaHash;await handleAuthReturn();
  }
  init().catch(error=>note('studio-status',error.message));
  return {draw,manifestHistory,checkout,saveCheckout};
}
