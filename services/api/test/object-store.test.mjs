import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawnSync} from 'node:child_process';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {S3Objects} from '../object-store.mjs';
import {WorkStore} from '../work-store.mjs';
import {ArtifactStore} from '../artifact-store.mjs';

const hasAws=spawnSync('aws',['--version'],{encoding:'utf8'}).status===0;
test('S3 boundary survives replacement of API cache and rejects corrupted objects',{skip:!hasAws?'AWS CLI is required for the S3 adapter integration test':false},async()=>{
  const data=new Map();let fail=false;
  const server=createServer(async(req,res)=>{
    if(fail){res.writeHead(503);res.end();return}
    if(req.method==='PUT'){const chunks=[];for await(const c of req)chunks.push(c);data.set(req.url,Buffer.concat(chunks));res.writeHead(200,{etag:'"nfa-test"'});res.end();return}
    const body=data.get(req.url);res.writeHead(body?200:404,body?{'content-length':body.length}:{});res.end(body);
  });
  const directory=await mkdtemp(join(tmpdir(),'nfa-s3-test-'));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const objects=new S3Objects({bucket:'nfa-test',endpoint:`http://127.0.0.1:${server.address().port}`,env:{...process.env,
      AWS_ACCESS_KEY_ID:'local-test',AWS_SECRET_ACCESS_KEY:'local-test',AWS_EC2_METADATA_DISABLED:'true',AWS_MAX_ATTEMPTS:'1'}});
    const old=new WorkStore(join(directory,'old'),{objects,namespace:'manifests'});
    const saved=await old.put({displayName:'Persistent NFA'});
    const replacement=new WorkStore(join(directory,'replacement'),{objects,namespace:'manifests'});
    assert.equal((await replacement.get(saved.outputHash)).displayName,'Persistent NFA');
    const art=new ArtifactStore(join(directory,'art'),{objects});
    const png=await readFile(new URL('../../../assets/bodies/sphere.png',import.meta.url));
    const image=await art.putImage(png);
    assert.deepEqual(await new ArtifactStore(join(directory,'replacement-art'),{objects}).getImage(image.hash.slice(7)),png);
    const key=[...data.keys()].find(key=>key.includes('manifests/'));data.set(key,Buffer.from('{"displayName":"changed"}'));
    await assert.rejects(()=>replacement.get(saved.outputHash),/integrity/);
    fail=true;await assert.rejects(()=>old.put({displayName:'Unpublished'}),/unavailable/);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true})}
});
