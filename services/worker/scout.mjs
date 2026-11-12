import {createHash} from 'node:crypto';

const stop = new Set(['about','after','again','also','and','are','for','from','have','into','more','that','the','their','there','this','what','when','where','which','with']);
const hash = value => 'sha256:' + createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const words = text => [...new Set((text.toLowerCase().match(/[a-z0-9]{3,}/g) || []).filter(w => !stop.has(w)))];

/** A deterministic, bounded extractive brief. Source text is data, never an instruction or tool call. */
export function createScoutBrief({question, sources}) {
  if (typeof question !== 'string' || question.trim().length < 5 || question.length > 240 ||
      !Array.isArray(sources) || sources.length < 1 || sources.length > 8) throw Error('Invalid Scout input');
  const query = words(question);
  const normalized = sources.map((source, index) => {
    if (!source || typeof source.title !== 'string' || !source.title.trim() || source.title.length > 120 ||
        typeof source.url !== 'string' || typeof source.text !== 'string' ||
        source.text.length < 20 || source.text.length > 50000) throw Error('Invalid source');
    const url = new URL(source.url);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw Error('Invalid source URL');
    return {id:index+1,title:source.title.trim(),url:url.href,text:source.text.trim()};
  });
  const candidates = normalized.flatMap(source => source.text.split(/(?<=[.!?])\s+/).map((raw, index) => {
    const claim = raw.replace(/\s+/g,' ').trim();
    const terms = words(claim);
    const overlap = query.filter(term => terms.includes(term)).length;
    return {claim,sourceId:source.id,index,score:overlap*10 + (/[0-9]/.test(claim)?2:0) + Math.min(terms.length,20)/20};
  }).filter(x => x.claim.length >= 30 && x.claim.length <= 500 && x.score >= 10));
  candidates.sort((a,b) => b.score-a.score || a.sourceId-b.sourceId || a.index-b.index);
  const counts = new Map(), findings = [];
  for (const x of candidates) {
    if (findings.length === 5) break;
    if ((counts.get(x.sourceId)||0) >= 2 || findings.some(y => y.claim === x.claim)) continue;
    counts.set(x.sourceId,(counts.get(x.sourceId)||0)+1);
    findings.push({claim:x.claim,sourceId:x.sourceId});
  }
  if (!findings.length) throw Error('No relevant supported findings');
  const sourceList = normalized.map(({id,title,url,text}) => ({id,title,url,contentHash:hash(text)}));
  const artifact = {schemaVersion:1,template:'scout@1.0.0',question:question.trim(),findings,sources:sourceList};
  const outputHash = hash(artifact);
  return {briefHash:hash(question.trim()),sourceHash:hash(sourceList),outputHash,
    outputUri:`nfa://work/${outputHash.slice(7)}`,artifact};
}
