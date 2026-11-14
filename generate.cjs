#!/usr/bin/env node
'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const sharp=require('sharp');
const ROOT=__dirname, VERSION='2.0.0', SIZE=768;
const PALETTES={citrus:'#B8E82E',lilac:'#B69ADD',apricot:'#F8B47D',sky:'#79BEE9',cobalt:'#667DDA',mint:'#91D8B9',butter:'#F0D66F',rose:'#E69FB8',graphite:'#687383',coral:'#EE8F85',ice:'#97DDE2',periwinkle:'#A6A8DF'};
const TRAITS={body:['pebble','cube','star','capsule','sphere','cloud','teardrop','bean'],palette:Object.keys(PALETTES),expression:['curious','focused','joyful','thoughtful','calm','skeptical','excited','sleepy','surprised','determined'],tool:['none','magnifier','notebook','pencil','laptop','map','microphone','pen','swatches','shield','bag','telescope','toolkit'],eyewear:['none','round-wire','rectangular','oversized-round','half-rim','oval-sun','angular-sun','monocle','clear-visor'],attachment:['none','sprout','bow','star-pin','antenna','flower','butterfly'],ornament:['none','halo','sparkles','crown','satellite'],hat:['none','beanie','explorer-cap'],finish:['clay','rubber','felt','ceramic','frosted','metal'],marking:['plain','cheeks','freckles','speckles','stripe','symbol'],background:['studio','archive','garden','observatory','workbench','map-room','reading-nook','gallery','dispatch','recording-booth'],frame:['portrait','passport','capsule']};
// Fractional coordinates refer to each tightly cropped full-body sprite.
const ANCHORS={pebble:{face:[.5,.44,.43],head:[.5,.08,.78]},cube:{face:[.5,.43,.44],head:[.5,.05,.78]},star:{face:[.5,.51,.36],head:[.5,.21,.57]},capsule:{face:[.5,.43,.46],head:[.5,.03,.76]},sphere:{face:[.5,.43,.45],head:[.5,.04,.78]},cloud:{face:[.5,.48,.41],head:[.5,.22,.65]},teardrop:{face:[.5,.55,.4],head:[.5,.27,.62]},bean:{face:[.55,.45,.42],head:[.58,.09,.65]}};
const FOUNDING=[
 ['Scout','Researcher','pebble','citrus','curious','magnifier','none','clay','map-room'],
 ['Sage','Analyst','cube','lilac','calm','notebook','glasses','felt','archive'],
 ['Muse','Creator','star','apricot','joyful','pencil','none','clay','studio'],
 ['Patch','Builder','capsule','sky','focused','laptop','none','rubber','workbench'],
 ['Atlas','Planner','sphere','cobalt','determined','map','explorer-cap','ceramic','map-room'],
 ['Bloom','Community','cloud','mint','joyful','none','none','felt','garden'],
 ['Quill','Writer','teardrop','butter','thoughtful','pen','none','clay','reading-nook'],
 ['Prism','Designer','star','rose','excited','swatches','none','frosted','gallery'],
 ['Ward','Guardian','cube','graphite','calm','shield','none','rubber','observatory'],
 ['Pip','Courier','bean','coral','excited','bag','none','clay','dispatch'],
 ['Echo','Interpreter','sphere','ice','curious','microphone','headphones','frosted','recording-booth'],
 ['Nova','Explorer','star','periwinkle','surprised','telescope','none','ceramic','observatory']
].map(([name,role,body,palette,expression,tool,headwear,finish,background])=>({name,role,traits:{body,palette,expression,tool,eyewear:headwear==='glasses'?'round-wire':'none',attachment:headwear==='headphones'?'antenna':'none',ornament:'none',hat:headwear==='explorer-cap'?'explorer-cap':'none',finish,background,marking:'plain',frame:'passport'}}));
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const canonical=t=>JSON.stringify(Object.fromEntries(Object.keys(TRAITS).map(k=>[k,t[k]])));
const escape=x=>String(x).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
function rng(seed){let i=0;return()=>parseInt(hash(seed+':'+i++).slice(0,8),16)/4294967296;}
const HAT_BODIES=['sphere','capsule'];
const HEAD_SLOTS=['attachment','ornament','hat'];
function validate(t){
 for(const k of Object.keys(t))if(!TRAITS[k])throw Error('Unknown trait: '+k);
 for(const [k,v] of Object.entries(TRAITS))if(!v.includes(t[k]))throw Error('Invalid '+k+': '+t[k]+'. Choose '+v.join(', '));
 if(t.hat!=='none'&&!HAT_BODIES.includes(t.body))throw Error('Incompatible hat/body: hats fit sphere or capsule only');
 if(HEAD_SLOTS.filter(k=>t[k]!=='none').length>1)throw Error('Use only one attachment, ornament or hat');
 return t;
}
function pickTraits(seed,overrides={}){
 const r=rng(seed),t={};for(const[k,v]of Object.entries(TRAITS))t[k]=v[Math.floor(r()*v.length)];
 // Fitted hats are opt-in. Default batches use only glasses, small attachments and floating ornaments.
 t.attachment=t.ornament=t.hat='none';if(r()<.45)t.eyewear='none';
 const accent=r();if(accent<.30)t.attachment=TRAITS.attachment[1+Math.floor(r()*6)];else if(accent<.50)t.ornament=TRAITS.ornament[1+Math.floor(r()*4)];
 if(HEAD_SLOTS.some(k=>overrides[k]&&overrides[k]!=='none'))for(const k of HEAD_SLOTS)t[k]='none';
 if(overrides.hat&&overrides.hat!=='none'&&!overrides.body)t.body=HAT_BODIES[Math.floor(r()*HAT_BODIES.length)];
 return validate({...t,...overrides});
}
// Measured eye centers in each trimmed expression sprite, independent of head silhouette.
const EYES={curious:[.198,.798,.573],focused:[.19,.802,.56],joyful:[.193,.802,.526],thoughtful:[.222,.796,.591],calm:[.190,.806,.566],skeptical:[.202,.797,.577],excited:[.198,.797,.523],sleepy:[.197,.803,.528],surprised:[.212,.764,.554],determined:[.175,.810,.532]};
// Lens center landmarks in the trimmed eyewear sprites: left X, right X, eye Y.
const LENSES={'round-wire':[.24,.76,.50],rectangular:[.26,.75,.50],'oversized-round':[.25,.76,.51],'half-rim':[.27,.75,.45],'oval-sun':[.25,.75,.50],'angular-sun':[.26,.75,.49],'clear-visor':[.25,.75,.48],monocle:[.61,.61,.36]};
function eyewearLayout(t,face){
 const e=EYES[t.expression],l=LENSES[t.eyewear];
 const left=face.left+face.width*e[0],right=face.left+face.width*e[1],cy=face.top+face.height*e[2];
 const width=t.eyewear==='monocle'?(right-left)*.87:(right-left)/(l[1]-l[0]);
 return {width,cx:t.eyewear==='monocle'?right:(left+right)/2,cy,lensX:t.eyewear==='monocle'?l[0]:(l[0]+l[1])/2,lensY:l[2]};
}
async function topAt(body,fraction){
 const {data,info}=await sharp(body).ensureAlpha().raw().toBuffer({resolveWithObject:true});
 const col=Math.round(info.width*fraction);
 for(let y=0;y<info.height;y++)if(data[(y*info.width+col)*4+3]>210)return y;
 throw Error('Attachment anchor missed body');
}
const svg=body=>Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="768" height="768" viewBox="0 0 768 768">${body}</svg>`);
const transparent=()=>sharp({create:{width:SIZE,height:SIZE,channels:4,background:'#00000000'}});
let catalogCache;
async function catalog(){return catalogCache ||= JSON.parse(await fs.readFile(path.join(ROOT,'assets/catalog.json'),'utf8'));}
async function sprite(group,name){const c=await catalog();return fs.readFile(path.join(ROOT,c[group][name].file));}
function rgb(hex){return hex.match(/\w\w/g).map(x=>parseInt(x,16));}
async function tintedBody(t){
 const {data,info}=await sharp(await sprite('bodies',t.body)).ensureAlpha().raw().toBuffer({resolveWithObject:true});
 const color=rgb(PALETTES[t.palette]);const random=rng('finish:'+canonical(t));
 for(let i=0;i<data.length;i+=4){const l=(data[i]+data[i+1]+data[i+2])/3/255;let shade=.40+l*.77;
  if(t.finish==='rubber')shade=.5+l*.62;
  if(t.finish==='ceramic')shade=.20+l*1.03;
  if(t.finish==='metal')shade=.12+l*1.15;
  const grain=t.finish==='felt'?(random()-.5)*14:0;
  for(let c=0;c<3;c++){let value=color[c]*Math.min(1,shade)+Math.max(0,shade-1)*255+grain;if(t.finish==='frosted')value=value*.73+255*.27;data[i+c]=Math.round(Math.max(0,Math.min(255,value)));}
 }
 return sharp(data,{raw:info}).png().toBuffer();
}
async function fitted(input,width,height){return sharp(input).resize(Math.round(width),Math.round(height),{fit:'inside'}).png().toBuffer({resolveWithObject:true});}
function motif(t){const c=PALETTES[t.palette],stroke=`stroke="${c}" stroke-width="3" fill="none" opacity=".22"`;
 const book=(x,y,w,h)=>`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="5" ${stroke}/>`;
 switch(t.background){
  case 'archive':return Array.from({length:8},(_,i)=>book(65+i*80,170,45,150)).join('')+`<path d="M55 325H713M55 485H713" ${stroke}/>`;
  case 'garden':return [80,150,620,695].map((x,i)=>`<path d="M${x} 600Q${x-70} 420 ${x} ${290+i*25}Q${x+65} 430 ${x} 600" ${stroke}/>`).join('');
  case 'observatory':return [70,155,265,550,655,700].map((x,i)=>`<path d="M${x-9} ${160+i%3*60}h18m-9 -9v18" ${stroke}/>`).join('')+`<circle cx="600" cy="185" r="65" ${stroke}/>`;
  case 'map-room':return `<path d="M60 540C200 280 80 100 300 185S550 100 705 350M45 580C200 400 150 70 360 150S650 160 720 440" ${stroke}/>`;
  case 'workbench':return Array.from({length:15},(_,i)=>`<path d="M${50+i*48} 170v400" ${stroke}/>`).join('')+Array.from({length:9},(_,i)=>`<path d="M50 ${170+i*48}h670" ${stroke}/>`).join('');
  case 'reading-nook':return book(70,210,150,190)+book(570,200,120,210)+`<path d="M75 430h140M565 430h130" ${stroke}/>`;
  case 'gallery':return book(70,190,160,210)+book(545,200,150,190);
  case 'dispatch':return book(65,440,125,100)+book(590,430,115,100)+book(110,330,95,90);
  case 'recording-booth':return Array.from({length:15},(_,i)=>`<path d="M${65+i*45} ${220+(i%4)*18}v${230-(i%4)*36}" ${stroke}/>`).join('');
  default:return `<circle cx="120" cy="200" r="90" fill="${c}" opacity=".12"/><circle cx="630" cy="420" r="130" fill="${c}" opacity=".10"/>`;
 }
}
function backdrop(t){const c=PALETTES[t.palette];return svg(`<defs><linearGradient id="bg" x2="1" y2="1"><stop stop-color="#fffdf8"/><stop offset="1" stop-color="${c}" stop-opacity=".25"/></linearGradient></defs><rect width="768" height="768" fill="#faf8f1"/><rect x="18" y="18" width="732" height="732" rx="36" fill="url(#bg)" stroke="${c}" stroke-opacity=".5" stroke-width="2"/>${motif(t)}<ellipse cx="384" cy="629" rx="238" ry="27" fill="${c}" opacity=".17"/>`);}
function markings(t,x,y,w,h){let shapes='';const a=ANCHORS[t.body].face,fx=x+w*a[0],fy=y+h*a[1];
 if(t.marking==='cheeks')shapes=`<ellipse cx="${fx-w*.19}" cy="${fy+h*.07}" rx="18" ry="10"/><ellipse cx="${fx+w*.19}" cy="${fy+h*.07}" rx="18" ry="10"/>`;
 if(['freckles','speckles'].includes(t.marking)){const r=rng('marks:'+canonical(t));for(let i=0;i<(t.marking==='freckles'?8:22);i++){const px=t.marking==='freckles'?fx+(i%2?1:-1)*(w*.13+r()*w*.09):x+w*(.28+r()*.44),py=t.marking==='freckles'?fy+h*.055+r()*13:y+h*(.62+r()*.13);shapes+=`<circle cx="${px}" cy="${py}" r="${2+r()*2}"/>`;}}
 if(t.marking==='stripe')shapes=`<path d="M${x+w*.30} ${y+h*.72}q${w*.20} 12 ${w*.4} -6" stroke="#ffffff" stroke-width="14" fill="none"/>`;
 if(t.marking==='symbol')shapes=`<path d="M${fx} ${fy-h*.25}l9 12 -9 12 -9 -12z"/>`;
 return svg(`<g fill="${t.marking==='cheeks'?'#f39ea1':'#ffffff'}" opacity=".55">${shapes}</g>`);
}
async function renderCharacter(t){
 validate(t);const layers=[];const body=await fitted(await tintedBody(t),500,500);
 const w=body.info.width,h=body.info.height,x=Math.round((SIZE-w)/2),y=630-h;
 layers.push({input:body.data,left:x,top:y});
 layers.push({input:markings(t,x,y,w,h),left:0,top:0});
 const a=ANCHORS[t.body],f=await fitted(await sprite('expressions',t.expression),w*a.face[2],h*.25);
 const fx=x+w*a.face[0],fy=y+h*a.face[1];
 layers.push({input:f.data,left:Math.round(fx-f.info.width/2),top:Math.round(fy-f.info.height/2)});
 if(t.eyewear!=='none'){
  const q=eyewearLayout(t,{left:fx-f.info.width/2,top:fy-f.info.height/2,width:f.info.width,height:f.info.height});
  const glasses=await sharp(await sprite('eyewear',t.eyewear)).resize(Math.round(q.width)).png().toBuffer({resolveWithObject:true});
  layers.push({input:glasses.data,left:Math.round(q.cx-glasses.info.width*q.lensX),top:Math.round(q.cy-glasses.info.height*q.lensY)});
 }
 if(t.attachment!=='none'){
  const fraction=['bow','flower','butterfly','star-pin'].includes(t.attachment)?.66:.48;
  const surface=y+await topAt(body.data,fraction);
  const piece=await fitted(await sprite('attachments',t.attachment),84,85);
  layers.push({input:piece.data,left:Math.round(x+w*fraction-piece.info.width/2),top:Math.round(surface-piece.info.height+9)});
 }
 if(t.ornament!=='none'){
  const satellite=t.ornament==='satellite';
  const piece=await fitted(await sprite('ornaments',t.ornament),t.ornament==='halo'?150:110,t.ornament==='halo'?48:70);
  const ox=satellite?x+w*.88:fx,oy=satellite?y+h*.13:y-18;
  layers.push({input:piece.data,left:Math.round(ox-piece.info.width/2),top:Math.max(42,Math.round(oy-piece.info.height))});
 }
 if(t.hat!=='none'){
  // Deliberately fitted variants; only these two rounded silhouettes are supported.
  const fit={sphere:{'beanie':[.78,.29,.25],'explorer-cap':[.94,.28,.26]},capsule:{'beanie':[.76,.28,.23],'explorer-cap':[.96,.26,.23]}}[t.body][t.hat];
  const piece=await sharp(await sprite('headwear',t.hat)).resize(Math.round(w*fit[0]),Math.round(h*fit[1]),{fit:'fill'}).png().toBuffer({resolveWithObject:true});
  layers.push({input:piece.data,left:Math.round(fx-piece.info.width/2),top:Math.round(y+h*fit[2]-piece.info.height)});
 }
 if(t.tool!=='none'){
  const laptop=t.tool==='laptop',tool=await fitted(await sprite('tools',t.tool),laptop?240:165,laptop?170:190);
  const tx=laptop?384:x+w*.84,ty=laptop?550:535;
  layers.push({input:tool.data,left:Math.round(tx-tool.info.width/2),top:Math.round(ty-tool.info.height/2)});
 }
 return transparent().composite(layers).png().toBuffer();
}
async function renderCard(t,character,name,id,role){
 const layers=t.frame==='capsule'?[{input:await sharp(character).resize(676,676).toBuffer(),left:46,top:76}]:[{input:character,left:0,top:0}];
 if(t.frame==='capsule')layers.push({input:svg('<path d="M110 635V280C110 20 658 20 658 280V635" fill="#ffffff" fill-opacity=".07" stroke="#b3b8b5" stroke-width="7"/><path d="M132 520V280Q132 115 300 103" fill="none" stroke="#ffffff" stroke-opacity=".7" stroke-width="10"/><rect x="98" y="626" width="572" height="35" rx="17" fill="#e7e8df" stroke="#c3c9bd"/>'),left:0,top:0});
 if(t.frame!=='portrait')layers.push({input:svg(`<text x="52" y="65" font-family="sans-serif" font-weight="700" font-size="20" fill="#222b2d">nfa.cool</text><text x="715" y="65" text-anchor="end" font-family="monospace" font-size="18" fill="#59645e">#${escape(id)}</text><text x="52" y="700" font-family="sans-serif" font-weight="700" font-size="30" fill="#222b2d">${escape(name)}</text><text x="52" y="728" font-family="sans-serif" font-size="16" fill="#59645e">${escape(role||t.body+' / '+t.expression)}</text>`),left:0,top:0});
 return sharp(backdrop(t)).composite(layers).png().toBuffer();
}
async function assetDigest(){const c=await catalog();for(const g of Object.values(c))for(const item of Object.values(g)){if(hash(await fs.readFile(path.join(ROOT,item.file)))!==item.sha256)throw Error('Asset checksum mismatch: '+item.file);}return hash(JSON.stringify(c));}
async function makeContact(records,dir,titleText='Generated collection'){const cell=300,cols=4,rows=Math.ceil(records.length/cols),layers=[];
 for(let i=0;i<records.length;i++){const image=await sharp(path.join(dir,records[i].image)).resize(cell,cell).toBuffer();layers.push({input:image,left:(i%cols)*cell,top:80+Math.floor(i/cols)*cell});}
 const title=Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="80"><rect width="1200" height="80" fill="#faf8f1"/><text x="28" y="37" font-size="25" font-family="sans-serif" font-weight="700" fill="#242a25">nfa.cool / ${escape(titleText)}</text><text x="28" y="62" font-size="14" font-family="sans-serif" fill="#617063">${records.length} characters assembled from reusable parts</text></svg>`);
 layers.push({input:title,left:0,top:0});
 await sharp({create:{width:cols*cell,height:rows*cell+80,channels:4,background:'#faf8f1'}}).composite(layers).png().toFile(path.join(dir,'contact-sheet.png'));
}
async function gallery(records,dir){const cards=records.map(r=>`<article><a href="${r.image}"><img src="${r.image}" alt="${escape(r.name)}" loading="lazy"></a><h2>${escape(r.name)}</h2><p>${escape(r.attributes.map(a=>a.value).join(' · '))}</p><a href="metadata/${r.id}.json">Traits JSON</a> · <a href="cutouts/${r.id}.png">Transparent PNG</a></article>`).join('');await fs.writeFile(path.join(dir,'index.html'),`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>NFA collection</title><style>body{margin:0;background:#f8f7f1;color:#202925;font:16px system-ui;padding:40px}header{max-width:1100px;margin:auto auto 30px}h1{font-size:42px;margin:0}main{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:20px;max-width:1200px;margin:auto}article{background:white;border:1px solid #dde4d6;border-radius:20px;padding:12px}img{width:100%;border-radius:12px}h2{margin:12px 0 5px}p{color:#627062;font-size:13px;line-height:1.6}a{color:#3d6831}footer{margin:30px auto;max-width:1200px}</style><header><h1>nfa.cool</h1><p>A collection generated from modular parts. Open a character to inspect its traits.</p></header><main>${cards}</main><footer>Local artwork preview · no minting or wallet connection</footer></html>`);}
function parse(argv){const o={count:12,seed:'nfa-gent-v2',out:'output/random',size:768,overrides:{}};for(let i=0;i<argv.length;i++){const a=argv[i];if(a==='--help'||a==='-h'){o.help=true;continue;}if(a==='--force'){o.force=true;continue;}if(a==='--list-traits'){o.list=true;continue;}const k={'--count':'count','--seed':'seed','--out':'out','--size':'size','--preset':'preset','--from':'from','--start':'start','--title':'title'}[a];if(k){if(argv[i+1]===undefined||argv[i+1].startsWith('--'))throw Error('Missing value for '+a);o[k]=argv[++i];continue;}if(a==='--set'){const s=argv[++i]||'',idx=s.indexOf('=');if(idx<1)throw Error('Use --set trait=value');o.overrides[s.slice(0,idx)]=s.slice(idx+1);continue;}throw Error('Unknown option '+a);}o.count=Number(o.count);o.size=Number(o.size);o.start=Number(o.start??1);if(!Number.isInteger(o.count)||o.count<1||o.count>1000)throw Error('count must be 1..1000');if(!Number.isInteger(o.size)||o.size<128||o.size>2048)throw Error('size must be 128..2048');if(!Number.isSafeInteger(o.start)||o.start<1)throw Error('start must be a positive integer');if(o.preset&&!['founding','eyewear','accents','mixed-v2'].includes(o.preset))throw Error('Unknown preset');if(o.preset&&o.from)throw Error('Use either --preset or --from');return o;}
async function main(argv=process.argv.slice(2)){
 const o=parse(argv);if(o.help){console.log('NFA generator\nnode generate.cjs --preset founding --out output/founding\nnode generate.cjs --count 24 --seed my-collection --out output/random\nnode generate.cjs --count 1 --set body=cloud --set palette=mint\nnode generate.cjs --from output/founding/metadata/001.json --out output/replay\nPresets: founding, eyewear, accents, mixed-v2\nOptions: --size 128..2048, --start 1, --title text, --force, --list-traits\nEvery avatar includes a card PNG, transparent cutout PNG and JSON manifest.');return;}
 if(o.list){console.log(JSON.stringify(TRAITS,null,2));return;}
 const digest=await assetDigest(),items=[],used=new Set();
 if(o.from){const m=JSON.parse(await fs.readFile(o.from,'utf8'));if(m.generator_version!==VERSION)throw Error('Manifest generator version mismatch');if(m.asset_digest!==digest)throw Error('Manifest asset version mismatch');items.push({id:String(m.id),name:m.name,role:m.role,traits:validate({...m.traits,...o.overrides}),seed:m.seed,size:o.size});if(!argv.includes('--size'))o.size=m.render_size||768;}
 else if(o.preset){const preset=o.preset==='founding'?FOUNDING:showcase(o.preset);for(let i=0;i<preset.length;i++)items.push({...preset[i],id:String(o.start+i).padStart(3,'0'),traits:validate({...preset[i].traits,...o.overrides}),seed:o.preset+'-v2:'+i});}
 else for(let i=0;i<o.count;i++){const id=String(o.start+i).padStart(3,'0');let t,seed;for(let attempt=0;attempt<10000;attempt++){seed=o.seed+':'+id+':'+attempt;t=pickTraits(seed,o.overrides);if(!used.has(canonical(t)))break;if(attempt===9999)throw Error('Requested unique count exceeds available combinations under trait locks');}used.add(canonical(t));items.push({id,name:'NFA '+id,role:'',traits:t,seed});}
 for(const item of items)if(!/^\d{1,16}$/.test(item.id))throw Error('Manifest id must be a numeric filename');
 const out=path.resolve(o.out);let exists=false;try{exists=(await fs.readdir(out)).length>0;}catch(e){if(e.code!=='ENOENT')throw e;}
 if(exists&&!o.force)throw Error('Output directory is not empty. Choose a new --out or explicitly use --force.');
 for(const folder of ['images','cutouts','metadata'])await fs.mkdir(path.join(out,folder),{recursive:true});
 const records=[];
 for(const item of items){const cutout=await renderCharacter(item.traits),card=await renderCard(item.traits,cutout,item.name,item.id,item.role);
  const filename='images/'+item.id+'.png';const rendered=await sharp(card).resize(o.size,o.size).png().toBuffer();
  await fs.writeFile(path.join(out,filename),rendered);await sharp(cutout).resize(o.size,o.size).png().toFile(path.join(out,'cutouts',item.id+'.png'));
  const m={...item,image:filename,description:'A modular NFA character. Artwork only; no on-chain token has been minted.',generator_version:VERSION,asset_digest:digest,render_size:o.size,dna:hash(canonical(item.traits)),image_sha256:hash(rendered),attributes:Object.entries(item.traits).map(([trait_type,value])=>({trait_type,value}))};delete m.size;
  await fs.writeFile(path.join(out,'metadata',item.id+'.json'),JSON.stringify(m,null,2)+'\n');records.push(m);
 }
 await fs.writeFile(path.join(out,'collection.json'),JSON.stringify(records,null,2)+'\n');await gallery(records,out);await makeContact(records.slice(0,100),out,o.title||({'eyewear':'Glasses for every shape','accents':'Small attachments + floating companions','mixed-v2':'The revised collection'}[o.preset]||'Generated collection'));
 console.log('Generated '+records.length+' characters in '+out+'\nOpen index.html or contact-sheet.png.');return records;
}
function showcase(preset){
 const result=[];const names=['Scout','Sage','Muse','Patch','Atlas','Bloom','Quill','Pip'];
 for(let i=0;i<16;i++){
  const b=i%8,t=pickTraits('showcase-v2:'+preset+':'+i,{body:TRAITS.body[b],palette:TRAITS.palette[(i+3)%12],expression:['curious','calm','joyful','focused','thoughtful','skeptical','excited','determined'][b],tool:'none',eyewear:'none',attachment:'none',ornament:'none',hat:'none',finish:'clay',marking:'plain',background:'studio',frame:'passport'});
  let detail='';
  if(preset==='eyewear'){t.eyewear=TRAITS.eyewear[1+(b+(i>=8?3:0))%8];detail=t.eyewear;}
  if(preset==='accents'){if(i<8){t.attachment=TRAITS.attachment[1+b%6];detail=t.attachment;}else{t.ornament=TRAITS.ornament[1+b%4];detail='floating '+t.ornament;}}
  if(preset==='mixed-v2'){
   t.tool=TRAITS.tool[1+(i*5)%12];t.eyewear=i%3===0?'none':TRAITS.eyewear[1+(i*3)%8];
   if(i<6)t.attachment=TRAITS.attachment[1+i];else if(i<10)t.ornament=TRAITS.ornament[1+(i-6)];
   else if(i>=12){t.body=i%2?'capsule':'sphere';t.hat=i<14?'beanie':'explorer-cap';}
   detail=[t.eyewear,t.attachment,t.ornament,t.hat].filter(x=>x!=='none').join(' + ')||'bare head';
  }
  result.push({name:names[b]+' '+(i<8?'01':'02'),role:t.body+' / '+detail,traits:validate(t)});
 }
 return result;
}
module.exports={TRAITS,FOUNDING,pickTraits,validate,renderCharacter,main,canonical,eyewearLayout,EYES,LENSES,showcase};
if(require.main===module)main().catch(e=>{console.error('Error: '+e.message);process.exitCode=1;});
