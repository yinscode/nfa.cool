import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createScoutBrief} from './scout.mjs';

const valid=x=>/^sha256:[0-9a-f]{64}$/.test(x);
export class InputStore {
  constructor(directory){this.directory=directory}
  path(briefHash,sourceHash){if(!valid(briefHash)||!valid(sourceHash))throw Error('Invalid Scout input hashes');
    return join(this.directory,briefHash.slice(7)+'-'+sourceHash.slice(7)+'.json')}
  async put(input){
    const {briefHash,sourceHash}=createScoutBrief(input);
    await mkdir(this.directory,{recursive:true,mode:0o700});
    const path=this.path(briefHash,sourceHash);
    try{await writeFile(path,JSON.stringify(input)+'\n',{flag:'wx',mode:0o600})}
    catch(error){if(error.code!=='EEXIST')throw error;
      await this.get(briefHash,sourceHash)}
    return {briefHash,sourceHash};
  }
  async get(briefHash,sourceHash){
    const input=JSON.parse(await readFile(this.path(briefHash,sourceHash),'utf8'));
    const actual=createScoutBrief(input);
    if(actual.briefHash!==briefHash||actual.sourceHash!==sourceHash)throw Error('Scout input integrity mismatch');
    return input;
  }
}
