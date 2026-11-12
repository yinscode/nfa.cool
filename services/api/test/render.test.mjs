import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AvatarRenderer} from '../render.mjs';

test('preview is cached and matches its selected image checksum',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'nfa-render-'));
  try{
    const renderer=new AvatarRenderer(dir);
    const input={seed:'scout-one',traits:{body:'sphere',eyewear:'round-wire',attachment:'sprout'}};
    const a=await renderer.render(input),b=await renderer.render(input);
    assert.equal(a.key,b.key);assert.equal(a.imageHash,b.imageHash);
    assert.equal(a.metadata.traits.body,'sphere');
    assert.ok((await renderer.image(a.key)).length>1000);
    await assert.rejects(()=>renderer.render({seed:'bad/seed',traits:{}}),/Invalid avatar/);
  }finally{await rm(dir,{recursive:true,force:true})}
});
