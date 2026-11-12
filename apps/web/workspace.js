import {startWallet} from './wallet.js';
import {startStudio} from './studio.js';
import {startCreation} from './creation.js';
import {startProfile} from './profile.js';
import {profileLink} from './profile-link.mjs';
import {readTestnet,testnetViewConfig} from './browser-view.mjs';
const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function rawApi(path,body){const response=await fetch(path,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{});
  const value=await response.json();if(!response.ok)throw Error(value.error||`HTTP ${response.status}`);return value}
const baseConfig=await rawApi('/config');
const linkParams=new URLSearchParams(location.search),requestedNetwork=linkParams.get('network');
const viewMode=requestedNetwork?requestedNetwork==='testnet'&&baseConfig.network!=='testnet':localStorage.getItem('nfa-view-network')==='testnet';
if(requestedNetwork)localStorage.setItem('nfa-view-network',viewMode?'testnet':'workspace');
const config=viewMode?{...testnetViewConfig}:{...baseConfig};
if(linkParams.has('registry')&&linkParams.get('registry')!==config.registryAccountId||linkParams.has('workspace')&&linkParams.get('workspace')!==config.workspace?.id){$('network-detail').textContent='This link belongs to a different registry or sandbox workspace. Open it in the matching environment.';throw Error('Public profile network identity mismatch')}
const directRead=path=>/^\/studio\/(discover|owned|published-manifest|nfas\/)/.test(path);
async function api(path,body){
  if(config.readOnly&&config.network==='testnet'&&directRead(path)&&!body)return readTestnet(path);
  if(config.readOnly&&body&&!['/preview','/studio/simulate','/studio/releases/verify'].includes(path))throw Error('This public testnet view is read-only. Switch to your workspace for signing.');
  try{return await rawApi(path,body)}catch(error){
    if(config.network==='testnet'&&!body&&directRead(path)&&/fetch failed|RPC|timed out|abort/i.test(error.message)){
      config.readOnly=true;updateNetwork();return readTestnet(path);
    }
    throw error;
  }
}
const wallet=()=>config.readOnly?null:window.nfaWallet;
function updateNetwork(){
  $('network-badge').textContent=config.network==='sandbox'?'LOCAL SANDBOX':config.readOnly?'TESTNET · PUBLIC VIEW':'NEAR TESTNET';
  $('view-network').value=viewMode?'testnet':'workspace';
  $('network-detail').textContent=config.network==='sandbox'?(config.workspace?.persistent?'Persistent local chain · your NFAs survive restart':'Temporary local chain · restarting this older server resets its NFAs'):config.readOnly?'Live public chain reads in your browser · signing disabled':'Live testnet · transactions use testNEAR';
  const updated=import.meta.env.VITE_NFA_UPDATED_STUDIO_URL||'http://127.0.0.1:3102';
  if(baseConfig.serverVersion!==3&&updated&&new URL(updated).origin!==location.origin){const link=document.createElement('a');link.href=updated+'/studio';link.textContent='Open updated persistent Studio';$('network-detail').append(' · ',link)}
}
updateNetwork();
$('view-network').onchange=()=>{localStorage.setItem('nfa-view-network',$('view-network').value);location.href=$('view-network').value==='testnet'?'/studio?token=nfa-2':'/studio'};
function navigate(tab,token){
  for(const p of document.querySelectorAll('.panel'))p.classList.toggle('hidden',p.id!==tab);
  for(const b of document.querySelectorAll('nav [data-tab]'))b.classList.toggle('active',b.dataset.tab===tab);
  const path=tab==='create'?'/create':tab==='passport'?profileLink(location.origin,token||$('token-id').value,config).slice(location.origin.length):tab==='market'?'/studio?view=market':'/studio'+(token?'?token='+token:'');
  if(location.pathname+location.search!==path&&!['transactionHashes','errorCode'].some(k=>new URLSearchParams(location.search).has(k)))history.pushState(null,'',path);
  if(tab==='market')refreshMarket();
}
for(const b of document.querySelectorAll('nav [data-tab]'))b.onclick=()=>navigate(b.dataset.tab);
function updateWallet(){const account=wallet()?.accountId;$('wallet').textContent=config.readOnly?'Public testnet viewer':account?`Wallet: ${account}`:'Wallet disconnected';$('connect-wallet').textContent=account?'Disconnect':'Connect wallet';$('connect-wallet').disabled=!!config.readOnly}
$('connect-wallet').onclick=async()=>{try{if(wallet()?.accountId)await wallet().signOut();else wallet()?.connect()}catch(e){$('wallet').textContent=e.message}};
window.addEventListener('nfa-wallet-changed',updateWallet);
async function signed(action,target){if(!wallet()?.accountId)throw Error('Connect the current network wallet before signing');
  const result=await wallet().signAndSendTransaction(action);if($(target))$(target).textContent='Submitted. Confirm the finalized receipt before another action.';return result}
