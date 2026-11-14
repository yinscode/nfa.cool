#!/usr/bin/env node
// NFA explainer: a motion piece in the Studio's visual language. Every frame is an SVG that is
// a pure function of time, rasterized with sharp and encoded by ffmpeg. Deterministic, offline.
//   node video/render.mjs                      → video/nfa-explainer.mp4
//   node video/render.mjs --still 12.5 [file]  → one PNG frame for review
//   node video/render.mjs --stills             → video/stills/*.png (one per scene)
import {spawn,execFileSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {cpus} from 'node:os';
import sharp from 'sharp';

const here=dirname(fileURLToPath(import.meta.url)),root=join(here,'..');
const W=1920,H=1080,FPS=30;
const C={bg:'#f6f4ee',paper:'#fffdf8',ink:'#233333',forest:'#244d3e',sage:'#5e8976',mist:'#e7f2e9',moss:'#e9efe5',
  line:'#dce2d7',muted:'#617267',eyebrow:'#7a9e86',sky:'#79BEE9',cobalt:'#667DDA',mint:'#91D8B9',butter:'#F0D66F',
  rose:'#E69FB8',coral:'#EE8F85',ice:'#97DDE2',lilac:'#B69ADD',citrus:'#B8E82E',amber:'#d99a2b',red:'#c8574b'};
const FONT=`Inter, 'Helvetica Neue', Helvetica, Arial, sans-serif`,MONO=`'SF Mono', Menlo, monospace`;

// ---------- characters (regenerated deterministically from the project's generator) ----------
const cache=join(here,'.cache','chars');
if(!existsSync(join(cache,'cutouts','001.png')))
  execFileSync(process.execPath,['generate.cjs','--preset','mixed-v2','--out',cache],{cwd:root,stdio:'ignore'});
const CH={};
for(const [name,id] of Object.entries({scout:'001',sage:'002',muse:'003',patch:'004',atlas:'005',quill:'007',pip:'008',lime:'010',star:'011',orange:'012'}))
  CH[name]='data:image/png;base64,'+(await sharp(join(cache,'cutouts',id+'.png')).resize(420,420).png().toBuffer()).toString('base64');

// ---------- timing helpers ----------
const clamp=(x,a=0,b=1)=>Math.min(b,Math.max(a,x));
const lerp=(a,b,t)=>a+(b-a)*t;
const ease=t=>{t=clamp(t);return t<.5?4*t*t*t:1-Math.pow(-2*t+2,3)/2};
const out=t=>{t=clamp(t);return 1-Math.pow(1-t,3)};
const back=t=>{t=clamp(t);const c=1.6;return 1+(c+1)*Math.pow(t-1,3)+c*Math.pow(t-1,2)};
const seg=(t,a,b)=>clamp((t-a)/(b-a));
const fade=(t,a,d=.5)=>out(seg(t,a,a+d));
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));

// ---------- drawing primitives ----------
const text=(x,y,s,{size=32,weight=500,fill=C.ink,anchor='start',opacity=1,ls=0,family=FONT}={})=>
  `<text x="${x}" y="${y}" font-family="${family}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}" opacity="${opacity}" letter-spacing="${ls}">${esc(s)}</text>`;
const g=(inner,{x=0,y=0,s=1,o=1,r=0,ox=0,oy=0}={})=>
  `<g transform="translate(${x} ${y}) rotate(${r} ${ox} ${oy}) translate(${ox} ${oy}) scale(${s}) translate(${-ox} ${-oy})" opacity="${clamp(o)}">${inner}</g>`;
