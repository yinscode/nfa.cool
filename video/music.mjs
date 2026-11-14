#!/usr/bin/env node
// Original background music for the NFA explainer, synthesized from code: no samples, no
// downloads, so it carries no third-party licence. Deterministic: the same arguments always
// produce the same WAV.
//   node video/music.mjs [--duration 90.5] [--out video/.cache/music.wav]
// Feel: warm, playful lo-fi pop at 100 BPM in C major (Cmaj7 · G6 · Am7 · Fmaj7), with marimba
// arpeggios, a soft pad, round bass, light drums, a bell motif, and swells into each scene.
import {writeFile,mkdir} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';

const here=dirname(fileURLToPath(import.meta.url));
const arg=(k,d)=>{const i=process.argv.indexOf(k);return i<0?d:process.argv[i+1]};
const DUR=Number(arg('--duration',90.5)),OUT=arg('--out',join(here,'.cache','music.wav'));
// Scene starts in video/render.mjs (durations 10, 11, 12, 11, 14, 13, 13, 6.5).
const SCENES=[10,21,33,44,58,71,84],REVEAL=7.1,OUTRO=84;

const SR=44100,N=Math.ceil(DUR*SR),L=new Float32Array(N),R=new Float32Array(N),VL=new Float32Array(N),VR=new Float32Array(N);
const BPM=100,BEAT=60/BPM,BAR=BEAT*4;
const hz=m=>440*Math.pow(2,(m-69)/12);
let seed=0x6e6661;const rnd=()=>{seed|=0;seed=seed+0x6D2B79F5|0;let t=Math.imul(seed^seed>>>15,1|seed);t=t+Math.imul(t^t>>>7,61|t)^t;return ((t^t>>>14)>>>0)/4294967296};
const TAU=Math.PI*2;
// Add a mono voice into the mix with pan (-1..1) and a reverb send.
function add(start,len,fn,{gain=1,pan=0,send=0}={}){
  const a=Math.max(0,Math.floor(start*SR)),b=Math.min(N,Math.floor((start+len)*SR));
  const gl=gain*Math.cos((pan+1)*Math.PI/4),gr=gain*Math.sin((pan+1)*Math.PI/4);
  for(let i=a;i<b;i++){const v=fn((i-a)/SR);L[i]+=v*gl;R[i]+=v*gr;if(send){VL[i]+=v*gl*send;VR[i]+=v*gr*send}}
}
const env=(t,len,att,rel)=>Math.min(1,t/att)*Math.min(1,Math.max(0,(len-t)/rel));

// Harmony: one chord per bar.
const CHORDS=[
  {root:36,pad:[60,64,67,71]},   // Cmaj7
  {root:43,pad:[59,62,64,67]},   // G6 (B D E G)
  {root:45,pad:[57,60,64,67]},   // Am7
  {root:41,pad:[57,60,64,65]},   // Fmaj7 (A C E F)
];
const bars=Math.ceil(DUR/BAR);
const chordAt=bar=>CHORDS[bar%4];
// Energy by time: intro is sparse, the outro thins out.
const drumsOn=t=>t>=4.8&&t<OUTRO+2.4;
const fullOn=t=>t>=10&&t<OUTRO;

for(let bar=0;bar<bars;bar++){
  const t0=bar*BAR,c=chordAt(bar);if(t0>=DUR)break;
  const last=t0+BAR>=DUR-BAR;
  // Pad: three slightly detuned partials per note, slow swell.
  const padLen=last?DUR-t0:BAR+.35;
  for(const m of c.pad){const f=hz(m);
    add(t0,padLen,t=>{const e=env(t,padLen,.5,.6);return e*(Math.sin(TAU*f*t)+.45*Math.sin(TAU*f*1.003*2*t)+.18*Math.sin(TAU*f*.997*3*t))*.5},{gain:.055,pan:(m%7-3)/8,send:.5})}
  // Marimba arpeggio in eighths.
  const pattern=[0,1,2,3,2,1,2,3];
  pattern.forEach((k,j)=>{const t=t0+j*BEAT/2;if(t>=DUR-1.2)return;
    const thin=t<2.4?j%2===0:true;if(!thin)return;
    const f=hz(c.pad[k]+12),acc=j%4===0?1:.72;
    add(t,.9,u=>Math.exp(-u*7)*(Math.sin(TAU*f*u)+.22*Math.sin(TAU*f*4*u)*Math.exp(-u*22))*Math.min(1,u/.004),{gain:.11*acc,pan:j%2?.35:-.35,send:.35})});
  // Bass: root on 1, a pickup on the "and" of 2, the fifth on 3.
  if(t0>=4.8&&t0<OUTRO+BAR){
    [[0,c.root,.95],[1.5,c.root,.55],[2,c.root+7,.8]].forEach(([b,m,v])=>{const f=hz(m),len=BEAT*1.4;
      add(t0+b*BEAT,len,u=>env(u,len,.01,.18)*(Math.sin(TAU*f*u)+.25*Math.sin(TAU*f*2*u))*(1-.25*Math.min(1,u*3)),{gain:.19*v})});
  }
  // Drums.
  for(let beat=0;beat<4;beat++){const t=t0+beat*BEAT;if(!drumsOn(t))continue;
    if(beat%2===0||(fullOn(t)&&beat===3&&bar%2===1))add(t,.32,u=>{const f=48+80*Math.exp(-u*30);return Math.exp(-u*14)*Math.sin(TAU*f*u)},{gain:fullOn(t)?.24:.16});
    if(beat%2===1&&fullOn(t)){let p=0;add(t,.22,u=>{const n=rnd()*2-1,h=n-p;p=n;return Math.exp(-u*24)*(h*.6+.5*Math.sin(TAU*190*u)*Math.exp(-u*40))},{gain:.09,pan:-.1,send:.25})}
    for(const off of [0,.5]){const th=t+off*BEAT;let p=0;
      add(th,.06,u=>{const n=rnd()*2-1,h=n-p;p=n;return Math.exp(-u*80)*h},{gain:off?.05:.03,pan:.3})}
  }
}

