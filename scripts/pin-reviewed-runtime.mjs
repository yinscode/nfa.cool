#!/usr/bin/env node
import {readFile,writeFile,copyFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const artifact='releases/nfa-services-reviewed-578af9bf7adb3a8d.wasm';
const built='skills/scout-wasi/target/wasm32-wasip2/release/nfa-scout-wasi.wasm';
const builtCheck=JSON.parse(execFileSync(process.execPath,['scripts/check-wasi.mjs',built],{encoding:'utf8'}));
if(builtCheck.sha256!=='578af9bf7adb3a8d40b749ece673b8a8f25d777f7ed2c881a294628f4e3a7dfe')
  throw Error('Current guest build differs from the reviewed hash');
await copyFile(built,artifact);
const checked=JSON.parse(execFileSync(process.execPath,['scripts/check-wasi.mjs',artifact],{encoding:'utf8'}));
if(checked.sha256!=='578af9bf7adb3a8d40b749ece673b8a8f25d777f7ed2c881a294628f4e3a7dfe')throw Error('Reviewed guest hash changed');
const sources={};
for(const path of ['skills/scout-wasi/src/main.rs','skills/scout-wasi/src/research.rs','skills/scout-wasi/Cargo.toml',
  'skills/scout-wasi/Cargo.lock','skills/scout-wasi/wit/world.wit','skills/scout-wasi/wit/deps/storage.wit'])
  sources[path]=createHash('sha256').update(await readFile(path)).digest('hex');
const evidence={milestone:'M06',status:'rebuilt; hosted acceptance pending',artifact,bytes:checked.bytes,sha256:checked.sha256,
  componentVersion:checked.componentVersion,storageManifest:JSON.parse(checked.manifest),storageImport:checked.storageImport,
  rust:'1.88.0',target:'wasm32-wasip2',sources,nativeTests:7,
  checks:['finalized prior work only enters buyer context','caller bound to stable vault predecessor',
    'unknown inference attempts cannot be retried','staged outputs replay without another model call',
    'guest reports fault classification for customer and operator failures'],
  limits:['Native fake backends do not verify hosted WASI HTTP or TEE execution.',
    'Real model inference remains pending a dedicated near-ai credential and model ID.']};
await writeFile('docs/evidence/m06-reviewed-runtime.json',JSON.stringify(evidence,null,2)+'\n');
const path='releases/catalog.json',catalog=JSON.parse(await readFile(path,'utf8'));
const row={id:'scout-compare-research-4-reviewed',versionKey:checked.sha256,artifact,
  services:['scout','compare','research'],artifactCodec:'research-v1',hostedStatus:'candidate',
  reason:'Memory and failure handling fixes rebuilt and pinned; hosted model acceptance is pending.'};
if(!catalog.releases.some(r=>r.id===row.id))catalog.releases.push(row);
await writeFile(path,JSON.stringify(catalog,null,2)+'\n');
console.log(JSON.stringify({artifact,sha256:checked.sha256,hostedStatus:'candidate'}));