const rect=(x,y,w,h,{rx=24,fill=C.paper,stroke=C.line,sw=2,opacity=1}={})=>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" opacity="${opacity}"/>`;
const pill=(x,y,label,{fill=C.mist,color=C.forest,size=22,pad=18,h=44,weight=700}={})=>{
  const w=label.length*size*.56+pad*2;
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h/2}" fill="${fill}"/>`+text(x+w/2,y+h/2+size*.36,label,{size,weight,fill:color,anchor:'middle'});
};
const pillWidth=(label,size=22,pad=18)=>label.length*size*.56+pad*2;
const brand=(x,y,size=40,opacity=1,anchor='start')=>
  `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" font-weight="800" letter-spacing="${-size*.06}" fill="${C.ink}" text-anchor="${anchor}" opacity="${opacity}">nfa<tspan fill="${C.sage}">.cool</tspan></text>`;
const img=(href,x,y,size,opacity=1)=>`<image href="${href}" x="${x}" y="${y}" width="${size}" height="${size}" opacity="${opacity}"/>`;
const check=(x,y,s=1,color=C.sage)=>`<g transform="translate(${x} ${y}) scale(${s})"><circle r="16" fill="${color}"/><path d="M-7 0 l5 5 l9 -10" stroke="#fff" stroke-width="3.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></g>`;
const cross=(x,y,s=1)=>`<g transform="translate(${x} ${y}) scale(${s})"><circle r="16" fill="${C.red}"/><path d="M-6 -6 L6 6 M6 -6 L-6 6" stroke="#fff" stroke-width="3.6" stroke-linecap="round"/></g>`;
let gid=0;
// The collection card: the NFA "token".
function nftCard(x,y,w,char,{tint=C.sky,id='001',name='Scout 01',sub='pebble / sprout',o=1,label='nfa.cool',bob=0}={}){
  const k=w/768,i=++gid;
  return `<g transform="translate(${x} ${y}) scale(${k})" opacity="${o}"><defs><linearGradient id="card${i}" x2="1" y2="1"><stop stop-color="#fffdf8"/><stop offset="1" stop-color="${tint}" stop-opacity=".32"/></linearGradient></defs>
    <rect x="6" y="14" width="756" height="756" rx="40" fill="#234d3d" opacity=".06"/>
    <rect x="0" y="0" width="768" height="768" rx="38" fill="url(#card${i})" stroke="${tint}" stroke-opacity=".55" stroke-width="3"/>
    <circle cx="120" cy="190" r="90" fill="${tint}" opacity=".16"/><circle cx="660" cy="430" r="120" fill="${tint}" opacity=".12"/>
    <ellipse cx="384" cy="628" rx="230" ry="26" fill="${tint}" opacity=".2"/>
    ${img(char,96,86+bob,576)}
    ${text(48,66,label,{size:24,weight:800})}${text(720,66,'#'+id,{size:22,family:MONO,fill:C.muted,anchor:'end'})}
    ${text(48,708,name,{size:38,weight:800})}${text(48,742,sub,{size:20,fill:C.muted})}</g>`;
}
// Small line icons (24px grid, scaled).
const ICON={
  wallet:`<rect x="2" y="6" width="20" height="14" rx="3"/><path d="M2 10h20M16 15h2"/><path d="M5 6l10-3 2 3"/>`,
  chip:`<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>`,
  shop:`<path d="M3 9l2-5h14l2 5"/><path d="M4 9v11h16V9"/><path d="M3 9h18"/><path d="M9 20v-6h6v6"/>`,
  brain:`<path d="M9 4a3 3 0 00-3 3 3 3 0 00-2 5 3 3 0 002 5 3 3 0 006 1V5a2 2 0 00-3-1z"/><path d="M15 4a3 3 0 013 3 3 3 0 012 5 3 3 0 01-2 5 3 3 0 01-6 1"/>`,
  user:`<circle cx="12" cy="8" r="4"/><path d="M4 21c1-5 5-7 8-7s7 2 8 7"/>`,
  lock:`<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 018 0v3"/>`,
  unlock:`<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 017.5-2"/>`,
  key:`<circle cx="8" cy="12" r="4"/><path d="M12 12h9M18 12v3M21 12v2"/>`,
  coin:`<circle cx="12" cy="12" r="9"/><path d="M12 7v10M9.5 9.5h3.5a1.8 1.8 0 010 3.5h-2a1.8 1.8 0 000 3.5H14"/>`,
  shield:`<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M8.5 12l2.5 2.5 4.5-5"/>`,
  box:`<path d="M3 7l9-4 9 4v10l-9 4-9-4z"/><path d="M3 7l9 4 9-4M12 11v10"/>`,
  link:`<path d="M10 14a4 4 0 006 0l3-3a4 4 0 00-6-6l-1 1"/><path d="M14 10a4 4 0 00-6 0l-3 3a4 4 0 006 6l1-1"/>`,
};
const icon=(name,x,y,size=48,color=C.forest,sw=1.8)=>`<g transform="translate(${x} ${y}) scale(${size/24})" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${ICON[name]}</g>`;
const iconTile=(name,x,y,{size=88,fill=C.mist,color=C.forest}={})=>`<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="${size*.28}" fill="${fill}"/>`+icon(name,x+size*.22,y+size*.22,size*.56,color);
const caption=(s,t,a,b)=>{const o=fade(t,a,.6)*(1-seg(t,b-.5,b));
  return text(W/2,1010,s,{size:30,weight:500,fill:C.muted,anchor:'middle',opacity:o})};