// Bell motif over the groove: four-bar phrases, every other phrase.
const MOTIF=[[0,76],[.75,79],[1.5,81],[2.5,79],[3,76],[4,74],[5,76],[6,72],[6.5,74],[7,76]];
for(let ph=0;ph*4*BAR<DUR;ph++){const t0=ph*4*BAR;if(t0<14||t0>=OUTRO-2||ph%2)continue;
  for(const [b,m] of MOTIF){const t=t0+b*BEAT,f=hz(m+12);
    add(t,1.6,u=>Math.exp(-u*3.2)*(Math.sin(TAU*f*u)+.3*Math.sin(TAU*f*2.76*u)*Math.exp(-u*9)),{gain:.035,pan:.15,send:.7})}}

// Swells into each scene change, and chimes on the NFA reveal and the outro.
const swell=at=>{let p=0;add(at-1.1,1.25,u=>{const n=rnd()*2-1,h=.3*n+.7*p;p=h;return Math.pow(u/1.25,2.4)*h*(u<1.18?1:Math.max(0,(1.25-u)/.07))},{gain:.11,send:.4})};
SCENES.forEach(swell);
const chime=(at,notes,g=.06)=>notes.forEach((m,i)=>{const f=hz(m);add(at+i*.07,2.8,u=>Math.exp(-u*1.6)*(Math.sin(TAU*f*u)+.35*Math.sin(TAU*f*3.01*u)*Math.exp(-u*4)),{gain:g,pan:(i-1)*.3,send:.8})});
chime(REVEAL,[84,88,91]);chime(OUTRO+.3,[72,76,79,84],.05);

// Reverb: four damped feedback combs per side, then two allpasses.
function reverb(src,delays,fb=.8,damp=.35){
  const out=new Float32Array(N);
  for(const d of delays){const buf=new Float32Array(d);let k=0,lp=0;
    for(let i=0;i<N;i++){const y=buf[k];lp=y*(1-damp)+lp*damp;buf[k]=src[i]+lp*fb;out[i]+=y*.25;k=(k+1)%d}}
  for(const d of [556,441]){const buf=new Float32Array(d);let k=0;
    for(let i=0;i<N;i++){const b=buf[k],y=-out[i]+b;buf[k]=out[i]+b*.5;out[i]=y;k=(k+1)%d}}
  return out;
}
const RL=reverb(VL,[1557,1617,1491,1422]),RR=reverb(VR,[1580,1640,1514,1445]);

// Master: reverb return, gentle saturation, fades, normalize.
let peak=0;const fadeOut=3;
for(let i=0;i<N;i++){const t=i/SR,f=Math.min(1,t/.4)*Math.min(1,(DUR-t)/fadeOut);
  L[i]=Math.tanh((L[i]+RL[i]*.32)*1.3)*f;R[i]=Math.tanh((R[i]+RR[i]*.32)*1.3)*f;peak=Math.max(peak,Math.abs(L[i]),Math.abs(R[i]))}
const norm=.89/peak;

// 16-bit PCM WAV.
const data=Buffer.alloc(N*4);
for(let i=0;i<N;i++){data.writeInt16LE(Math.round(Math.max(-1,Math.min(1,L[i]*norm))*32767),i*4);data.writeInt16LE(Math.round(Math.max(-1,Math.min(1,R[i]*norm))*32767),i*4+2)}
const h=Buffer.alloc(44);h.write('RIFF',0);h.writeUInt32LE(36+data.length,4);h.write('WAVE',8);h.write('fmt ',12);h.writeUInt32LE(16,16);h.writeUInt16LE(1,20);h.writeUInt16LE(2,22);
h.writeUInt32LE(SR,24);h.writeUInt32LE(SR*4,28);h.writeUInt16LE(4,32);h.writeUInt16LE(16,34);h.write('data',36);h.writeUInt32LE(data.length,40);
await mkdir(dirname(OUT),{recursive:true});await writeFile(OUT,Buffer.concat([h,data]));
console.log(`${OUT} — ${DUR}s, ${BPM} BPM, peak normalized`);
