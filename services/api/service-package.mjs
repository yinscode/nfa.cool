import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const sha=x=>'sha256:'+createHash('sha256').update(JSON.stringify(x)).digest('hex');

export function validateServicePackage(pkg){
  if(pkg?.schemaVersion!==1||!['scout','compare','research'].includes(pkg.id)||!/^\d+\.\d+\.\d+$/.test(pkg.version)||
    !['outlayer-wasip2','node-reference'].includes(pkg.runtime)||!['hosted-testnet-verified','candidate'].includes(pkg.stage))throw Error('Invalid reviewed service package identity');
  if(pkg.inputSchemaHash!==sha(pkg.inputSchema)||pkg.inputSchema?.additionalProperties!==false||pkg.inputSchema.type!=='object'||!pkg.outputSchema)throw Error('Service schema commitment mismatch');
  if(pkg.permissions?.treasury!==false||pkg.permissions?.projectManagement!==false||!Array.isArray(pkg.permissions.network)||
    !Array.isArray(pkg.tools)||pkg.tools.some(t=>!['supplied-text-only','allowlisted-fetch','bounded-inference'].includes(t)))
    throw Error('Unreviewed service permissions');
  if(pkg.memory?.identity!=='vault-predecessor'||pkg.memory?.transfer!=='finalized-agent-owned-work')throw Error('Transfer-safe memory policy required');
  const l=pkg.limits;
  if(!Number.isSafeInteger(l?.max_instructions)||l.max_instructions<1||l.max_instructions>2000000000||
    !Number.isSafeInteger(l.max_memory_mb)||l.max_memory_mb<1||l.max_memory_mb>128||
    !Number.isSafeInteger(l.max_execution_seconds)||l.max_execution_seconds<1||l.max_execution_seconds>30)throw Error('Service resource caps exceeded');
  if(pkg.stage==='hosted-testnet-verified'&&pkg.runtime!=='outlayer-wasip2')throw Error('Reference runner is not a hosted release');
  return pkg;
}
export async function reviewedPackages(){
  return Promise.all(['scout','compare','research'].map(async id=>validateServicePackage(JSON.parse(await readFile(new URL(`../../service-packages/${id}.json`,import.meta.url),'utf8')))));
}
