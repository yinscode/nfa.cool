import {createHash} from 'node:crypto';
export async function publishedBytes(uri){
  const url=new URL(uri);
  if(url.protocol!=='https:'||!['test.fastfs.io','main.fastfs.io'].includes(url.hostname)||url.port||url.username||url.password)
    throw Error('Unsupported published artifact host');
  const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(15000)});
  if(!response.ok||Number(response.headers.get('content-length')||0)>1_048_576)throw Error('Published artifact unavailable');
  const bytes=Buffer.from(await response.arrayBuffer());if(bytes.length>1_048_576)throw Error('Published artifact too large');return bytes;
}
export async function publishedManifest({hash,uri,manifests}){
  if(!/^sha256:[0-9a-f]{64}$/.test(hash))throw Error('Invalid manifest hash');
  let value;
  if(uri.startsWith('nfa://manifest/'))value=await manifests.get(hash);
  else{value=JSON.parse((await publishedBytes(uri)).toString());
    const digest='sha256:'+createHash('sha256').update(JSON.stringify(value)).digest('hex');
    if(digest!==hash)throw Error('Published manifest checksum mismatch');
  }
  return value;
}
