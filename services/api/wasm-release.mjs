import {createHash} from 'node:crypto';
export function inspectWasm(bytes){
  if(bytes.length>1_048_576||bytes.subarray(0,8).toString('hex')!=='0061736d0d000100')throw Error('Expected a bounded WASI P2 component');
  const manifests=[];
  function walk(start,end){
    const cursor={offset:start+8};
    const uint=()=>{let value=0,shift=0;for(let i=0;i<5;i++){
      if(cursor.offset>=end)throw Error('Truncated WASM');const b=bytes[cursor.offset++];
      value|=(b&127)<<shift;if(!(b&128))return value>>>0;shift+=7}throw Error('Invalid WASM length')};
    while(cursor.offset<end){const id=bytes[cursor.offset++],length=uint(),next=cursor.offset+length;
      if(next>end)throw Error('Truncated section');
      if(id===0){const n=uint(),name=bytes.subarray(cursor.offset,cursor.offset+n).toString();cursor.offset+=n;
        if(cursor.offset>next)throw Error('Truncated custom section');
        if(name==='outlayer.manifest')manifests.push(bytes.subarray(cursor.offset,next).toString());
      }else if(bytes.subarray(cursor.offset,cursor.offset+4).toString('hex')==='0061736d')walk(cursor.offset,next);
      cursor.offset=next;
    }
  }
  walk(0,bytes.length);
  if(manifests.length!==1||manifests[0]!=='{"storage_account":"predecessor"}'||
    !bytes.includes(Buffer.from('near:storage/api@0.2.0')))throw Error('Runtime storage binding mismatch');
  return {sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,
    manifest:JSON.parse(manifests[0]),storageImport:'near:storage/api@0.2.0'};
}
export async function verifyRelease(release,fetchImpl=fetch){
  const response=await fetchImpl(release.url,{signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw Error('Release download failed');
  const bytes=Buffer.from(await response.arrayBuffer()),inspection=inspectWasm(bytes);
  if(inspection.sha256!==release.versionKey)throw Error('Downloaded release hash mismatch');
  return {id:release.id,...inspection,hostedStatus:release.hostedStatus,
    activationAllowed:release.hostedStatus==='verified'&&!!release.hostedEvidence?.scout&&
      !!release.hostedEvidence?.compare&&!!release.hostedEvidence?.recall};
}