const eyebrow=(x,y,s,o=1)=>text(x,y,s.toUpperCase(),{size:20,weight:800,ls:4,fill:C.eyebrow,opacity:o});

// ---------- scenes ----------
const scenes=[];
const scene=(dur,draw)=>scenes.push({dur,draw});

// 1. NFT → NFA
scene(7.5,t=>{
  let s=brand(W/2,150,44,fade(t,.2,.8),'middle');
  const lettersIn=fade(t,.6,.9),flip=ease(seg(t,2.6,3.6));
  const cx=W/2,y=560,size=280;
  s+=text(cx-210,y,'N',{size,weight:800,anchor:'middle',ls:-10,opacity:lettersIn})+text(cx,y,'F',{size,weight:800,anchor:'middle',opacity:lettersIn});
  // T rotates away, A drops in.
  s+=g(text(0,0,'T',{size,weight:800,anchor:'middle'}),{x:cx+210,y,r:flip*80,ox:0,oy:-90,o:lettersIn*(1-flip)});
  s+=g(text(0,0,'A',{size,weight:800,anchor:'middle',fill:C.sage}),{x:cx+210,y:y-260*(1-back(seg(t,3.2,4.2))),o:fade(t,3.2,.4)});
  s+=text(cx,y+110,'Non-Fungible Agent',{size:56,weight:700,anchor:'middle',fill:C.forest,opacity:fade(t,4.1,.7),ls:-1.5});
  s+=text(cx,y+190,'An NFT that is a working agent — and everything it needs to run.',{size:34,anchor:'middle',fill:C.muted,opacity:fade(t,5,.7)});
  s+=g(img(CH.scout,0,0,220),{x:W-360,y:690-40*out(seg(t,5.4,6.4)),o:fade(t,5.4,.6)});
  s+=g(img(CH.muse,0,0,180),{x:150,y:740-40*out(seg(t,5.7,6.7)),o:fade(t,5.7,.6)});
  return s;
});

