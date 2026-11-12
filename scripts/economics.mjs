#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';

const YOCTO=10n**24n;
const file=path=>readFile(resolve(path));
const numeric=(source,name)=>{
  const match=new RegExp(`const ${name}: u128 = ([0-9_]+);`).exec(source);
  if(!match)throw Error(`Missing ${name}`);return BigInt(match[1].replaceAll('_',''));
};
async function rpcPrice(url){
  const res=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
    jsonrpc:'2.0',id:'config',method:'EXPERIMENTAL_protocol_config',params:{finality:'final'}})});
  const json=await res.json();
  if(!res.ok||json.error||!json.result?.runtime_config?.storage_amount_per_byte)throw Error('Protocol storage price unavailable');
  return BigInt(json.result.runtime_config.storage_amount_per_byte);
}
const registry=String(await file('contracts/registry/src/lib.rs'));
const vault=String(await file('contracts/vault-v2/src/lib.rs'));
const [registryWasm,vaultWasm]=await Promise.all([
  file('contracts/registry/target/wasm32-unknown-unknown/release/nfa_registry_opt.wasm'),
  file('contracts/vault-v2/target/wasm32-unknown-unknown/release/nfa_vault.wasm')]);
const provision=numeric(registry,'MIN_PROVISION'),registryStorage=numeric(registry,'REGISTRY_STORAGE');
const reserve=numeric(vault,'NEAR_RESERVE');
const jobCap=numeric(vault,'MAX_JOB_DEPOSIT');
const cost=process.argv[2]?await rpcPrice(process.argv[2]):10n**19n;
const vaultFunded=provision-registryStorage;
const availableLowerBound=vaultFunded-BigInt(vaultWasm.length)*cost-reserve;
const summary={pricing:process.argv[2]?'queried final protocol configuration':'illustrative 10^19 yoctoNEAR/byte; verify with sandbox/testnet',
  storageYoctoPerByte:cost.toString(),registryWasmBytes:registryWasm.length,
  vaultWasmBytes:vaultWasm.length,minimumProvisionYocto:provision.toString(),
  registryAllowanceYocto:registryStorage.toString(),vaultFundedYocto:vaultFunded.toString(),
  vaultCodeStorageFloorYocto:(BigInt(vaultWasm.length)*cost).toString(),
  vaultGasReserveYocto:reserve.toString(),
  marginAfterCodeAndGasFloorYocto:availableLowerBound.toString(),
  marginAfterCodeAndGasFloorNear:Number(availableLowerBound)/Number(YOCTO),
  marginAfterMaxJobDepositYocto:(availableLowerBound-jobCap).toString(),
  guardianUpgradeLimitBytes:512000,
  guardianUpgradeFits:vaultWasm.length<=512000,
  registryAllowanceBytesAtPrice:(registryStorage/cost).toString(),
  note:'Code bytes are a floor. Account state, code metadata, runtime storage, gas and receipt fees require sandbox/testnet measurements.'};
if(availableLowerBound<=jobCap||vaultWasm.length>512000)process.exitCode=1;
console.log(JSON.stringify(summary,null,2));
