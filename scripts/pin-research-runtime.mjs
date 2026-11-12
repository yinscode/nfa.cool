#!/usr/bin/env node
import {readFile,writeFile,copyFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const wasm='skills/scout-wasi/target/wasm32-wasip2/release/nfa-scout-wasi.wasm';
const checked=JSON.parse(execFileSync(process.execPath,['scripts/check-wasi.mjs',wasm],{encoding:'utf8'}));
const sources={};
for(const path of ['skills/scout-wasi/src/main.rs','skills/scout-wasi/src/research.rs','skills/scout-wasi/Cargo.toml',
  'skills/scout-wasi/Cargo.lock','scripts/build-outlayer-wasi.sh','scripts/prepare-wasi-toolchain.mjs'])
  sources[path]=createHash('sha256').update(await readFile(path)).digest('hex');
const artifact=`releases/nfa-services-research-${checked.sha256.slice(0,16)}.wasm`;
await copyFile(wasm,artifact);
const evidence={milestone:'M04',status:'built; hosted acceptance pending',artifact,bytes:checked.bytes,sha256:checked.sha256,
  componentVersion:checked.componentVersion,storageManifest:JSON.parse(checked.manifest),storageImport:checked.storageImport,
  rust:'1.88.0',target:'wasm32-wasip2',sources,nativeTests:6,
  checks:['legacy Scout/Compare handlers retained','approved HTTPS source retrieval','bounded inference endpoint and token budget',
    'runtime-bound configuration hash','stable vault predecessor identity','durable inference attempt prevents duplicate model calls'],
  limits:['Native fake backends do not verify hosted WASI HTTP or TEE execution.',
    'Configured model token prices are usage estimates, not provider invoices.',
    'Owner recall returns a summary; the full research artifact remains in encrypted predecessor storage.']};
await writeFile('docs/evidence/m04-runtime.json',JSON.stringify(evidence,null,2)+'\n');
const path='releases/catalog.json',catalog=JSON.parse(await readFile(path,'utf8'));
const row={id:'scout-compare-research-3',versionKey:checked.sha256,artifact,services:['scout','compare','research'],
  artifactCodec:'research-v1',hostedStatus:'candidate',reason:'Real paid inference and buyer continuity acceptance are required before advertising Research.'};
const index=catalog.releases.findIndex(r=>r.id===row.id);
if(index<0)catalog.releases.push(row);else if(catalog.releases[index].hostedStatus!=='verified')catalog.releases[index]=row;
await writeFile(path,JSON.stringify(catalog,null,2)+'\n');
console.log(JSON.stringify({artifact,sha256:checked.sha256,hostedStatus:'candidate'}));
