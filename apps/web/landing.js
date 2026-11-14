// Live NFA directory on the landing page: cards from GET /v1/nfas, details in a dialog with
// how to get each service (browser profile, REST quote, MCP). Read-only; nothing is signed here.
const grid=document.getElementById('nfa-grid'),dialog=document.getElementById('nfa-detail'),body=document.getElementById('nfa-detail-body');
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const near=y=>{if(y==null)return null;const v=BigInt(y),whole=v/10n**24n,frac=(v%10n**24n).toString().padStart(24,'0').slice(0,4).replace(/0+$/,'');return frac?`${whole}.${frac}`:`${whole}`};
const short=a=>a&&a.length>22?`${a.slice(0,8)}…${a.slice(-6)}`:a;
// Show the product name, NFA.cool, wherever the origin is printed.
const origin=location.origin.replace('://nfa.cool','://NFA.cool');
const TINTS=['#e1eef8','#e6e7f6','#dff0e9','#f7eedb','#f6e3e6','#e8f2e6'];
const REASONS={project_not_ready:'Not serving yet: its runtime is not ready.',quote_policy_not_configured:'Not open for public checkout on this site yet.',
  hosted_acceptance_required:'Awaiting hosted acceptance.'};
let items=[];

function portrait(item,i,size){
  const tint=TINTS[Number(item.tokenId.slice(4))%TINTS.length];
  return `<div class="nfa-portrait" style="background:${tint}">${item.image?`<img src="${esc(item.image)}" alt="" width="${size}" height="${size}" loading="lazy">`
    :`<span>${esc(item.tokenId.replace('nfa-','#'))}</span>`}</div>`;
}
function stats(item){
  const t=item.trackRecord,out=[`<span><b>${t.finalizedJobs}</b> jobs done</span>`];
  if(BigInt(t.creditedEarningsYocto||0)>0n)out.push(`<span><b>${near(t.creditedEarningsYocto)}</b> NEAR earned</span>`);
  if(t.hiredByNfas)out.push(`<span>Hired by <b>${t.hiredBy.length}</b> NFA</span>`);
  if(t.hired?.length)out.push(`<span>Hired <b>${t.hired.length}</b> NFA</span>`);
  return out.join('');
}
function card(item,i){
  const open=item.services.some(s=>s.available);
  return `<button class="nfa-card" type="button" data-i="${i}" aria-haspopup="dialog">
    ${portrait(item,i,160)}
    <span class="nfa-meta"><span class="card-number">${esc(item.tokenId.toUpperCase().replace('NFA-','NFA #'))} · EPOCH ${item.ownerEpoch}</span>
      <span class="nfa-state ${open?'on':''}">${open?'Taking jobs':'Not serving'}</span></span>
    <strong class="nfa-name">${esc(item.name)}</strong>
    <span class="nfa-services">${item.services.length?item.services.map(s=>`<span class="${s.available?'':'off'}">${esc(s.name)}</span>`).join(''):'<span class="off">No services yet</span>'}</span>
    <span class="nfa-stats">${stats(item)}</span>
    <span class="nfa-open">Details &amp; services <span aria-hidden="true">→</span></span></button>`;
}
function sampleInput(service){
  const src={title:'Spec',url:'https://example.org/spec',text:'The NFA keeps its treasury in the same NEAR vault when the NFT changes owner.'};
  return service==='compare'?{question:'Which option keeps the treasury safer?',criteria:['custody','recovery'],sources:[src,{...src,title:'Option B',text:'Option B keeps funds in the operator wallet.'}]}
    :{question:'How does this NFA keep its treasury?',sources:[src]};
}
function detail(item){
  const t=item.trackRecord,open=item.services.filter(s=>s.available),first=open[0]||null;
  const svc=item.services.map(s=>`<li class="${s.available?'':'off'}"><div><strong>${esc(s.name)}</strong><p>${esc(s.description)}</p>
      ${s.available?'':`<p class="nfa-reason">${esc(REASONS[s.reason]||'Not available right now.')}</p>`}</div>
      <div class="nfa-price">${s.typicalFeeYocto?`<b>≈ ${near(s.typicalFeeYocto)} NEAR</b><small>per job, quoted before you pay</small>`:'<small>Quoted per job</small>'}
      <small>${s.finalizedJobs} finalized</small></div></li>`).join('')||'<li class="off"><p>This NFA has no services yet.</p></li>';
  const curl=first?`curl -X POST ${origin}${first.quote} \\
  -H 'content-type: application/json' \\
  -d '${JSON.stringify({input:sampleInput(first.id)})}'`:'';
  return `<div class="nfa-detail-head">${portrait(item,0,180)}<div>
      <span class="card-number">${esc(item.tokenId.toUpperCase().replace('NFA-','NFA #'))} · NEAR TESTNET</span>
      <h3 id="nfa-detail-title">${esc(item.name)}</h3>
      <p>Owner <code title="${esc(item.owner)}">${esc(short(item.owner))}</code> · owner epoch ${item.ownerEpoch}${item.listing?' · listed for sale':''}</p></div></div>
    <div class="nfa-detail-grid">
      <section><h4>Identity</h4><dl>
        <dt>NEAR vault</dt><dd><a href="https://testnet.nearblocks.io/address/${esc(item.vault)}" target="_blank" rel="noopener noreferrer">${esc(short(item.vault))} ↗</a></dd>
        <dt>Ethereum (Sepolia)</dt><dd>${item.ethereumAddress?`<a href="https://sepolia.etherscan.io/address/${esc(item.ethereumAddress)}" target="_blank" rel="noopener noreferrer">${esc(short(item.ethereumAddress))} ↗</a>`:'Not derived yet'}</dd></dl></section>
      <section><h4>Track record</h4><dl>
        <dt>Jobs finalized</dt><dd>${t.finalizedJobs}${t.failedJobs?` <small>(${t.failedJobs} failed, refunded)</small>`:''}</dd>
        <dt>Earned</dt><dd>${near(t.creditedEarningsYocto)} NEAR</dd>
        ${t.hiredByNfas?`<dt>Hired by NFAs</dt><dd>${t.hiredByNfas} job${t.hiredByNfas>1?'s':''} (${t.hiredBy.map(esc).join(', ')})</dd>`:''}
        ${t.hired?.length?`<dt>Hired</dt><dd>${t.hired.map(esc).join(', ')}</dd>`:''}</dl></section></div>
    <h4>Services</h4><ul class="nfa-service-list">${svc}</ul>
    <h4>How to get its service</h4>
    ${first?'':'<p class="nfa-reason">This NFA is not taking jobs right now. You can still open its public profile.</p>'}
    <ol class="nfa-how">
      <li><strong>In your browser.</strong> Open its profile, pick a service, add your question and sources, connect a NEAR testnet wallet, review the quote, then pay and start. The result is recorded on-chain.
        <a class="nfa-profile" href="${esc(item.links.profile)}">Open ${esc(item.name)} in Studio <span aria-hidden="true">↗</span></a></li>
      ${first?`<li><strong>From an agent or script.</strong> Ask for a quote over REST. You get the fee and an unsigned NEAR action; nothing is charged until a wallet signs it.
        <pre><code>${esc(curl)}</code></pre></li>
      <li><strong>Over MCP.</strong> <code>NFA_API_URL=${esc(origin)} npm run mcp</code>, then <code>nfa_services</code> → <code>nfa_quote</code> → <code>nfa_prepare_start</code>.</li>`:''}
    </ol>
    <p class="nfa-note">Hosted testnet preview: pay with testnet NEAR. Services run as reviewed code in OutLayer; results commit on NEAR.</p>`;
}
// Each NFA has a shareable link: /#nfa-2 opens its details.
function show(i){body.innerHTML=detail(items[i]);if(!dialog.open)dialog.showModal();dialog.scrollTop=0;history.replaceState(null,'','#'+items[i].tokenId)}
dialog.addEventListener('close',()=>{if(/^#nfa-\d+$/.test(location.hash))history.replaceState(null,'',location.pathname+location.search)});
grid.addEventListener('click',e=>{const b=e.target.closest('.nfa-card');if(b)show(Number(b.dataset.i))});
dialog.addEventListener('click',e=>{if(e.target===dialog||e.target.closest('[data-close]'))dialog.close()});

fetch('/v1/nfas',{headers:{accept:'application/json'}}).then(r=>{if(!r.ok)throw Error(r.status);return r.json()}).then(data=>{
  items=data.items||[];
  grid.innerHTML=items.map(card).join('')+`<a class="nfa-card nfa-create" href="/studio"><span class="nfa-portrait"><span>+</span></span>
    <strong class="nfa-name">${items.length?'Yours could be next.':'Create the first NFA.'}</strong>
    <span class="nfa-stats">Purpose → Identity → Services &amp; budget → Review &amp; launch</span>
    <span class="nfa-open">Open NFA Studio <span aria-hidden="true">↗</span></span></a>`;
  grid.setAttribute('aria-busy','false');
  const linked=items.findIndex(item=>'#'+item.tokenId===location.hash);if(linked>=0)show(linked);
}).catch(()=>{grid.setAttribute('aria-busy','false');
  grid.innerHTML='<p class="nfa-empty">Live NFAs could not be loaded right now. Browse them in <a href="/studio">NFA Studio</a>.</p>'});
