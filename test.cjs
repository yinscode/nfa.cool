const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const sharp=require('sharp');
const {main,pickTraits,TRAITS}=require('./generate.cjs');

test('seeded collection, manifest replay, alpha exports and overwrite protection',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nfa-test-'));
 try {
  const first=await main(['--count','4','--seed','test-seed','--size','256','--out',path.join(root,'a')]);
  const second=await main(['--count','4','--seed','test-seed','--size','256','--out',path.join(root,'b')]);
  assert.equal(new Set(first.map(x=>x.dna)).size,4);
  assert.deepEqual(first,second);
  for(const r of first){
   assert.deepEqual(await fs.readFile(path.join(root,'a',r.image)),await fs.readFile(path.join(root,'b',r.image)));
   const {data,info}=await sharp(path.join(root,'a','cutouts',r.id+'.png')).ensureAlpha().raw().toBuffer({resolveWithObject:true});
   assert.equal(info.width,256);assert.equal(info.height,256);
   let clear=0,opaque=0;for(let i=3;i<data.length;i+=4){if(data[i]===0)clear++;if(data[i]>240)opaque++;}
   assert.ok(clear>10000);assert.ok(opaque>1000);
  }
  const replay=await main(['--from',path.join(root,'a','metadata','001.json'),'--out',path.join(root,'replay')]);
  assert.equal(replay[0].image_sha256,first[0].image_sha256);
  assert.deepEqual(await fs.readFile(path.join(root,'replay',replay[0].image)),await fs.readFile(path.join(root,'a',first[0].image)));
  await assert.rejects(main(['--count','1','--out',path.join(root,'a')]),/not empty/);
  await assert.rejects(main(['--count','1','--set','body=unknown','--out',path.join(root,'bad')]),/Invalid body/);
  await assert.rejects(fs.stat(path.join(root,'bad')),/ENOENT/);
 } finally {await fs.rm(root,{recursive:true,force:true});}
});

test('56 shipped transparent parts contain visible art and transparent pixels',async()=>{
 const catalog=JSON.parse(await fs.readFile(path.join(__dirname,'assets/catalog.json'),'utf8'));
 let count=0;
 for(const group of Object.values(catalog))for(const item of Object.values(group)){
  const {data,info}=await sharp(path.join(__dirname,item.file)).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  assert.ok(info.width>20&&info.height>20,item.file);
  let max=0,zero=0;for(let i=3;i<data.length;i+=4){max=Math.max(max,data[i]);if(data[i]===0)zero++;}
  assert.ok(max>200,item.file);assert.ok(zero>100,item.file);count++;
 }
 assert.equal(count,56);
});

test('trait locks persist, IDs have independent deterministic seeds, invalid CLI inputs fail',async()=>{
 const locked={body:'cloud',palette:'mint',hat:'none'};
 for(let i=0;i<50;i++){const t=pickTraits('batch:'+i,locked);for(const[k,v]of Object.entries(locked))assert.equal(t[k],v);for(const[k,v]of Object.entries(t))assert.ok(TRAITS[k].includes(v));}
 for(const args of [['--count','0'],['--size','4096'],['--preset','bad'],['--unknown'],['--seed'],['--start','-1']])await assert.rejects(main(args));
});


test('head slot compatibility and eye registration',()=>{
 const {validate,eyewearLayout,EYES,LENSES,showcase}=require('./generate.cjs');
 for(let i=0;i<500;i++){
  const t=pickTraits('compat:'+i);assert.equal(t.hat,'none');
  assert.ok(['attachment','ornament','hat'].filter(k=>t[k]!=='none').length<=1);
 }
 assert.throws(()=>pickTraits('x',{body:'star',hat:'beanie'}),/Incompatible/);
 assert.throws(()=>pickTraits('x',{attachment:'bow',ornament:'halo'}),/only one/);
 for(let i=0;i<20;i++)assert.ok(['sphere','capsule'].includes(pickTraits('h:'+i,{hat:'beanie'}).body));
 for(const expression of TRAITS.expression)for(const eyewear of TRAITS.eyewear.slice(1)){
  const f={left:100,top:200,width:180,height:120},q=eyewearLayout({expression,eyewear},f),e=EYES[expression],l=LENSES[eyewear];
  assert.ok(Math.abs(q.cy-(f.top+f.height*e[2]))<1e-8);
  if(eyewear!=='monocle')assert.ok(Math.abs(q.width*(l[1]-l[0])-f.width*(e[1]-e[0]))<1e-8);
 }
 for(const preset of ['eyewear','accents','mixed-v2'])for(const r of showcase(preset))validate(r.traits);
});
