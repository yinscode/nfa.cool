#!/usr/bin/env node
// Install the official, checksum-pinned target only inside .deps; never alter system Rust.
import {mkdir,readFile,writeFile,readdir,symlink,access} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const run=promisify(execFile),version='1.88.0';
const url='https://static.rust-lang.org/dist/2025-06-26/rust-std-1.88.0-wasm32-wasip2.tar.xz';
const checksum='c1c97b3247cdc940a5b8616f0d84cccd79a355262c1f3c182649f05845283305';
const directory=resolve('.deps/research-build'),sysroot=resolve('.deps/research-sysroot'),archive=join(directory,'rust-std.tar.xz');
const rustRoot=(await run('rustup',['run',version,'rustc','--print','sysroot'])).stdout.trim();
await mkdir(directory,{recursive:true});let bytes;
try{bytes=await readFile(archive)}catch(e){if(e.code!=='ENOENT')throw e}
if(!bytes){const r=await fetch(url,{signal:AbortSignal.timeout(60000)});if(!r.ok)throw Error('Official Rust component unavailable');
  bytes=Buffer.from(await r.arrayBuffer());if(createHash('sha256').update(bytes).digest('hex')!==checksum)throw Error('Target checksum mismatch');await writeFile(archive,bytes)}
if(createHash('sha256').update(bytes).digest('hex')!==checksum)throw Error('Cached target checksum mismatch');
const target=join(directory,'rust-std-1.88.0-wasm32-wasip2/rust-std-wasm32-wasip2/lib/rustlib/wasm32-wasip2');
try{await access(target)}catch{await run('tar',['-xJf',archive,'-C',directory])}
await mkdir(join(sysroot,'lib/rustlib'),{recursive:true});
for(const name of await readdir(join(rustRoot,'lib/rustlib'))){
  const destination=join(sysroot,'lib/rustlib',name);try{await access(destination)}catch{await symlink(join(rustRoot,'lib/rustlib',name),destination)}
}
try{await access(join(sysroot,'lib/rustlib/wasm32-wasip2'))}catch{await symlink(target,join(sysroot,'lib/rustlib/wasm32-wasip2'))}
await writeFile(join(directory,'component.json'),JSON.stringify({version,url,sha256:checksum},null,2)+'\n');
console.log(JSON.stringify({toolchain:version,workspaceSysroot:sysroot,targetSha256:checksum}));