// 2. What an NFA contains
scene(15,t=>{
  let s=eyebrow(120,150,'Inside one NFA',fade(t,.1))+text(120,225,'Not a picture. A whole agent business.',{size:64,weight:800,ls:-2.5,opacity:fade(t,.2)});
  const bob=Math.sin(t*2)*6;
  s+=nftCard(120,300,560,CH.scout,{tint:C.sky,o:fade(t,.4,.7),bob});
  const groups=[
    {at:1.6,icon:'wallet',title:'Wallets',body:'Keyless NEAR vault holds the treasury',chips:['NEAR vault','Sepolia address']},
    {at:4.0,icon:'chip',title:'Skills',body:'Pinned WASM code, versioned by hash',chips:['Scout','Compare','Research']},
    {at:6.4,icon:'shop',title:'Services',body:'Paid jobs: quote → pay → result',chips:['escrow','income']},
    {at:8.8,icon:'brain',title:'Memory & history',body:'Encrypted work the next job can recall',chips:['finalized work','audit']},
  ];
  groups.forEach((gr,i)=>{
    const p=back(seg(t,gr.at,gr.at+.7)),o=fade(t,gr.at,.4),y=300+i*148,x=800+(1-p)*60;
    s+=`<path d="M680 ${580} C 740 ${580}, 740 ${y+64}, ${x} ${y+64}" stroke="${C.line}" stroke-width="3" fill="none" stroke-dasharray="6 8" opacity="${o}"/>`;
    let card=rect(0,0,1000,128,{rx:26})+iconTile(gr.icon,22,20,{size:88})+text(136,58,gr.title,{size:36,weight:800,ls:-1})+text(136,98,gr.body,{size:24,fill:C.muted});
    let cx=1000-24;for(const chip of [...gr.chips].reverse()){const w=pillWidth(chip,20,16);cx-=w;card+=g(pill(0,0,chip,{size:20,pad:16,h:40}),{x:cx,y:44,o:fade(t,gr.at+.5+.15*gr.chips.indexOf(chip),.35)});cx-=10}
    s+=g(card,{x,y,o});
  });
  s+=caption('Selling the token sells all of it — the business, not just the art.',t,10.5,15);
  return s;
});

// 3. How the agent runs
scene(16,t=>{
  let s=eyebrow(120,150,'How it runs',fade(t,.1))+text(120,225,'On demand, per job — in attested code.',{size:64,weight:800,ls:-2.5,opacity:fade(t,.2)});
  const nodes=[
    {x:120,label:'Customer',sub:'or another agent',icon:'user'},
    {x:570,label:'Registry',sub:'escrow · policy · epoch',icon:'shield'},
    {x:1020,label:'Vault',sub:'the agent’s own account',icon:'wallet'},
    {x:1470,label:'OutLayer',sub:'TEE runs the pinned skill',icon:'chip'},
  ];
  const y=360;
  nodes.forEach((n,i)=>{const o=fade(t,.6+i*.35);
    s+=g(rect(0,0,330,190,{rx:30})+iconTile(n.icon,26,26,{size:84})+text(128,82,n.label,{size:34,weight:800,ls:-1})+text(28,152,n.sub,{size:23,fill:C.muted}),{x:n.x,y,o});
  });
  // Arrows between nodes with step labels.
  const steps=[['1  Quote & pay',.0],['2  Dispatch job',1],['3  Execute',2]];
  steps.forEach(([label,i])=>{const x0=nodes[i].x+330,x1=nodes[i+1].x,o=fade(t,2.2+i*.3);
    s+=`<g opacity="${o}"><path d="M${x0+12} ${y+95} H${x1-16}" stroke="${C.sage}" stroke-width="4"/><path d="M${x1-30} ${y+83} L${x1-14} ${y+95} L${x1-30} ${y+107}" stroke="${C.sage}" stroke-width="4" fill="none"/></g>`;
    s+=g(pill(0,0,label,{size:20,pad:14,h:38}),{x:(x0+x1)/2-pillWidth(label,20,14)/2,y:y+212,o});
  });
  // A job packet travels: customer → registry → vault → TEE, then the result returns.
  const go=seg(t,3.6,8.6),ret=seg(t,8.9,11.4);
  const path=nodes.map(n=>n.x+165);
  if(go>0&&go<1){const k=go*3,i=Math.min(2,Math.floor(k)),px=lerp(path[i],path[i+1],ease(k-i));
    s+=g(`<circle r="26" fill="${C.butter}" stroke="#fff" stroke-width="4"/>`+icon('coin',-14,-14,28,C.ink,2),{x:px,y:y+95})}
  // The result returns on its own lane under the boxes: TEE → vault callback → registry.
  const lane=y+305,laneO=fade(t,8.7,.4)*(1-seg(t,11.4,11.9));
  s+=`<path d="M${path[3]} ${y+192} V${lane} H${path[1]} V${y+192}" stroke="${C.forest}" stroke-width="3" stroke-dasharray="8 10" fill="none" opacity="${laneO*.6}"/>`;
  if(ret>0&&ret<1){const px=lerp(path[3],path[1],ease(ret));
    s+=g(`<rect x="-80" y="-24" width="160" height="48" rx="24" fill="${C.forest}"/>`+text(0,8,'result ✓',{size:22,weight:800,fill:'#fff',anchor:'middle'}),{x:px,y:lane})}
  // Outcomes.
  const res=[{at:11.2,icon:'box',title:'Output commitment',sub:'hash on chain, artifact in the Project'},
    {at:11.7,icon:'coin',title:'Income to the agent',sub:'claimable by whoever owns it'},
    {at:12.2,icon:'brain',title:'Memory in the vault’s cell',sub:'survives any change of owner'}];
  res.forEach((r,i)=>{s+=g(rect(0,0,560,120,{rx:26,fill:C.mist,stroke:C.mist})+iconTile(r.icon,20,18,{size:84,fill:'#fff'})+text(124,56,r.title,{size:30,weight:800,ls:-.8})+text(124,92,r.sub,{size:22,fill:C.muted}),
    {x:120+i*600,y:680+30*(1-out(seg(t,r.at,r.at+.6))),o:fade(t,r.at)})});
  s+=caption('Pinned code, attested runs. Payments escrow until the result is committed.',t,4,16);
  return s;
});

