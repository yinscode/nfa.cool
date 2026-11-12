#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import {validateServicePackage,reviewedPackages} from '../services/api/service-package.mjs';
const packages=process.argv[2]?[validateServicePackage(JSON.parse(await readFile(process.argv[2],'utf8')))]:await reviewedPackages();
console.log(JSON.stringify(packages.map(p=>({id:p.id,version:p.version,stage:p.stage,schemaHash:p.inputSchemaHash})),null,2));
