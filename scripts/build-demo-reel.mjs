#!/usr/bin/env node
// Labeled replay of recorded results; this never fabricates a live wallet recording.
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import sharp from 'sharp';
const run=promisify(execFile),e=JSON.parse(await readFile('docs/evidence/release-demo.json','utf8'));
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
const near=s=>{const n=BigInt(s),f=(n%10n**24n).toString().padStart(24,'0').replace(/0+$/,'');return `${n/10n**24n}${f?'.'+f:''}`};
const slides=[
  ['Own the whole agent',['An NFT controls a persistent account, services and eligible work.',
    'Create. Work. Earn. Sell. Continue with the buyer.','Recorded evidence replay, not a continuous wallet recording.']],
  ['Create and configure',[`NFT: ${e.tokenId}`,`Vault: ${e.vault}`,'Scout and Compare enabled with bounded service budgets.',
    'A saved launch intent waits for exact receipt reconciliation.']],
  ['Work and earn',[`Finalized jobs: #${e.jobId} and #${e.nextPaidJobId}`,`Customer receipts: ${near(e.economics.grossCustomerReceipts)} testNEAR`,
    `Credited earnings: ${near(e.economics.creditedServiceEarnings)} testNEAR`,`Execution replenishment: ${near(e.economics.executionReplenishment)} testNEAR`,
    'Replenishment is a reserve. Net profit is not measured.']],
  ['Sell, then keep working',[`Buyer: ${e.owner}`,`Unchanged Project UUID: ${e.projectUuid}`,
    'Buyer recalls prior work and earns the next customer payment.','Seller session rejected. Pending work blocks sale.',
    'Restart preserves owner, avatar, vault, UUID and finalized work.']],
  ['Actual Studio after restart',['The next frame is the captured public profile.',
    'It shows Bob as owner, two jobs and separately labeled economics.']],
  ['Verified scope',[`${e.checks.length} local integration checks; 84 JavaScript tests.`,
    'Current video: local NEAR sandbox with an OutLayer mock.','Earlier hosted receipts are linked in the documentation.',
    'Reviewed testnet rollout and no-key Research smoke have separate receipts.',
    'Public hosting is deferred; real model Research remains open.']]
];
const directory=await mkdtemp(join(tmpdir(),'nfa-reel-')),frames=[];
try{
  for(const [index,[title,body]] of slides.entries()){
    let y=210,content='';
    for(const paragraph of body){
      const words=paragraph.split(' ');let line='';const lines=[];
      for(const word of words){if((line+' '+word).length>72&&line){lines.push(line);line=word}else line=(line+' '+word).trim()}
      if(line)lines.push(line);
      for(const value of lines){content+=`<text x="65" y="${y}" font-size="30" fill="#30483e">${esc(value)}</text>`;y+=41}y+=18;
    }
    const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><rect width="1280" height="720" fill="#f4f3ed"/>
      <g font-family="Arial,sans-serif"><text x="65" y="62" font-size="23" fill="#526d5e">nfa.cool / RELEASE EVIDENCE</text>
      <text x="65" y="150" font-size="52" fill="#223c32">${esc(title)}</text>${content}
      <rect y="659" width="1280" height="61" fill="#244b3c"/><text x="45" y="700" font-size="22" fill="white">LOCAL SANDBOX / OUTLAYER MOCK / NO REAL OR TESTNET FUNDS</text></g></svg>`;
    const file=join(directory,`${index}.png`);await sharp(Buffer.from(svg)).png().toFile(file);frames.push(file);
    if(index===4){
      const shot=sharp('docs/release-buyer-profile.jpg'),metadata=await shot.metadata();
      const bytes=await shot.extract({left:0,top:380,width:metadata.width,height:Math.min(750,metadata.height-380)}).resize(1280,659,{fit:'contain',background:'#f4f3ed'}).png().toBuffer();
      const footer=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="61"><rect width="1280" height="61" fill="#244b3c"/><text x="45" y="41" font-family="Arial,sans-serif" font-size="22" fill="white">ACTUAL LOCAL STUDIO CAPTURE / EVIDENCE REPLAY</text></svg>');
      const capture=join(directory,'capture.png');await sharp({create:{width:1280,height:720,channels:3,background:'#f4f3ed'}}).composite([{input:bytes,left:0,top:0},{input:footer,left:0,top:659}]).png().toFile(capture);frames.push(capture);
    }
  }
  const sequence=join(directory,'frames.txt');await writeFile(sequence,frames.map(f=>`file '${f}'\nduration 6\n`).join('')+`file '${frames.at(-1)}'\n`);
  const output=resolve('docs/release-evidence-walkthrough.mp4');
  await run('ffmpeg',['-y','-hide_banner','-loglevel','error','-f','concat','-safe','0','-i',sequence,
    '-vf','fps=24,format=yuv420p','-c:v','libx264','-preset','fast','-crf','22','-movflags','+faststart','-t',String(frames.length*6),output],{timeout:120000,maxBuffer:1000000});
  console.log(JSON.stringify({file:output,mode:'recorded_evidence_replay',seconds:frames.length*6}));
}finally{await rm(directory,{recursive:true,force:true})}
