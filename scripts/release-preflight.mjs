#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import {reviewedPackages} from '../services/api/service-package.mjs';
const url=process.env.NFA_STUDIO_URL||'http://127.0.0.1:3102',live=process.argv.includes('--live');
const evidence=JSON.parse(await readFile('docs/evidence/release-demo.json','utf8'));
const tokenId=process.env.NFA_RELEASE_TOKEN_ID||(live?'nfa-2':evidence.tokenId);
if(!/^nfa-[1-9][0-9]*$/.test(tokenId))throw Error('Invalid release token ID');
const get=async path=>{const r=await fetch(url+path,{signal:AbortSignal.timeout(20000)});const body=await r.json();if(!r.ok)throw Error(`${path}: HTTP ${r.status}`);return body};
if(live&&new URL(url).protocol!=='https:')throw Error('Live preflight requires final HTTPS URL');
const config=await get('/config');
const [health,storage,spec,packages,economics,inventory]=await Promise.all([
  get('/healthz'),get('/studio/storage'),get('/openapi.json'),get('/v1/service-packages'),
  get(`/v1/nfas/${tokenId}/economics`),get(`/v1/nfas/${tokenId}/inventory`)]);
if(!health.ok||spec.openapi!=='3.1.0'||packages.items.length!==(await reviewedPackages()).length)throw Error('API release mismatch');
if(economics.netProfit!==null||!inventory.included.vault)throw Error('Accounting/inventory contract mismatch');
if(live){
  if(config.localSandbox||config.network!=='testnet'||config.publicOrigin!==new URL(url).origin||!storage.durableConfigured)
    throw Error('Final testnet origin and durable data required');
  await get('/readyz');
}
console.log(JSON.stringify({url,mode:config.network,registry:config.registryAccountId,
  liveDeploymentCheck:live,checks:6,research:packages.items.find(p=>p.id==='research').stage,
  durableConfigured:storage.durableConfigured,tokenId}));
