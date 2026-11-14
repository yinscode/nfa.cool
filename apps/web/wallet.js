import {setupWalletSelector} from '@near-wallet-selector/core';
import {setupMyNearWallet} from '@near-wallet-selector/my-near-wallet';
import {setupModal} from '@near-wallet-selector/modal-ui';
import '@near-wallet-selector/modal-ui/styles.css';
import {toWalletSelectorActions,walletCallbackUrl} from './wallet-action.mjs';

/** All transactions remain wallet signed. The API never receives a private key. */
export async function startWallet(){
  const selectedLocalAccount=new URLSearchParams(location.search).get('localAccount');
  const config=await (await fetch('/config')).json();
  if(config.localSandbox){
    let account=selectedLocalAccount||localStorage.getItem('nfa-sandbox-wallet')||null;
    if(!config.localSandbox.accounts.includes(account))account=null;
    if(account)localStorage.setItem('nfa-sandbox-wallet',account);
    const select=document.createElement('select');select.setAttribute('aria-label','Local sandbox account');
    for(const id of ['',...config.localSandbox.accounts]){const option=document.createElement('option');option.value=id;option.textContent=id||'Sandbox wallet disconnected';select.append(option)}
    select.value=account||'';document.querySelector('header').append(select);
    const change=id=>{account=id||null;select.value=account||'';if(account)localStorage.setItem('nfa-sandbox-wallet',account);else localStorage.removeItem('nfa-sandbox-wallet');window.dispatchEvent(new Event('nfa-wallet-changed'))};
    select.onchange=()=>change(select.value);
    const post=async(path,body)=>{const r=await fetch(path,{method:'POST',headers:{'content-type':'application/json','x-nfa-local-wallet':'1'},body:JSON.stringify({accountId:account,...body})});
      const data=await r.json();if(!r.ok)throw Error(data.error);return data};
    const adapter={get accountId(){return account},connect(){change(config.localSandbox.accounts[0])},async signOut(){change(null)},
      signAndSendTransaction:action=>post('/dev/wallet/transaction',{action}),signMessage:challenge=>post('/dev/wallet/message',{challenge})};
    document.querySelector('footer').textContent='Demo workspace · OutLayer mock · No real or testnet funds';
    window.nfaWallet=adapter;window.dispatchEvent(new Event('nfa-wallet-changed'));return adapter;
  }
  const selector=await setupWalletSelector({network:'testnet',modules:[setupMyNearWallet()]});
  const modal=setupModal(selector,{contractId:config.registryAccountId,
    description:'Connect a testnet wallet to control or buy an NFA.'});
  const adapter={
    get accountId(){return selector.store.getState().accounts[0]?.accountId||null},
    connect(){modal.show()},
    async signOut(){const wallet=await selector.wallet();await wallet.signOut();location.reload()},
    async signAndSendTransaction(action){
      if(!this.accountId)throw Error('Connect a wallet first');
      const wallet=await selector.wallet();
      const actions=toWalletSelectorActions(action);
      return wallet.signAndSendTransaction({signerId:this.accountId,receiverId:action.receiverId,
        actions,callbackUrl:walletCallbackUrl(location)});
    },
    async signMessage(challenge){
      if(!this.accountId)throw Error('Connect a wallet first');
      const wallet=await selector.wallet();
      const nonce=Uint8Array.from(atob(challenge.nonce),c=>c.charCodeAt(0));
      return wallet.signMessage({message:challenge.message,nonce,recipient:challenge.recipient,
        callbackUrl:challenge.callbackUrl,state:challenge.challengeId});
    }
  };
  window.nfaWallet=adapter;
  selector.store.observable.subscribe(()=>window.dispatchEvent(new Event('nfa-wallet-changed')));
  window.dispatchEvent(new Event('nfa-wallet-changed'));
  return adapter;
}