// 4. Clean transfer
scene(19,t=>{
  let s=eyebrow(120,150,'Transfer',fade(t,.1))+text(120,225,'Sell the agent, not the keys.',{size:64,weight:800,ls:-2.5,opacity:fade(t,.2)});
  const swing=ease(seg(t,8.6,10.2));            // ownership moves Alice → Bob
  const card=nftCard(760,300,400,CH.scout,{tint:C.sky,o:fade(t,.4),bob:Math.sin(t*2)*5});
  // Owners.
  const person=(x,name,letter,tint,active)=>g(`<circle cx="110" cy="110" r="100" fill="${tint}" opacity=".35"/><circle cx="110" cy="110" r="100" fill="none" stroke="${active?C.forest:C.line}" stroke-width="${active?5:3}"/>`
    +text(110,140,letter,{size:84,weight:800,anchor:'middle',fill:C.forest})+text(110,262,name,{size:34,weight:800,anchor:'middle'}),{x,y:360});
  s+=g(person(0,'Alice','A',C.rose,swing<.5),{x:140,o:fade(t,.6)})+g(person(0,'Bob','B',C.mint,swing>=.5),{x:1560,o:fade(t,.8)});
  // Control arrow from the current owner to the token.
  const ax=lerp(360,1560,swing),bx=lerp(760,1160,swing);
  s+=`<g opacity="${fade(t,1)}"><path d="M${ax} 470 C ${(ax+bx)/2} 400, ${(ax+bx)/2} 400, ${bx} 470" stroke="${C.forest}" stroke-width="5" fill="none"/>`
    +`<circle cx="${bx}" cy="470" r="10" fill="${C.forest}"/></g>`;
  const epoch=swing<.5?1:2;
  s+=g(pill(0,0,`owner epoch ${epoch}`,{fill:epoch===2?C.forest:C.mist,color:epoch===2?'#fff':C.forest,size:24,h:48}),{x:860,y:250,o:fade(t,1.2)});
  s+=card;
  // Pending work blocks the sale.
  const pend=fade(t,2.2)*(1-seg(t,5.8,6.3));
  s+=g(pill(0,0,'job in flight',{fill:'#fdf1dc',color:C.amber,size:22})+icon('lock',-8+pillWidth('job in flight',22)+14,8,30,C.amber),{x:820,y:720,o:pend});
  const lockState=t<5.9?'lock':'unlock';
  s+=g(rect(0,0,330,92,{rx:22,fill:t<5.9?'#fdf1dc':C.mist,stroke:'none'})+icon(lockState,22,22,48,t<5.9?C.amber:C.forest)
    +text(86,58,t<5.9?'Sale blocked':'Free to sell',{size:30,weight:800,fill:t<5.9?C.amber:C.forest}),{x:140,y:700,o:fade(t,2.6)*(1-seg(t,8.2,8.6))});
  s+=g(check(0,0,1.4),{x:1040,y:742,o:fade(t,5.8,.3)*(1-seg(t,7.6,8))});
  s+=g(pill(0,0,'listed · 1 NEAR',{fill:C.butter,color:C.ink,size:22}),{x:880,y:720,o:fade(t,6.6)*(1-seg(t,8.6,9))});
  // What stays attached.
  const keep=['Same vault','Same Sepolia address','Same Project','Same memory & income'];
  keep.forEach((label,i)=>{const o=fade(t,10.6+i*.35);
    s+=g(rect(0,0,400,76,{rx:20})+check(38,38,.95)+text(70,47,label,{size:25,weight:700}),{x:120+i*420,y:840,o})});
  // What dies with the old epoch.
  const old=['session','delegate grant','NFT approval'];
  old.forEach((label,i)=>{const o=fade(t,2.8+i*.2)*(1-seg(t,13.5,14.2)),dead=seg(t,10.4+i*.15,10.9+i*.15),w=pillWidth(label,20);
    s+=g(pill(0,0,label,{fill:C.moss,color:C.muted,size:20,h:40})+`<path d="M10 20 H${w-10}" stroke="${C.red}" stroke-width="3" opacity="${dead}"/>`,
      {x:400,y:470+i*54,o:o*(1-dead*.45)});
  });
  s+=g(cross(0,0,1.1)+text(30,9,'old owner refused',{size:24,weight:700,fill:C.red}),{x:170,y:700,o:fade(t,11.2)*(1-seg(t,14.5,15))});
  s+=caption('One atomic transfer moves control. Pending authority must settle first; old grants die with the epoch.',t,1.5,19);
  return s;
});

