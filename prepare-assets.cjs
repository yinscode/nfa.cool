#!/usr/bin/env node
// One-time atlas slicing. Finished PNG parts are already bundled.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');
const ROOT = __dirname;
const GROUPS = {
  bodies: { file:'bodies.png', cols:4, rows:2, cutoff:48, names:['pebble','cube','star','capsule','sphere','cloud','teardrop','bean'] },
  expressions: { file:'expressions.png', cols:5, rows:2, cutoff:36, names:['curious','focused','joyful','thoughtful','calm','skeptical','excited','sleepy','surprised','determined'] },
  tools: { file:'tools.png', cols:4, rows:3, cutoff:55, names:['magnifier','notebook','pencil','laptop','map','microphone','pen','swatches','shield','bag','telescope','toolkit'] },
  eyewear: {file:'eyewear.png',cols:4,rows:2,cutoff:170,names:['round-wire','rectangular','oversized-round','half-rim','oval-sun','angular-sun','monocle','clear-visor']},
  attachments: {file:'attachments.png',cols:3,rows:2,cutoff:210,names:['sprout','bow','star-pin','antenna','flower','butterfly']},
  ornaments: {file:'ornaments.png',cols:2,rows:2,cutoff:170,names:['halo','sparkles','crown','satellite']},
  headwear: { file:'headwear.png', cols:4, rows:2, cutoff:205, names:['glasses','headphones','explorer-cap','beanie','visor','antenna','headband','headset'] }
};
async function main() {
 const catalog = {};
 for (const [group,g] of Object.entries(GROUPS)) {
  const source=path.join(ROOT,'source-atlases',g.file);
  const meta=await sharp(source).metadata();
  await fs.mkdir(path.join(ROOT,'assets',group),{recursive:true});
  catalog[group]={};
  for(let n=0;n<g.names.length;n++) {
   const col=n%g.cols,row=Math.floor(n/g.cols);
   const left=Math.round(col*meta.width/g.cols),top=Math.round(row*meta.height/g.rows);
   const width=Math.round((col+1)*meta.width/g.cols)-left,height=Math.round((row+1)*meta.height/g.rows)-top;
   const {data,info}=await sharp(source).extract({left,top,width,height}).ensureAlpha().raw().toBuffer({resolveWithObject:true});
   for(let i=3;i<data.length;i+=4) data[i]=Math.round(Math.max(0,(data[i]-g.cutoff)/(255-g.cutoff))*255);
   // Drop disconnected atlas specks, retaining separate face/limb components.
   const seen=new Uint8Array(width*height), components=[];
   for(let p=0;p<seen.length;p++) {
    if(seen[p] || data[p*4+3]<20)continue;
    const q=[p];seen[p]=1;
    for(let j=0;j<q.length;j++) {const a=q[j],x=a%width,y=Math.floor(a/width);
     for(const b of [x>0?a-1:-1,x+1<width?a+1:-1,y>0?a-width:-1,y+1<height?a+width:-1])
      if(b>=0&&!seen[b]&&data[b*4+3]>=20){seen[b]=1;q.push(b);}
    } components.push(q);
   }
   const minimum=Math.max(8,width*height*0.0007);
   for(const q of components)if(q.length<minimum)for(const p of q)data[p*4+3]=0;
   let x0=width,y0=height,x1=0,y1=0;
   for(let y=0;y<height;y++)for(let x=0;x<width;x++)if(data[(y*width+x)*4+3]>20){x0=Math.min(x0,x);y0=Math.min(y0,y);x1=Math.max(x1,x);y1=Math.max(y1,y);}
   if(x1<=x0)throw Error('Empty sprite '+group+'/'+g.names[n]);
   x0=Math.max(0,x0-2);y0=Math.max(0,y0-2);x1=Math.min(width-1,x1+2);y1=Math.min(height-1,y1+2);
   const filename='assets/'+group+'/'+g.names[n]+'.png';
   const png=await sharp(data,{raw:info}).extract({left:x0,top:y0,width:x1-x0+1,height:y1-y0+1}).png().toBuffer();
   await fs.writeFile(path.join(ROOT,filename),png);
   catalog[group][g.names[n]]={file:filename,sha256:crypto.createHash('sha256').update(png).digest('hex')};
  }
 }
 await fs.writeFile(path.join(ROOT,'assets/catalog.json'),JSON.stringify(catalog,null,2)+'\n');
 console.log('Prepared '+Object.values(catalog).reduce((n,g)=>n+Object.keys(g).length,0)+' transparent PNG parts.');
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
