import {createHash} from 'node:crypto';

const stop=new Set(['about','after','again','also','and','are','for','from','have','into','more','that','the','their','there','this','what','when','where','which','with']);
const words=text=>[...new Set((text.toLowerCase().match(/[a-z0-9]+/g)||[]).filter(w=>w.length>=3&&!stop.has(w)))];
const sha=text=>'sha256:'+createHash('sha256').update(text).digest('hex');
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'
  ?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)])):value;

/** Evidence-coverage comparison of supplied options; URLs are labels, never fetched. */
export function createCompareBrief({question,criteria,sources}){
  if(typeof question!=='string'||question.trim().length<5||question.length>240||
    !Array.isArray(criteria)||criteria.length<1||criteria.length>5||
    !Array.isArray(sources)||sources.length<2||sources.length>8)throw Error('Invalid Compare input');
  if(criteria.some(c=>typeof c!=='string'||c.trim().length<3||c.length>60||words(c).length===0)||
    new Set(criteria).size!==criteria.length)throw Error('Invalid criteria');
  const ranking=sources.map((source,index)=>{
    if(!source||typeof source.title!=='string'||!source.title.trim()||source.title.length>120||
      typeof source.url!=='string'||typeof source.text!=='string'||source.text.length<20||source.text.length>5000)
      throw Error('Invalid source');
    const url=new URL(source.url);
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw Error('Invalid source URL');
    const sentences=source.text.trim().split(/(?<=[.!?])\s+/).map(s=>s.replace(/\s+/g,' ').trim());
    const evidence=criteria.flatMap(criterion=>{
      const terms=words(criterion),claim=sentences.find(s=>s.length>=30&&s.length<=500&&terms.some(t=>words(s).includes(t)));
      return claim?[{criterion,claim}]:[];
    });
    return {sourceId:index+1,title:source.title.trim(),url:url.href,
      contentHash:sha(source.text.trim()),matchedCriteria:evidence.length,evidence};
  }).sort((a,b)=>b.matchedCriteria-a.matchedCriteria||a.sourceId-b.sourceId);
  if(ranking.every(row=>row.matchedCriteria===0))throw Error('No relevant supported comparison');
  const artifact={schemaVersion:1,template:'compare@1.0.0',question:question.trim(),criteria,ranking};
  const outputHash=sha(JSON.stringify(canonical(artifact)));
  return {artifact,outputHash,outputUri:`nfa://work/${outputHash.slice(7)}`};
}
