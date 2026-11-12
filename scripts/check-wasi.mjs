#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';

const file=resolve(process.argv[2]||'skills/scout-wasi/target/wasm32-wasip2/release/nfa-scout-wasi.wasm');
const bytes=await readFile(file);
const readU32=cursor=>{
  let result=0,shift=0;
  for(let n=0;n<5;n++){
    if(cursor.offset>=bytes.length)throw Error('Truncated WASM');
    const b=bytes[cursor.offset++];result|=(b&0x7f)<<shift;
    if(!(b&0x80))return result>>>0;
    shift+=7;
  }
  throw Error('Invalid LEB128');
};
if(bytes.subarray(0,4).toString('hex')!=='0061736d')throw Error('Not a WASM binary');
const sections=[];
function walk(start,end){
  if(bytes.subarray(start,start+4).toString('hex')!=='0061736d')return;
  const cursor={offset:start+8};
  while(cursor.offset<end){
    const section=bytes[cursor.offset++],length=readU32(cursor),sectionEnd=cursor.offset+length;
    if(sectionEnd>end)throw Error('Truncated WASM section');
    if(section===0){
      const nameLength=readU32(cursor),name=bytes.subarray(cursor.offset,cursor.offset+nameLength).toString();
      cursor.offset+=nameLength;
      sections.push({name,content:bytes.subarray(cursor.offset,sectionEnd).toString()});
    }else if(bytes.subarray(cursor.offset,cursor.offset+4).toString('hex')==='0061736d'){
      walk(cursor.offset,sectionEnd);
    }
    cursor.offset=sectionEnd;
  }
}
walk(0,bytes.length);
const manifests=sections.filter(section=>section.name==='outlayer.manifest');
if(manifests.length!==1||manifests[0].content!=='{"storage_account":"predecessor"}')
  throw Error('Expected one predecessor-bound OutLayer manifest: '+JSON.stringify(
    manifests.map(section=>({length:section.content.length,preview:section.content.slice(0,90)}))));
if(!bytes.includes(Buffer.from('near:storage/api@0.2.0')))
  throw Error('WASI P2 storage import missing');
const sha256=createHash('sha256').update(bytes).digest('hex');
console.log(JSON.stringify({file,bytes:bytes.length,sha256,manifest:manifests[0].content,
  storageImport:'near:storage/api@0.2.0',componentVersion:bytes.subarray(4,8).toString('hex')},null,2));
