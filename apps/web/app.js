import '@near-wallet-selector/modal-ui/styles.css';
import {legacyWorkspaceRedirect} from './workspace-redirect.mjs';
try{
  const response=await fetch('/config');if(!response.ok)throw Error('Workspace configuration is unavailable');
  const config=await response.json(),params=new URLSearchParams(location.search);
  const redirect=legacyWorkspaceRedirect({href:location.href,config,
    target:import.meta.env.VITE_NFA_UPDATED_STUDIO_URL||'http://127.0.0.1:3102',
    account:params.get('localAccount')||localStorage.getItem('nfa-sandbox-wallet'),
    pending:!!(localStorage.getItem('nfa-studio-intent')||localStorage.getItem('nfa-create-intent'))});
  if(redirect){document.getElementById('network-detail').textContent='Opening your persistent workspace…';location.replace(redirect)}
  else await import('./workspace.js');
}catch(error){document.getElementById('network-detail').textContent='Unable to open Studio: '+error.message}
