import {readFile} from 'node:fs/promises';
const html=await readFile(new URL('../apps/web/index.html',import.meta.url),'utf8');
const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(match=>match[1]);
if(new Set(ids).size!==ids.length)throw Error('Duplicate static element IDs can hide or misroute Studio controls');
if(html.indexOf('<dialog id="studio-review"')<html.indexOf('</main>'))
  throw Error('Wallet review dialog must be outside the panels that navigation hides');
for(const match of html.matchAll(/data-studio="([^"]+)"/g))if(!ids.includes('studio-'+match[1]))throw Error('Studio tab has no panel');
console.log('Studio element IDs, tabs and review dialog checked');
const landing=await readFile(new URL('../apps/web/landing.html',import.meta.url),'utf8');
const landingIds=[...landing.matchAll(/\bid="([^"]+)"/g)].map(match=>match[1]);
if(new Set(landingIds).size!==landingIds.length)throw Error('Duplicate landing section IDs');
if(!landing.includes('href="/studio"')||!landing.includes('research-demo.mp4')||
  !landing.includes('D2WAQrDWSLV6G76HiJTsm5wM2oCQxRahQsucsB4yKXDW')||
  !landing.includes('29cPB4NvQasi1kLeCSXoj5hVZTddxraPMnB9pY1mUGBP'))
  throw Error('Landing page must link Studio and the recorded seller and buyer Research proof');
console.log('Landing Studio and live-evidence links checked');