// 5. NFA Studio
scene(15,t=>{
  let s=eyebrow(120,150,'NFA Studio',fade(t,.1))+text(120,225,'Create a working agent in four steps.',{size:64,weight:800,ls:-2.5,opacity:fade(t,.2)});
  const wx=120,wy=290,ww=1680,wh=640,o=fade(t,.4);
  let win=rect(0,0,ww,wh,{rx:26})+`<path d="M0 26a26 26 0 0126-26h${ww-52}a26 26 0 0126 26v50H0z" fill="#fffdf8"/>`
    +`<line x1="0" y1="76" x2="${ww}" y2="76" stroke="${C.line}" stroke-width="2"/>`
    +brand(34,52,30)+pill(200,18,'Create',{fill:C.mist,size:20,h:40})+text(340,46,'Studio',{size:20,weight:650,fill:C.muted})+text(430,46,'Market',{size:20,weight:650,fill:C.muted})
    +text(ww-30,46,'alice.test.near',{size:20,fill:C.muted,anchor:'end'});
  const stepNames=['Purpose','Identity','Services & budget','Launch'];
  const active=Math.min(3,Math.floor(seg(t,1.4,12.4)*4));
  let sx=34;stepNames.forEach((n,i)=>{const label=`${i+1}  ${n}`,w=pillWidth(label,22,20);
    win+=pill(sx,104,label,{fill:i===active?C.forest:i<active?C.mist:C.moss,color:i===active?'#fff':i<active?C.forest:C.muted,size:22,pad:20,h:48});sx+=w+12});
  // Left panel per step.
  const local=t-(1.4+active*2.75);
  let panel='';
  if(active===0){['Research analyst|Cited answers from approved sources','Comparison desk|Rank options by evidence','Custom service|Your own reviewed skill'].forEach((row,i)=>{
      const [a,b]=row.split('|'),on=i===0&&local>.8;
      panel+=g(rect(0,0,1000,104,{rx:20,fill:on?'#edf5eb':'#fff',stroke:on?'#498465':C.line})+`<circle cx="44" cy="52" r="13" fill="${on?C.forest:'#fff'}" stroke="${C.forest}" stroke-width="3"/>`
        +text(84,48,a,{size:28,weight:800})+text(84,82,b,{size:22,fill:C.muted}),{y:i*122,o:fade(local,i*.2)})});}
  if(active===1){const names=['Scout 01','Sage 01','Muse 01','Quill 01'];const k=Math.min(3,Math.floor(local/.6));
    panel+=text(0,30,'Name',{size:22,weight:700,fill:C.muted})+rect(0,44,620,70,{rx:14,fill:'#fff'})+text(24,90,names[0],{size:28,weight:600});
    panel+=text(0,170,'Appearance',{size:22,weight:700,fill:C.muted});
    [CH.scout,CH.sage,CH.muse,CH.quill].forEach((c,i)=>{panel+=rect(i*160,190,140,140,{rx:20,fill:C.moss,stroke:i===0&&local>2.2?C.forest:C.line,sw:i===0&&local>2.2?4:2})+img(c,i*160+8,198,124)});
    panel+=text(0,380,'body · expression · eyewear · accent — edit any trait later',{size:22,fill:C.muted})+ (k?'':'');}
  if(active===2){[['Scout','paid · margin 0.01 NEAR'],['Compare','paid · margin 0.01 NEAR'],['Research','candidate']].forEach(([a,b],i)=>{
      const on=i<2&&local>.4+i*.4;
      panel+=g(`<rect x="0" y="0" width="64" height="36" rx="18" fill="${on?C.forest:C.moss}"/><circle cx="${on?46:18}" cy="18" r="14" fill="#fff"/>`+text(90,28,a,{size:28,weight:800})+text(260,28,b,{size:22,fill:C.muted}),{y:i*78})});
    const fill=out(seg(local,1,2.2));
    panel+=text(0,290,'Operating budget',{size:22,weight:700,fill:C.muted})+rect(0,310,820,16,{rx:8,fill:C.moss,stroke:'none'})+rect(0,310,820*(.15+.45*fill),16,{rx:8,fill:C.sage,stroke:'none'})
      +`<circle cx="${820*(.15+.45*fill)}" cy="318" r="18" fill="#fff" stroke="${C.forest}" stroke-width="4"/>`+text(0,380,`${(1+3*fill).toFixed(1)} NEAR runway · spending policy with delegates`,{size:22,fill:C.muted});}
  if(active===3){['Mint the NFT','Create the keyless vault','Provision the vault-owned Project','Enable paid services','Pin the Sepolia address'].forEach((label,i)=>{
      const done=local>.35+i*.42;
      panel+=g((done?check(18,0,1):`<circle cx="18" cy="0" r="16" fill="none" stroke="${C.line}" stroke-width="3"/>`)+text(56,10,label,{size:28,weight:done?700:500,fill:done?C.ink:C.muted}),{y:20+i*66})});
    const p=seg(local,.3,2.6);panel+=rect(0,370,820,14,{rx:7,fill:C.moss,stroke:'none'})+rect(0,370,820*p,14,{rx:7,fill:C.sage,stroke:'none'});}
  win+=g(panel,{x:40,y:200});
  // Preview card.
  const preview=[CH.scout,CH.scout,CH.scout,CH.scout][active];
  win+=nftCard(ww-480,150,430,preview,{tint:C.sky,bob:Math.sin(t*2)*5,o:1});
  if(active===3&&local>2.5)win+=g(pill(0,0,'Live · earning',{fill:C.forest,color:'#fff',size:22}),{x:ww-400,y:560,o:fade(local,2.5,.4)});
  s+=g(win,{x:wx,y:wy+20*(1-out(seg(t,.4,1))),o});
  s+=caption('Resumable launch: every step is a reviewed transaction. REST, SDK and MCP for agents too.',t,1.2,15);
  return s;
});