async function review(action,label,{beforeSign}={}){
  if(!wallet()?.accountId)throw Error('Connect a workspace wallet before signing');
  const dialog=$('studio-review');$('studio-review-context').textContent=`${label} · ${config.network.toUpperCase()} · Attached ${action.deposit} yoctoNEAR. Review target, arguments and deposit.`;
  $('studio-review-json').textContent=JSON.stringify(action,null,2);
  const accepted=await new Promise(resolve=>{const finish=value=>{dialog.close();resolve(value)};$('studio-review-sign').onclick=()=>finish(true);$('studio-review-cancel').onclick=()=>finish(false);dialog.oncancel=()=>resolve(false);dialog.showModal()});
  if(!accepted)return null;beforeSign?.();return wallet().signAndSendTransaction(action);
}
if(!config.readOnly)startWallet().then(updateWallet).catch(e=>{$('wallet').textContent=e.message});else updateWallet();
startStudio({api,wallet,signed,config});
startCreation({api,config,wallet,review,navigate,escape:esc});
startProfile({api,config,wallet,review,navigate,escape:esc});
const initial=location.pathname==='/create'?'create':location.pathname.startsWith('/nfa/')?'passport':new URLSearchParams(location.search).get('view')==='market'?'market':'studio';
navigate(initial,initial==='passport'?location.pathname.split('/')[2]:new URLSearchParams(location.search).get('token'));
async function refreshMarket(){try{
  if(config.readOnly)throw Error('Use a connected workspace API to trade. Public testnet inspection is available in My NFAs.');
  const result=await api('/market?limit=12');$('market-content').innerHTML='';
  for(const item of result.items){const card=document.createElement('article');card.className='card';card.innerHTML=`<h2>${esc(item.tokenId)}</h2><p>${esc(item.listing.price)} yoctoNEAR · offer #${item.listing.nonce}</p><p class="small">Vault ${esc(item.vaultAccountId)}</p>`;
    const profile=document.createElement('button');profile.className='secondary';profile.textContent='View public profile';profile.onclick=()=>window.dispatchEvent(new CustomEvent('nfa-profile',{detail:item.tokenId}));card.append(profile);
    const buy=document.createElement('button');buy.textContent='Review purchase';buy.onclick=async()=>{try{const {unsignedAction}=await api('/prepare',{kind:'buy',tokenId:item.tokenId,nonce:item.listing.nonce,price:item.listing.price});await review(unsignedAction,'Buy the complete NFA');await refreshMarket()}catch(e){$('market-status').textContent=e.message}};card.append(buy);$('market-content').append(card);
  }
  if(!result.items.length)$('market-content').textContent='No active listings in this page.';
  $('market-content').insertAdjacentHTML('beforeend','<p id="market-status" class="status"></p>');
}catch(e){$('market-content').textContent=e.message}}
$('refresh-market').onclick=refreshMarket;
