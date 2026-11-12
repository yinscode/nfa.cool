import {readFile} from 'node:fs/promises';
export async function researchConfiguration({sdk,tokenId,project,allowCandidate=false}){
  const [capable,config]=await Promise.all([
    sdk.view(sdk.registryAccountId,'research_vault_capable',{token_id:tokenId}),sdk.getResearchConfig(tokenId)]);
  if(!capable||!config||config.settings?.version_key!==project.version_key)throw Error('Compatible research vault and runtime configuration required');
  const catalog=JSON.parse(await readFile(new URL('../../releases/catalog.json',import.meta.url),'utf8'));
  const verified=catalog.releases.some(r=>r.versionKey===project.version_key&&r.services.includes('research')&&
    r.hostedStatus==='verified'&&r.hostedEvidence?.research);
  if(!verified&&!allowCandidate)throw Error('Research runtime has not passed hosted acceptance');
  return config;
}