// 6. Outro
scene(7.5,t=>{
  let s=text(W/2,420,'Own the whole agent.',{size:110,weight:800,anchor:'middle',ls:-5,opacity:fade(t,.3,.8)});
  s+=text(W/2,520,'Create.  Work.  Earn.  Sell.  Continue.',{size:44,weight:700,anchor:'middle',fill:C.sage,opacity:fade(t,1.2,.7)});
  const row=[CH.scout,CH.sage,CH.muse,CH.patch,CH.quill,CH.pip,CH.lime];
  row.forEach((c,i)=>{const a=1.8+i*.15,p=back(seg(t,a,a+.6));s+=g(img(c,0,0,200),{x:W/2-735+i*210,y:620+(1-p)*120,o:fade(t,a,.3)})});
  s+=brand(W/2,960,52,fade(t,2.8,.8),'middle');
  return s;
});

// ---------- timeline ----------
const XF=.6,starts=[];let total=0;for(const sc of scenes){starts.push(total);total+=sc.dur}
function frameSvg(time){
  let body='';
  scenes.forEach((sc,i)=>{
    const t=time-starts[i];if(t<-XF||t>sc.dur)return;
    const o=i>0?clamp((t+XF)/XF):1, end=i<scenes.length-1?1-clamp((t-(sc.dur-XF))/XF):1;
    const lift=(1-o)*20;body+=`<g opacity="${Math.min(o,end)}" transform="translate(0 ${lift})">${sc.draw(Math.max(0,t))}</g>`;
  });
  const p=time/total;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="${C.bg}"/>`
    +`<circle cx="${1700-80*p}" cy="${140+40*p}" r="320" fill="${C.mist}" opacity=".7"/><circle cx="${180+60*p}" cy="${980-40*p}" r="260" fill="#efeadb" opacity=".8"/>`
    +body+`<rect x="0" y="${H-6}" width="${W*p}" height="6" fill="${C.sage}" opacity=".5"/></svg>`;
}
const raster=time=>sharp(Buffer.from(frameSvg(time)),{density:72}).flatten({background:C.bg});

const args=process.argv.slice(2);
if(args[0]==='--still'){
  const file=args[2]||join(here,'still.png');await raster(Number(args[1])).png().toFile(file);console.log(file);
}else if(args[0]==='--stills'){
  await mkdir(join(here,'stills'),{recursive:true});
  for(const [i,sc] of scenes.entries()){const file=join(here,'stills',`scene-${i+1}.png`);await raster(starts[i]+sc.dur*.72).png().toFile(file);console.log(file)}
}else{
  const file=args[0]||join(here,'nfa-explainer.mp4'),frames=Math.round(total*FPS);
  const ff=spawn('ffmpeg',['-y','-loglevel','error','-f','rawvideo','-pix_fmt','rgb24','-s',`${W}x${H}`,'-r',String(FPS),'-i','-',
    '-c:v','libx264','-preset','slow','-crf','18','-pix_fmt','yuv420p','-movflags','+faststart',file],{stdio:['pipe','inherit','inherit']});
  const batch=Math.max(2,cpus().length);const t0=Date.now();
  for(let f=0;f<frames;f+=batch){
    const bufs=await Promise.all(Array.from({length:Math.min(batch,frames-f)},(_,k)=>raster((f+k)/FPS).removeAlpha().raw().toBuffer()));
    for(const b of bufs)if(!ff.stdin.write(b))await new Promise(r=>ff.stdin.once('drain',r));
    if((f/batch)%30===0)process.stdout.write(`\r${Math.round(100*f/frames)}%`);
  }
  ff.stdin.end();await new Promise((ok,fail)=>ff.on('close',c=>c===0?ok():fail(Error('ffmpeg exited '+c))));
  console.log(`\r${file} — ${total}s, ${frames} frames, ${Math.round((Date.now()-t0)/1000)}s to render`);
}
