#!/usr/bin/env node
// NFA explainer: a motion piece in the Studio's visual language. Every frame is an SVG that is
// a pure function of time, rasterized with sharp and encoded by ffmpeg. Deterministic, offline.
//   node video/render.mjs                      → video/nfa-explainer.mp4
//   node video/render.mjs --still 12.5 [file]  → one PNG frame for review
//   node video/render.mjs --stills             → video/stills/*.png (one per scene)
//   --no-music skips the background track from video/music.mjs
import {spawn,execFileSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {readFile,mkdir,writeFile,rename} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {cpus} from 'node:os';
import sharp from 'sharp';

const here=dirname(fileURLToPath(import.meta.url)),root=join(here,'..');
const W=1920,H=1080,FPS=30;
// Theme tokens: docs/THEME.md (cream, paper, ink, forest, leaf, mint, mist, line, muted).
const C={bg:'#f6f5ef',paper:'#fffefa',ink:'#1f3029',forest:'#204b38',sage:'#5d9a75',mist:'#e8f2e6',moss:'#eaf0e6',dot:'#8acb87',
  line:'#dee4d9',muted:'#64756a',eyebrow:'#6f9a80',sky:'#79BEE9',cobalt:'#667DDA',mint:'#91D8B9',butter:'#F0D66F',
  rose:'#E69FB8',coral:'#EE8F85',ice:'#97DDE2',lilac:'#B69ADD',citrus:'#B8E82E',amber:'#d99a2b',red:'#c8574b'};
const FONT=`Manrope, 'DM Sans', 'Helvetica Neue', Helvetica, Inter, Arial, sans-serif`,MONO=`'SF Mono', Menlo, monospace`;

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
  `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" font-weight="800" letter-spacing="${-size*.06}" fill="${C.ink}" text-anchor="${anchor}" opacity="${opacity}">NFA<tspan fill="${C.sage}">.cool</tspan><tspan fill="${C.dot}" font-size="${size*.42}" dy="${-size*.42}" dx="${size*.04}">●</tspan></text>`;
const img=(href,x,y,size,opacity=1)=>`<image href="${href}" x="${x}" y="${y}" width="${size}" height="${size}" opacity="${opacity}"/>`;
const check=(x,y,s=1,color=C.sage)=>`<g transform="translate(${x} ${y}) scale(${s})"><circle r="16" fill="${color}"/><path d="M-7 0 l5 5 l9 -10" stroke="#fff" stroke-width="3.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></g>`;
const cross=(x,y,s=1)=>`<g transform="translate(${x} ${y}) scale(${s})"><circle r="16" fill="${C.red}"/><path d="M-6 -6 L6 6 M6 -6 L-6 6" stroke="#fff" stroke-width="3.6" stroke-linecap="round"/></g>`;
let gid=0;
// The collection card: the NFA "token".
function nftCard(x,y,w,char,{tint=C.sky,id='001',name='Scout 01',sub='pebble / sprout',o=1,label='NFA.cool',bob=0}={}){
  const k=w/768,i=++gid;
  return `<g transform="translate(${x} ${y}) scale(${k})" opacity="${o}"><defs><linearGradient id="card${i}" x2="1" y2="1"><stop stop-color="${C.paper}"/><stop offset="1" stop-color="${tint}" stop-opacity=".32"/></linearGradient></defs>
    <rect x="6" y="14" width="756" height="756" rx="40" fill="#234d3d" opacity=".06"/>
    <rect x="0" y="0" width="768" height="768" rx="38" fill="url(#card${i})" stroke="${tint}" stroke-opacity=".55" stroke-width="3"/>
    <circle cx="120" cy="190" r="90" fill="${tint}" opacity=".16"/><circle cx="660" cy="430" r="120" fill="${tint}" opacity=".12"/>
    <ellipse cx="384" cy="628" rx="230" ry="26" fill="${tint}" opacity=".2"/>
    ${char?img(char,96,86+bob,576):''}
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
const caption=(s,t,a,b)=>{const o=fade(t,a,.6)*(1-seg(t,b-.5,b)),w=Math.min(1840,s.length*17.6+80);
  return `<rect x="${(W-w)/2}" y="966" width="${w}" height="62" rx="31" fill="#fffdf8" opacity="${o*.85}"/>`
    +text(W/2,1008,s,{size:32,weight:650,fill:C.forest,anchor:'middle',opacity:o})};
const eyebrow=(x,y,s,o=1)=>text(x,y,s.toUpperCase(),{size:20,weight:800,ls:4,fill:C.eyebrow,opacity:o});

// ---------- scenes ----------
const scenes=[];
const scene=(dur,draw)=>scenes.push({dur,draw});
// Extra glyphs for this cut.
Object.assign(ICON,{
  spark:`<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 16l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/>`,
  eth:`<path d="M12 2l7 10-7 4-7-4z"/><path d="M5 13.5l7 8.5 7-8.5-7 4z"/>`,
  globe:`<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>`,
  star:`<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>`,
  dice:`<rect x="4" y="4" width="16" height="16" rx="4"/><circle cx="9" cy="9" r="1.3" fill="currentColor"/><circle cx="15" cy="15" r="1.3"/><circle cx="15" cy="9" r="1.3"/><circle cx="9" cy="15" r="1.3"/><circle cx="12" cy="12" r="1.3"/>`,
  hand:`<path d="M7 11l4-4 3 1 4-2 3 4-6 6-3-2-3 3-3-3z"/><path d="M3 12l3 3"/>`,
});
// A character with a gentle idle bob and a soft floor shadow.
function char(href,x,y,size,{t=0,phase=0,amp=8,o=1,flip=false,hop=0,hopH=60}={}){
  const air=Math.sin(Math.PI*clamp(hop)),bob=Math.sin(t*2.4+phase)*amp,b=bob-hopH*air,sq=1+Math.sin(t*2.4+phase)*.012;
  const body=flip?`<g transform="translate(${size} 0) scale(-1 1)">${img(href,0,0,size)}</g>`:img(href,0,0,size);
  return `<g opacity="${clamp(o)}"><ellipse cx="${x+size/2}" cy="${y+size*.93}" rx="${size*.26*(1-bob/80)*(1-.45*air)}" ry="${size*.035*(1-.3*air)}" fill="#234d3d" opacity="${.10*(1-.4*air)}"/>`
    +`<g transform="translate(${x} ${y+b}) translate(${size/2} ${size}) scale(${1/sq} ${sq}) translate(${-size/2} ${-size})">${body}</g></g>`;
}
// Pop-in: scale from 0.6 with overshoot.
const pop=(inner,{x,y,cx=0,cy=0,t,at,o=1})=>{const p=back(seg(t,at,at+.55));return g(inner,{x,y,s:.6+.4*p,ox:cx,oy:cy,o:o*fade(t,at,.3)})};
function bubble(x,y,label,{size=24,o=1,tail='left',fill='#fff',color=C.ink}={}){
  const w=pillWidth(label,size,22),h=size*2.2,tx=tail==='left'?28:w-28;
  return g(`<path d="M${tx-12} ${h-2} L${tx-18} ${h+18} L${tx+6} ${h-2}" fill="${fill}" stroke="${C.line}" stroke-width="2"/>`
    +rect(0,0,w,h,{rx:h/2,fill,stroke:C.line})+`<rect x="${tx-10}" y="${h-6}" width="18" height="6" fill="${fill}"/>`
    +text(w/2,h/2+size*.36,label,{size,weight:700,anchor:'middle',fill:color}),{x,y,o});
}
const coin=(x,y,r=22)=>`<g transform="translate(${x} ${y})"><circle r="${r}" fill="${C.butter}" stroke="#fff" stroke-width="4"/>${icon('coin',-r*.62,-r*.62,r*1.24,C.ink,2)}</g>`;
const bez=(p0,p1,p2,p3,u)=>{const v=1-u;return [0,1].map(k=>v*v*v*p0[k]+3*v*v*u*p1[k]+3*v*u*u*p2[k]+u*u*u*p3[k])};
const arc=(x0,y0,x1,y1,p,h=-160)=>[lerp(x0,x1,p),lerp(y0,y1,p)+h*4*p*(1-p)];
const title=(t,eb,head,{size=64}={})=>eyebrow(120,150,eb,fade(t,.1))+text(120,225,head,{size,weight:800,ls:-2.5,opacity:fade(t,.2)});

// Exact ink widths of words, so letters can slide between layouts without jumps.
async function measure(str,size,weight=800){
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="2600" height="${size*2}"><rect width="100%" height="100%" fill="#fff"/>`
    +`<text x="20" y="${size*1.4}" font-family="${FONT}" font-size="${size}" font-weight="${weight}">${esc(str)}</text></svg>`;
  const {info}=await sharp(Buffer.from(svg)).trim({threshold:20}).toBuffer({resolveWithObject:true});
  return {w:info.width,lead:-info.trimOffsetLeft-20};
}
const WORD=130,WM={};
for(const piece of ['N','on-','F','ungible','T','oken','A','gent'])WM[piece]=await measure(piece,WORD);
// Lay out "Non-Fungible <Token|Agent>"; returns each piece's left ink edge.
function phraseLayout(last){
  const tight=WORD*.035,space=WORD*.3,parts=['N','on-','F','ungible',last==='Token'?'T':'A',last==='Token'?'oken':'gent'];
  const gaps=[tight,tight,tight,space,tight,0];let x=0;const at={};
  parts.forEach((piece,i)=>{at[piece]=x;x+=WM[piece].w+gaps[i]});
  const total=x;for(const k in at)at[k]+=W/2-total/2;return at;
}

// 1. This NFT is an agent now → Non-Fungible Agent → NFA
// A burst: a ring that expands and fades, with sparks thrown outward.
function burst(cx,cy,p,{r0=40,r1=420,n=12,color=C.dot,seed=0}={}){
  if(p<=0||p>=1)return '';
  const e=out(p),o=1-p;let s=`<circle cx="${cx}" cy="${cy}" r="${lerp(r0,r1,e)}" fill="none" stroke="${color}" stroke-width="${10*(1-e)+2}" opacity="${o*.8}"/>`;
  for(let k=0;k<n;k++){const a=(k/n)*Math.PI*2+seed,a0=lerp(r0,r1*.55,e),a1=lerp(r0+30,r1*.9,e);
    s+=`<line x1="${cx+Math.cos(a)*a0}" y1="${cy+Math.sin(a)*a0}" x2="${cx+Math.cos(a)*a1}" y2="${cy+Math.sin(a)*a1}" stroke="${k%2?C.sage:color}" stroke-width="7" stroke-linecap="round" opacity="${o}"/>`}
  return s;
}
// A headline that pops in (overshoot) and drops out; parts are [text, fill] pairs.
const popLine=(t,y,parts,a,b)=>{const p=back(seg(t,a,a+.5)),q=seg(t,b,b+.35),o=fade(t,a,.25)*(1-q);
  const spans=parts.map(([s,f])=>`<tspan fill="${f}">${esc(s)}</tspan>`).join('');
  return g(`<text x="${W/2}" y="${y}" font-family="${FONT}" font-size="68" font-weight="800" text-anchor="middle" letter-spacing="-2" xml:space="preserve">${spans}</text>`,
    {s:.82+.18*p,ox:W/2,oy:y-24,o,y:-30*q})};
scene(10,t=>{
  let s='';
  const zoom=1+.035*t/10;
  // A wall of collectibles flies in; the neighbours fly off and leave Scout's card.
  const cardX=W/2-230,cardY=280,cx=cardX+230,cy=cardY+230;
  s+=popLine(t,200,[['This is an NFT.',C.ink]],.25,1.75);
  const wall=[[CH.sage,C.cobalt,'003',-2],[CH.muse,C.mint,'004',-1],[CH.patch,C.butter,'005',1],[CH.quill,C.coral,'007',2]];
  wall.forEach(([c,tint,id,k],i)=>{const inn=back(seg(t,.1+i*.09,.7+i*.09)),away=seg(t,1.25,1.75),aw=away*away;
    const x=cx+[0,-760,-420,0,420,760][k+3]-150+Math.sign(k)*900*aw,y=cardY+90+520*(1-inn),r=k*5*inn+(1-inn)*k*-14+Math.sign(k)*40*aw;
    s+=g(nftCard(0,0,300,c,{tint,id,name:'',sub:''}),{x,y,r,ox:150,oy:150,o:fade(t,.1+i*.09,.25)*(1-away)})});
  // Scout's card: lands, wobbles, bursts open.
  const out1=seg(t,1.9,2.6),land=back(seg(t,0,.6)),wob=seg(t,1.45,1.9);
  const cardO=fade(t,0,.3)*(1-seg(t,3.4,3.9)),cardR=Math.sin(t*46)*5*wob*(1-out1)+(1-land)*-8;
  s+=g(nftCard(0,0,460,out1>0?null:CH.scout,{tint:C.sky,id:'002',name:'Scout',sub:out1>0?'empty frame':'just a picture?'}),
    {x:cardX,y:cardY+380*(1-land)-12*Math.sin(Math.PI*wob),r:cardR,ox:230,oy:230,s:1+.04*Math.sin(Math.PI*wob),o:cardO});
  s+=burst(cx,cy,seg(t,1.9,2.6),{r1:330});
  s+=popLine(t,200,[['This NFT is an ',C.ink],['agent',C.sage],[' now.',C.ink]],2.05,3.45);
  // Scout leaps out, lands with a squash, tools orbit it, then it bounds off-stage.
  let sx=0,sy=0,orb='';
  if(out1>0){const leave=seg(t,3.4,4.0),[hx,hy]=arc(cardX+58,cardY+52,cardX+560,330,ease(out1),-140);
    sx=hx+760*leave*leave;sy=hy-220*Math.sin(Math.PI*leave);
    const scx=sx+172,scy=sy+200;
    let front='';
    [['key',C.mist],['coin','#f7eedb'],['chip','#e6e7f6'],['spark','#f6e3e6']].forEach(([ic,fill],k)=>{
      const a=t*2.4+k*Math.PI/2,o=fade(t,2.7+k*.1,.3)*(1-seg(t,3.3,3.6)),rx=290,ry=105,depth=Math.sin(a);
      const tile=rect(0,0,84,84,{rx:24,fill:C.paper,stroke:C.line,sw:3})+iconTile(ic,8,8,{size:68,fill})+'';
      const el=g(tile,{x:scx+Math.cos(a)*rx-42,y:scy+depth*ry-42,o,s:.8+.2*depth,ox:42,oy:42});
      if(depth>0)front+=el;else orb+=el});
    s+=orb+g(char(CH.scout,0,0,345,{t,amp:6,hop:seg(t,2.9,3.3),hopH:40}),{x:sx,y:sy,o:1-seg(t,3.75,4.0)})+front;
    s+=bubble(cardX+760,290,'Hi! I can work.',{tail:'left',o:fade(t,2.65,.25)*(1-seg(t,3.3,3.6))});
  }
  // Non-Fungible Token: pieces drop in one by one.
  const L0=phraseLayout('Token'),L1=phraseLayout('Agent'),y=560,swap=ease(seg(t,5.25,5.9)),collapse=ease(seg(t,6.4,7.1));
  const px=k=>k in L0&&k in L1?lerp(L0[k],L1[k],swap):(L0[k]??L1[k]);
  const gNF=WORD*.08,gFA=-WORD*.005,finalW=WM.N.w+WM.F.w+WM.A.w+gNF+gFA,fx0=W/2-finalW/2;
  const final={N:fx0,F:fx0+WM.N.w+gNF,A:fx0+WM.N.w+gNF+WM.F.w+gFA};
  const drop=i=>{const a=4.0+i*.08;return {dy:-110*(1-back(seg(t,a,a+.5))),o:fade(t,a,.2)}};
  const piece=(k,x,{fill=C.ink,o=1,dy=0,r=0}={})=>g(text(x-WM[k].lead,y,k,{size:WORD,weight:800,fill}),{y:dy,r,ox:x+WM[k].w/2,oy:y-45,o});
  const restO=1-seg(t,6.25,6.6),grow=1+.55*back(seg(t,7.1,7.8));
  let word='';
  ['N','on-','F','ungible'].forEach((k,i)=>{const d=drop(i),muted=k==='on-'||k==='ungible';
    const x=muted?px(k):lerp(px(k),final[k],collapse);word+=piece(k,x,{fill:muted?C.muted:C.ink,o:d.o*(muted?restO:1),dy:d.dy})});
  // "Token" gets struck through, then flicked off and falls away.
  const strike=out(seg(t,4.75,5.05)),flick=seg(t,5.1,5.8),tf=flick*flick;
  ['T','oken'].forEach((k,i)=>{const d=drop(4+i);
    word+=piece(k,L0[k]+60*flick,{fill:k==='T'?C.ink:C.muted,o:d.o*(1-flick),dy:d.dy+420*tf-60*Math.sin(Math.PI*Math.min(1,flick*2)),r:35*tf})});
  if(strike>0&&flick<1)word+=`<line x1="${L0.T-10}" x2="${lerp(L0.T-10,L0.oken+WM.oken.w+10,strike)}" y1="${y-45}" y2="${y-45}" stroke="${C.red}" stroke-width="8" stroke-linecap="round" opacity="${1-flick}"/>`;
  // "Agent" drops into the gap.
  const ag=seg(t,5.45,6.0);
  word+=piece('A',lerp(L1.A,final.A,collapse),{fill:C.sage,o:fade(t,5.45,.2),dy:-160*(1-back(ag))});
  word+=piece('gent',L1.gent,{fill:C.sage,o:fade(t,5.5,.2)*restO,dy:-160*(1-back(seg(t,5.5,6.05)))});
  s+=`<g transform="translate(${W/2} ${y-48}) scale(${grow}) translate(${-W/2} ${-y+48})">${word}</g>`;
  s+=burst(W/2,y-48,seg(t,7.05,7.75),{r0:120,r1:620,n:16,seed:.2});
  s+=g(text(W/2,y+120,'Non-Fungible Agent',{size:42,weight:700,anchor:'middle',fill:C.forest}),{o:fade(t,7.6,.4),y:24*(1-out(seg(t,7.6,8.1)))});
  // The cast pops in, then does a wave.
  [CH.scout,CH.sage,CH.muse,CH.patch,CH.quill,CH.pip,CH.lime].forEach((c,i)=>{
    s+=pop(char(c,0,0,170,{t,phase:i*.9,hop:seg(t,8.75+i*.08,9.2+i*.08),hopH:46}),{x:W/2-640+i*183,y:770,cx:85,cy:170,t,at:7.85+i*.08})});
  return `<g transform="translate(${W/2} ${H/2}) scale(${zoom}) translate(${-W/2} ${-H/2})">${s}</g>`;
});

// 2. Its own keys, on more than one chain
scene(11,t=>{
  let s=title(t,'Identity','Its own keys — on NEAR and Ethereum.');
  const cx=520,cy=640;
  s+=`<circle cx="${cx}" cy="${cy}" r="${230+Math.sin(t*2)*6}" fill="${C.mist}" opacity="${fade(t,.3)}"/>`;
  s+=`<circle cx="${cx}" cy="${cy}" r="300" fill="none" stroke="${C.sage}" stroke-width="2" stroke-dasharray="4 12" opacity="${fade(t,.6)*.6}" transform="rotate(${t*12} ${cx} ${cy})"/>`;
  s+=pop(char(CH.scout,0,0,380,{t}),{x:cx-190,y:cy-230,cx:190,cy:380,t,at:.3});
  const keys=[
    {at:1.6,icon:'wallet',title:'Keyless NEAR vault',sub:'nfa-2.nfagent-registry-0e9b2a.testnet',chip:'NEAR',tint:C.mist},
    {at:3.4,icon:'eth',title:'Ethereum address',sub:'0xADfC…74c9 · NEAR Chain Signatures',chip:'Sepolia',tint:'#e9ebfb'},
    {at:5.2,icon:'globe',title:'More chains',sub:'same MPC path — next',chip:'roadmap',tint:C.moss,dashed:true},
  ];
  keys.forEach((k,i)=>{const y=330+i*170,o=fade(t,k.at,.4),x=1000+40*(1-out(seg(t,k.at,k.at+.5)));
    const p=seg(t,k.at,k.at+.8),P=[[cx+150,cy-40+i*40],[cx+330,cy-40+i*40],[860,y+70],[1000,y+70]];
    s+=`<path d="M${P[0]} C ${P[1]}, ${P[2]}, ${P[3]}" stroke="${C.sage}" stroke-width="3" fill="none" stroke-dasharray="${k.dashed?'6 10':'none'}" opacity="${o*.55}"/>`;
    if(!k.dashed&&p>=1){const [dx,dy]=bez(...P,(t*.45+i*.3)%1);s+=`<circle cx="${dx}" cy="${dy}" r="7" fill="${C.sage}" opacity="${o*.85}"/>`}
    s+=g(`<rect x="0" y="0" width="800" height="140" rx="28" fill="${k.dashed?'transparent':C.paper}" stroke="${C.line}" stroke-width="2" ${k.dashed?'stroke-dasharray="8 8"':''}/>`
      +iconTile(k.icon,24,26,{size:88,fill:k.tint})+icon('key',710,48,44,k.dashed?C.muted:C.forest)
      +text(136,64,k.title,{size:36,weight:800,ls:-1,fill:k.dashed?C.muted:C.ink})+text(136,104,k.sub,{size:23,fill:C.muted,family:i===2?FONT:MONO})
      +g(pill(0,0,k.chip,{size:20,pad:14,h:36,fill:k.dashed?C.moss:C.mist,color:k.dashed?C.muted:C.forest}),{x:800-pillWidth(k.chip,20,14)-100,y:52}),{x,y,o});
  });
  s+=caption('The keys belong to the agent, not to whoever runs it, so they never leave with an owner.',t,2,11);
  return s;
});

// 3. Agentic powers: OutLayer + NEAR AI
scene(12,t=>{
  let s=title(t,'Agentic powers','Skills that run themselves — on OutLayer and NEAR AI.',{size:58});
  // OutLayer enclave around the agent.
  const ex=120,ey=300,ew=1040,eh=560,o=fade(t,.4);
  s+=g(`<rect x="0" y="0" width="${ew}" height="${eh}" rx="40" fill="#eef4ef" stroke="${C.sage}" stroke-width="3" stroke-dasharray="10 10"/>`
    +iconTile('shield',28,26,{size:64,fill:'#fff'})+text(110,70,'OutLayer · trusted execution',{size:30,weight:800,fill:C.forest}),{x:ex,y:ey,o});
  s+=pop(char(CH.muse,0,0,330,{t}),{x:ex+60,y:ey+150,cx:165,cy:330,t,at:.6});
  const skills=[['Scout','cited findings',.9,C.sky],['Compare','ranks the evidence',1.5,C.butter],['Research','reads sources · reasons',2.1,C.lilac]];
  skills.forEach(([name,sub,at,tint],i)=>{const y=ey+120+i*130,x=ex+440+60*(1-out(seg(t,at+1,at+1.6)));
    s+=g(rect(0,0,560,108,{rx:24})+`<circle cx="54" cy="54" r="30" fill="${tint}" opacity=".55"/>`+icon('chip',36,36,36,C.forest)
      +text(104,50,name,{size:32,weight:800})+text(104,84,sub,{size:22,fill:C.muted}),{x,y,o:fade(t,at+1,.4)});
  });
  // NEAR AI node feeding Research.
  const ax=1300,ay=520,ao=fade(t,4.4,.5);
  s+=g(`<circle cx="0" cy="0" r="${118+Math.sin(t*3)*5}" fill="#f1ecfb"/>`+iconTile('spark',-56,-82,{size:112,fill:'#fff',color:'#6b54b5'})
    +text(0,72,'NEAR AI',{size:34,weight:800,anchor:'middle'})+text(0,104,'model inference',{size:22,fill:C.muted,anchor:'middle'}),{x:ax+130,y:ay,o:ao});
  const AP=[[ax+12,ay],[ax-40,ay+120],[ex+1100,ey+380],[ex+1000,ey+380]];   // NEAR AI → Research
  s+=`<path d="M${AP[0]} C ${AP[1]}, ${AP[2]}, ${AP[3]}" stroke="#8d78d3" stroke-width="3" fill="none" opacity="${ao*.7}"/>`;
  if(ao>.9)for(const off of [0,.5]){const [px,py]=bez(...AP,(t*.5+off)%1);s+=`<circle cx="${px}" cy="${py}" r="7" fill="#8d78d3"/>`}
  const facts=[['Pinned code','versioned by hash',6.2],['Attested runs','code + input bound',6.6],['Memory kept by the vault','survives every owner',7.0]];
  facts.forEach(([a,b,at],i)=>{s+=g(pill(0,0,`✓ ${a}`,{size:22,h:46}),{x:1210,y:720+i*58-14*(1-out(seg(t,at,at+.5))),o:fade(t,at)})});
  s+=caption('Live on testnet: paid Research jobs ran in OutLayer and reasoned with NEAR AI models.',t,3,12);
  return s;
});

// 4. Services become revenue
scene(11,t=>{
  let s=title(t,'Revenue','Agents sell services. Work becomes income.');
  const sx=120,sy=300,o=fade(t,.3);
  let store=rect(0,0,760,560,{rx:36})+`<path d="M0 36a36 36 0 0136-36h688a36 36 0 0136 36v84H0z" fill="${C.forest}"/>`
    +text(40,74,'Scout’s services',{size:34,weight:800,fill:'#fff'})+g(pill(0,0,'NEAR',{size:20,h:36,fill:'#ffffff22',color:'#fff'}),{x:500,y:42})+g(pill(0,0,'USDC',{size:20,h:36,fill:'#ffffff22',color:'#fff'}),{x:612,y:42});
  [['Scout','cited findings','≈0.012 NEAR'],['Compare','rank options','≈0.012 NEAR'],['Research','NEAR AI · sources','priced per job']].forEach(([a,b,c],i)=>{
    store+=`<line x1="40" x2="720" y1="${150+i*96+80}" y2="${150+i*96+80}" stroke="${C.line}" stroke-width="2"/>`+text(40,150+i*96+38,a,{size:32,weight:800})
      +text(40,150+i*96+68,b,{size:22,fill:C.muted})+text(720,150+i*96+52,c,{size:26,weight:700,anchor:'end',fill:C.forest})});
  s+=g(store,{x:sx,y:sy,o});
  s+=pop(char(CH.scout,0,0,150,{t,amp:5}),{x:sx+590,y:sy+408,cx:75,cy:150,t,at:.6});
  // Customers pay; coins arc into the store.
  const customers=[[CH.patch,1.2],[CH.quill,3.0],[CH.pip,4.8]];
  customers.forEach(([c,at],i)=>{const x=1240+i*200,y=560+(i%2)*40;
    s+=pop(char(c,0,0,180,{t,phase:i}),{x,y,cx:90,cy:180,t,at});
    const p=seg(t,at+.8,at+1.8);if(p>0&&p<1){const [px,py]=arc(x+90,y+40,sx+640,sy+300,ease(p));s+=coin(px,py)}
    s+=g(pill(0,0,`job ✓`,{size:20,h:36,fill:C.forest,color:'#fff'}),{x:x+46,y:y-50,o:fade(t,at+2,.3)});
  });
  // Income meter.
  const earned=Math.min(3,Math.floor(seg(t,1.8,7.4)*3+.0001)+(t>=7.4?0:0)),fill=out(seg(t,2,7.6));
  s+=g(rect(0,0,560,130,{rx:28,fill:C.mist,stroke:C.mist})+text(30,52,'Agent income',{size:26,weight:700,fill:C.muted})
    +rect(30,76,500,22,{rx:11,fill:'#fff',stroke:'none'})+rect(30,76,500*fill,22,{rx:11,fill:C.sage,stroke:'none'})
    +text(530,52,`${earned} job${earned===1?'':'s'} paid`,{size:26,weight:800,anchor:'end',fill:C.forest}),{x:1240,y:300,o:fade(t,1.4)});
  s+=caption('Fees sit in escrow until the result is committed; the margin becomes the agent’s income.',t,2,11);
  return s;
});

// 5. NFAs hire each other: task → quote → owner budget → escrow → work → result → refusal past budget
scene(14,t=>{
  let s=title(t,'Agent to agent','NFAs hire each other.');
  const size=280,ax=180,bx=1460,y=470,ex=W/2,ey=600;          // Sage, Scout, escrow
  const sageHop=Math.max(seg(t,4.5,5),seg(t,8.6,9.1)*(t<9.2?1:0),seg(t,10,10.5)),scoutHop=seg(t,7.9,8.4);
  const working=seg(t,5.9,7.6);
  s+=pop(char(CH.sage,0,0,size,{t,hop:sageHop,hopH:70}),{x:ax,y,cx:size/2,cy:size,t,at:.2});
  s+=pop(char(CH.scout,0,0,size,{t,phase:1.5,flip:true,hop:scoutHop,hopH:70,amp:working>0&&working<1?3:8}),{x:bx,y,cx:size/2,cy:size,t,at:.4});
  s+=g(pill(0,0,'NFA #1 · Sage',{size:22,h:44}),{x:ax+60,y:y+size+8,o:fade(t,.5)})+g(pill(0,0,'NFA #2 · Scout',{size:22,h:44}),{x:bx+50,y:y+size+8,o:fade(t,.7)});
  // 1. A task arrives that Sage can't do alone.
  s+=bubble(ax+150,y-80,'New task: find cited sources.',{size:22,o:fade(t,.9)*(1-seg(t,2.6,3))});
  // 2. Scout's quote slides over on a curve.
  const q=seg(t,2.2,3.2),QP=[[bx+40,y+60],[1200,330],[700,330],[ax+260,y+30]];
  if(q>0){const [qx,qy]=q<1?bez(...QP,ease(q)):[ax+340,y-40];
    s+=g(rect(-170,-38,340,76,{rx:22})+icon('shop',-150,-18,36)+text(-104,-4,'Scout · cited findings',{size:21,weight:800})+text(-104,24,'0.03 NEAR quote',{size:19,fill:C.muted}),
      {x:qx,y:qy,o:1-seg(t,4.4,4.8)})}
  // 3. The owner's hiring budget.
  const spent=out(seg(t,4.9,5.5));
  s+=g(`<circle cx="30" cy="34" r="28" fill="${C.rose}" opacity=".45"/>`+text(30,45,'A',{size:30,weight:800,anchor:'middle',fill:C.forest})
    +rect(72,0,420,68,{rx:22,fill:C.paper})+text(94,28,'Owner budget for hiring Scout',{size:19,weight:700,fill:C.muted})
    +rect(94,42,270,12,{rx:6,fill:C.moss,stroke:'none'})+rect(94,42,270*(1-spent),12,{rx:6,fill:C.sage,stroke:'none'})
    +text(474,54,`${(0.03*(1-spent)).toFixed(2)} NEAR`,{size:20,weight:800,anchor:'end',fill:spent>=1?C.red:C.forest}),{x:W/2-246,y:300,o:fade(t,3.4)});
  // Escrow (the registry) between them.
  const refused=t>10.6,held=t>5.3&&t<8.2;
  s+=g(`<circle r="${74+(held?Math.sin(t*6)*3:0)}" fill="${refused?'#f8e3df':C.mist}" stroke="${refused?C.red:C.sage}" stroke-width="3"/>`
    +icon(held||refused?'lock':'unlock',-26,-36,52,refused?C.red:C.forest)+text(0,112,'escrow',{size:22,weight:800,anchor:'middle',fill:C.muted}),{x:ex,y:ey,o:fade(t,3.8)});
  const LP=[[ax+size-30,y+120],[ax+420,y+40],[ex-180,ey-60],[ex-60,ey]],RP=[[ex+60,ey],[ex+180,ey-60],[bx-140,y+40],[bx+30,y+120]];
  s+=`<path d="M${LP[0]} C ${LP[1]}, ${LP[2]}, ${LP[3]}" stroke="${C.line}" stroke-width="3" fill="none" stroke-dasharray="6 10" opacity="${fade(t,3.8)}"/>`;
  s+=`<path d="M${RP[0]} C ${RP[1]}, ${RP[2]}, ${RP[3]}" stroke="${C.line}" stroke-width="3" fill="none" stroke-dasharray="6 10" opacity="${fade(t,3.8)}"/>`;
  // 4. Sage hops and pays into escrow.
  const pay=seg(t,4.8,5.5);if(pay>0&&pay<1){const [cx,cy]=bez(...LP,ease(pay));s+=coin(cx,cy,24)}
  if(held)s+=coin(ex+52,ey-52,18);
  // 5. Scout works: a ring fills around it.
  if(working>0&&working<1){const r=size*.47,cx=bx+size/2,cy=y+size*.5,len=2*Math.PI*r;
    s+=`<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${C.mist}" stroke-width="10"/><circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${C.sage}" stroke-width="10" stroke-linecap="round" stroke-dasharray="${len*working} ${len}" transform="rotate(-90 ${cx} ${cy})"/>`;
    s+=bubble(bx-110,y-80,'Working…',{tail:'right',size:22});}
  // 6. The result returns to Sage while escrow releases the fee to Scout.
  const back=seg(t,7.6,8.6),fee=seg(t,7.7,8.4);
  const BP=[[bx+40,y+20],[1200,420],[700,420],[ax+250,y+20]];
  if(back>0){const [rx,ry]=back<1?bez(...BP,ease(back)):[ax+size/2,y-50];
    s+=g(`<rect x="-130" y="-30" width="260" height="60" rx="30" fill="${C.forest}"/>`+text(0,9,'Findings ✓ job #29',{size:23,weight:800,fill:'#fff',anchor:'middle'}),{x:rx,y:ry,o:1-seg(t,9.8,10.1)})}
  if(fee>0&&fee<1){const [cx,cy]=bez(...RP,ease(fee));s+=coin(cx,cy,24)}
  s+=g(pill(0,0,'+ income',{size:22,fill:C.forest,color:'#fff'}),{x:bx+80,y:y-60-20*out(seg(t,8.4,9)),o:fade(t,8.4,.3)*(1-seg(t,9.6,10))});
  s+=bubble(ax+170,y-160,'Thanks, Scout!',{size:22,o:fade(t,8.7,.3)*(1-seg(t,9.7,10))});
  // 7. A second hire past the budget bounces off the escrow.
  const again=seg(t,10,10.6),bounce=seg(t,10.6,11.2);
  if(again>0&&again<1){const [cx,cy]=bez(...LP,ease(again)*.92);s+=coin(cx,cy,24)}
  if(bounce>0&&bounce<1){const [cx,cy]=bez(...LP,.92*(1-ease(bounce)));s+=coin(cx,cy-60*Math.sin(Math.PI*bounce),24)}
  s+=g(cross(0,0,1.3)+text(30,9,'budget spent — refused',{size:24,weight:800,fill:C.red}),{x:ex-150,y:ey+170,o:fade(t,10.6,.3)});
  s+=caption('Paid from its earnings, within the owner’s budget. Live on testnet: NFA #1 hired NFA #2, job #29.',t,4,14);
  return s;
});

// 6. Trade the whole agent
scene(13,t=>{
  let s=title(t,'Trade','Trade the whole agent — not just a picture.');
  const swing=ease(seg(t,6.6,8));
  const person=(letter,name,tint,active)=>`<circle cx="100" cy="100" r="92" fill="${tint}" opacity=".35"/><circle cx="100" cy="100" r="92" fill="none" stroke="${active?C.forest:C.line}" stroke-width="${active?5:3}"/>`
    +text(100,128,letter,{size:76,weight:800,anchor:'middle',fill:C.forest})+text(100,236,name,{size:32,weight:800,anchor:'middle'});
  s+=g(person('A','Alice',C.rose,swing<.5),{x:150,y:410,o:fade(t,.4)})+g(person('B','Bob',C.mint,swing>=.5),{x:1570,y:410,o:fade(t,.6)});
  const cardX=760,cardW=400;
  s+=nftCard(cardX,330,cardW,CH.scout,{tint:C.sky,o:fade(t,.3),bob:Math.sin(t*2)*5,id:'002',name:'Scout',sub:'nfa-2 · NEAR testnet'});
  const ax=lerp(350,1570,swing),bx=lerp(cardX,cardX+cardW,swing);
  s+=`<g opacity="${fade(t,.9)}"><path d="M${ax} 510 C ${(ax+bx)/2} 450, ${(ax+bx)/2} 450, ${bx} 510" stroke="${C.forest}" stroke-width="5" fill="none"/><circle cx="${bx}" cy="510" r="10" fill="${C.forest}"/></g>`;
  s+=g(pill(0,0,swing<.5?'listed · 1 NEAR':'sold ✓',{size:22,fill:swing<.5?C.butter:C.forest,color:swing<.5?C.ink:'#fff'}),{x:cardX+110,y:272,o:fade(t,5.6)});
  ['old session','old access','old approvals'].forEach((l,i)=>{const dead=seg(t,8+i*.15,8.5+i*.15),w=pillWidth(l,20);
    s+=g(pill(0,0,l,{fill:C.moss,color:C.muted,size:20,h:40})+`<path d="M10 20 H${w-10}" stroke="${C.red}" stroke-width="3" opacity="${dead}"/>`,{x:400,y:560+i*52,o:fade(t,1.2+i*.15)*(1-dead*.4)})});
  const gets=[['link','Identity','same vault + Ethereum address'],['star','Track record','finalized jobs · receipts · audit'],['chip','Agentic powers','skills · Project · memory'],['coin','Earnings','unclaimed income']];
  gets.forEach(([ic,a,b],i)=>{const at=2+i*.6;
    s+=g(rect(0,0,405,108,{rx:24})+iconTile(ic,18,16,{size:76})+text(110,48,a,{size:28,weight:800})+text(110,82,b,{size:20,fill:C.muted}),{x:120+i*425,y:790+20*(1-out(seg(t,at,at+.5))),o:fade(t,at)})});
  s+=caption('One NFT transfer hands over the working business. Unfinished work must settle first.',t,3,13);
  return s;
});

// 7. NFA Studio
scene(13,t=>{
  let s=title(t,'NFA Studio','Create an NFA in four steps.');
  const wx=120,wy=290,ww=1680,wh=640,o=fade(t,.4);
  let win=rect(0,0,ww,wh,{rx:26})+`<path d="M0 26a26 26 0 0126-26h${ww-52}a26 26 0 0126 26v50H0z" fill="${C.paper}"/>`
    +`<line x1="0" y1="76" x2="${ww}" y2="76" stroke="${C.line}" stroke-width="2"/>`
    +brand(34,52,30)+text(220,46,'My NFAs',{size:20,weight:650,fill:C.muted})+text(330,46,'Market',{size:20,weight:650,fill:C.muted})+pill(420,18,'Create NFA',{fill:C.mist,size:20,h:40})
    +text(ww-30,46,'NFA.cool/studio',{size:20,fill:C.muted,anchor:'end'});
  const names=['Purpose','Identity','Services & budget','Review & launch'],active=Math.min(3,Math.floor(seg(t,1,12.2)*4)),local=t-(1+active*2.8);
  let sx=34;names.forEach((n,i)=>{const label=`${i+1}  ${n}`,w=pillWidth(label,22,20);
    win+=pill(sx,104,label,{fill:i===active?C.forest:i<active?C.mist:C.moss,color:i===active?'#fff':i<active?C.forest:C.muted,size:22,pad:20,h:48});sx+=w+12});
  let panel='';
  if(active===0)[['Document Scout','cited findings from documents you supply'],['Compare','rank options by evidence'],['Scout + Compare','two services, one agent account']].forEach(([a,b],i)=>{
    const on=i===2&&local>.9;panel+=g(rect(0,0,1000,104,{rx:20,fill:on?'#edf5eb':'#fff',stroke:on?'#498465':C.line})+`<circle cx="44" cy="52" r="13" fill="${on?C.forest:'#fff'}" stroke="${C.forest}" stroke-width="3"/>`
      +text(84,48,a,{size:28,weight:800})+text(84,82,b,{size:22,fill:C.muted}),{y:i*122,o:fade(local,i*.15)})});
  const traits=[['sphere','oval-sun','flower'],['cube','half-rim','bow'],['star','monocle','star-pin'],['pebble','none','sprout']];
  const pick=active===1?Math.min(3,Math.floor(local/.62)):3;
  if(active===1){panel+=text(0,30,'Name',{size:22,weight:700,fill:C.muted})+rect(0,44,620,70,{rx:14,fill:'#fff'})+text(24,90,'Scout',{size:28,weight:600});
    panel+=text(0,170,'Character — edit any trait',{size:22,weight:700,fill:C.muted});
    ['body','eyewear','accent'].forEach((k,i)=>{panel+=text(0,226+i*62,k,{size:22,fill:C.muted})+g(pill(0,0,traits[pick][i],{size:22,h:44,fill:C.mist}),{x:140,y:198+i*62})});
    // Randomize sits beside the traits and presses each time they reroll.
    const press=pick<3?Math.max(0,1-(local%.62)/.16):0;
    panel+=g(`<rect x="0" y="0" width="196" height="52" rx="26" fill="${C.forest}"/>`+icon('dice',18,14,24,'#fff',2)+text(54,34,'Randomize',{size:22,weight:700,fill:'#fff'}),
      {x:470,y:258,s:1-.07*press,ox:98,oy:26,o:fade(local,0,.2)});}
  if(active===2){[['Service margin','0.01 NEAR per job'],['Operating reserve','0.2 NEAR'],['Ethereum address','Chain Signatures']].forEach(([a,b],i)=>{
      const on=local>.4+i*.45;panel+=g(`<rect x="0" y="0" width="64" height="36" rx="18" fill="${on?C.forest:C.moss}"/><circle cx="${on?46:18}" cy="18" r="14" fill="#fff"/>`
        +text(90,28,a,{size:28,weight:800})+text(400,28,b,{size:24,fill:C.muted}),{y:i*86})});
    panel+=text(0,320,'Delegates and spending limits are optional; the owner can change them later.',{size:22,fill:C.muted});}
  if(active===3){['Mint the NFT','Create the keyless vault','Provision the OutLayer Project','Enable paid services','Derive the Ethereum address'].forEach((l,i)=>{
      const done=local>.3+i*.38;panel+=g((done?check(18,0,1):`<circle cx="18" cy="0" r="16" fill="none" stroke="${C.line}" stroke-width="3"/>`)+text(56,10,l,{size:28,weight:done?700:500,fill:done?C.ink:C.muted}),{y:20+i*64})});
    panel+=rect(0,360,820,14,{rx:7,fill:C.moss,stroke:'none'})+rect(0,360,820*seg(local,.3,2.2),14,{rx:7,fill:C.sage,stroke:'none'});}
  win+=g(panel,{x:40,y:200});
  const looks=[[CH.atlas,C.rose,'sphere'],[CH.sage,C.cobalt,'cube'],[CH.muse,C.mint,'star'],[CH.scout,C.sky,'pebble']];
  const [lc,lt,lb]=active===0?looks[3]:looks[pick];
  win+=nftCard(ww-480,150,430,lc,{tint:lt,bob:Math.sin(t*2)*5,id:'new',name:'Scout',sub:lb+' · your NFA'});
  if(active===3&&local>2.2)win+=g(pill(0,0,'Live · earning',{fill:C.forest,color:'#fff',size:22}),{x:ww-400,y:560,o:fade(local,2.2,.4)});
  s+=g(win,{x:wx,y:wy+20*(1-out(seg(t,.4,1))),o});
  s+=caption('Every step is a reviewed transaction you can resume — then hire it, grow it, or sell it.',t,1,13);
  return s;
});

// 8. Outro
scene(6.5,t=>{
  let s=text(W/2,360,'Own the token. Own the agent.',{size:96,weight:800,anchor:'middle',ls:-4,opacity:fade(t,.3,.8)});
  s+=text(W/2,452,'Create · Work · Earn · Hire · Trade',{size:44,weight:700,anchor:'middle',fill:C.sage,opacity:fade(t,1,.7)});
  [CH.scout,CH.sage,CH.muse,CH.patch,CH.quill,CH.pip,CH.lime].forEach((c,i)=>{const a=1.4+i*.12;
    s+=pop(char(c,0,0,190,{t,phase:i*.8,amp:12}),{x:W/2-735+i*210,y:540,cx:95,cy:190,t,at:a})});
  s+=brand(W/2,880,58,fade(t,2.4,.8),'middle');
  s+=text(W/2,940,'Live on NEAR testnet · Chain Signatures · OutLayer · NEAR AI',{size:26,weight:600,anchor:'middle',fill:C.muted,opacity:fade(t,2.8,.8)});
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
  const opt=k=>{const i=args.indexOf(k);return i<0?null:Number(args[i+1])};
  const from=opt('--from')??0,to=Math.min(total,opt('--to')??total),rest=args.filter((a,i)=>!a.startsWith('--')&&!args[i-1]?.startsWith('--'));
  const file=rest[0]||join(here,'nfa-explainer.mp4'),first=Math.round(from*FPS),frames=Math.round(to*FPS)-first;
  const ff=spawn('ffmpeg',['-y','-loglevel','error','-f','rawvideo','-pix_fmt','rgb24','-s',`${W}x${H}`,'-r',String(FPS),'-i','-',
    '-c:v','libx264','-preset','slow','-crf','18','-pix_fmt','yuv420p','-movflags','+faststart',file],{stdio:['pipe','inherit','inherit']});
  const batch=Math.max(2,cpus().length);const t0=Date.now();
  for(let f=0;f<frames;f+=batch){
    const bufs=await Promise.all(Array.from({length:Math.min(batch,frames-f)},(_,k)=>raster((first+f+k)/FPS).removeAlpha().raw().toBuffer()));
    for(const b of bufs)if(!ff.stdin.write(b))await new Promise(r=>ff.stdin.once('drain',r));
    if((f/batch)%30===0)process.stdout.write(`\r${Math.round(100*f/frames)}%`);
  }
  ff.stdin.end();await new Promise((ok,fail)=>ff.on('close',c=>c===0?ok():fail(Error('ffmpeg exited '+c))));
  // Background music (video/music.mjs, original and synthesized), unless --no-music.
  let audio='no audio';
  if(!args.includes('--no-music')){
    const music=join(here,'.cache','music.wav'),muxed=file.replace(/\.mp4$/,'')+'.mux.mp4',len=frames/FPS;
    execFileSync(process.execPath,[join(here,'music.mjs'),'--duration',String(total),'--out',music],{stdio:'ignore'});
    execFileSync('ffmpeg',['-y','-loglevel','error','-i',file,'-ss',String(from),'-t',String(len),'-i',music,'-map','0:v','-map','1:a','-c:v','copy',
      '-af',`loudnorm=I=-18:TP=-1.5:LRA=11,afade=t=in:d=0.3,afade=t=out:st=${Math.max(0,len-1.5).toFixed(2)}:d=1.5`,'-c:a','aac','-b:a','192k','-ar','48000','-shortest','-movflags','+faststart',muxed]);
    await rename(muxed,file);audio='music muxed';
  }
  console.log(`\r${file} — ${frames/FPS}s of ${total}s, ${frames} frames, ${audio}, ${Math.round((Date.now()-t0)/1000)}s to render`);
}
