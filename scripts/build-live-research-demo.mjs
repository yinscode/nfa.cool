#!/usr/bin/env node
// Public evidence replay, assembled from completed testnet records.
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import sharp from 'sharp';
const run=promisify(execFile);
const [creation,seller,sale,buyer]=await Promise.all([
  readFile('docs/evidence/studio-testnet.json').then(JSON.parse),
  readFile('docs/evidence/paid-async-research-seller.json').then(JSON.parse),
  readFile('docs/evidence/async-research-handover.json').then(JSON.parse),
  readFile('docs/evidence/paid-async-research-buyer-accepted.json').then(JSON.parse)]);
if(seller.status!=='FINALIZED'||buyer.status!=='FINALIZED'||
  seller.tokenId!=='nfa-2'||buyer.tokenId!=='nfa-2'||
  sale.firstResearchJobId!==seller.jobId||sale.buyerRecallOutputHash!==seller.outputHash||
  seller.projectUuid!==buyer.projectUuid||sale.newEpoch!==buyer.ownerEpoch)
  throw Error('Complete seller, sale, recall and buyer Research evidence required');
const createTx=creation.steps?.mintStudioNfa?.hash;
if(!createTx)throw Error('Live creation receipt missing');
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
const near=s=>{const n=BigInt(s);return `${n/10n**24n}.${(n%10n**24n).toString().padStart(24,'0').slice(0,3)} testNEAR`};
const slides=[
  ['Create the NFA',[`NFA #2 minted on NEAR testnet.`,`Create transaction: ${createTx}`,
    `Vault: ${seller.tokenId}.nfagent-registry-0e9b2a.testnet`]],
  ['Customer pays for Research',[`Paid job #${seller.jobId}: ${near(seller.feeYocto)}`,
    `Payment transaction: ${seller.transactions[`${seller.label}ResearchPay`]?.hash}`,
    'The exact input and guest hash were committed before the HTTPS call.']],
  ['Model work becomes earnings',[`Research output: ${seller.outputHash}`,
    `Priced model usage: ${seller.pricedUsageMicrousd} microUSD`,
    `Settle transaction: ${seller.transactions[`${seller.label}ResearchSettle`]?.hash}`,
    `NFA income after settlement: ${near(seller.incomeYocto)}`]],
  ['Sell the working NFA',[`Seller: ${sale.seller}`,`Buyer: ${sale.buyer}`,
    `Sale transaction: ${sale.transactions.buyResearchNfa?.hash}`,
    `Owner epoch ${sale.oldEpoch} → ${sale.newEpoch}; same vault, address and Project UUID.`]],
  ['Buyer recalls and continues',[`Buyer recall matched job #${seller.jobId}: ${sale.buyerRecallOutputHash}`,
    `Buyer paid job #${buyer.jobId}: ${buyer.outputHash}`,
    `Settle transaction: ${buyer.transactions[`${buyer.label}ResearchSettle`]?.hash}`,
    'Buyer job received the seller-era finalized Research commitment.']],
  ['Verified scope',['Live NEAR testnet sale, payments and settlement; real NEAR AI inference through OutLayer.',
    'Former owner recall and stale upgrade approval were rejected.',
    'Evidence replay from separate receipts, not a continuous wallet screen recording.',
    'The operator reports HTTPS results; on-chain attestation verification is not implemented.']]
];
const directory=await mkdtemp(join(tmpdir(),'nfa-live-reel-')),frames=[];
try{
  for(const [index,[title,body]] of slides.entries()){
    let y=200,content='';for(const paragraph of body){let line='';for(const word of paragraph.split(' ')){
      if((line+' '+word).length>68&&line){content+=`<text x="62" y="${y}" font-size="28" fill="#30483e">${esc(line)}</text>`;y+=41;line=''}
      line=(line+' '+word).trim()}
      if(line){content+=`<text x="62" y="${y}" font-size="28" fill="#30483e">${esc(line)}</text>`;y+=41}y+=16}
    const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><rect width="1280" height="720" fill="#f4f3ed"/>
      <g font-family="Arial,sans-serif"><text x="62" y="60" font-size="23" fill="#526d5e">nfa.cool / LIVE TESTNET EVIDENCE</text>
      <text x="62" y="145" font-size="50" fill="#223c32">${esc(title)}</text>${content}
      <rect y="659" width="1280" height="61" fill="#244b3c"/><text x="42" y="700" font-size="21" fill="white">NEAR TESTNET / OUTLAYER HTTPS / EVIDENCE REPLAY</text></g></svg>`;
    const path=join(directory,`${index}.png`);await sharp(Buffer.from(svg)).png().toFile(path);frames.push(path)
  }
  const sequence=join(directory,'frames.txt');await writeFile(sequence,
    frames.map(f=>`file '${f}'\nduration 7\n`).join('')+`file '${frames.at(-1)}'\n`);
  const output=resolve('docs/research-live-evidence-replay.mp4');
  await run('ffmpeg',['-y','-hide_banner','-loglevel','error','-f','concat','-safe','0','-i',sequence,
    '-vf','fps=24,format=yuv420p','-c:v','libx264','-preset','fast','-crf','22','-movflags','+faststart',
    '-t',String(frames.length*7),output],{timeout:120000,maxBuffer:1000000});
  console.log(JSON.stringify({file:output,seconds:frames.length*7,
    mode:'live-testnet-evidence-replay'}));
}finally{await rm(directory,{recursive:true,force:true})}
