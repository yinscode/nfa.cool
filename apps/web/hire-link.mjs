// Links a chat agent (Claude, Codex, ChatGPT, Grok…) can hand to a person. Nothing here signs:
// each link only fills a form in NFA.cool, and the person reviews it and signs in their own wallet.
//
//   Hire link:     /nfa/nfa-2?service=scout&input=<URL-encoded JSON>
//   Budget link:   /studio?token=nfa-1&grant=<agent account>&method=NFA_HIRE&recipient=nfa-2&budgetNear=0.1&hours=24
export const HIRE_SERVICES=['scout','compare'];
export const MAX_INPUT_BYTES=7_800;
const YOCTO=10n**24n;

export function parseHireLink(search){
  const params=new URLSearchParams(search);
  if(!params.has('service')&&!params.has('input'))return null;
  const service=params.get('service')||'scout';
  if(!HIRE_SERVICES.includes(service))throw Error(`Unknown service "${service}". Use scout or compare.`);
  const raw=params.get('input');
  if(!raw)return {service,input:null};
  if(new TextEncoder().encode(raw).length>MAX_INPUT_BYTES)throw Error('The drafted input is too large for one job.');
  let input;try{input=JSON.parse(raw)}catch{throw Error('The drafted input is not valid JSON. Ask your agent for a fresh link.')}
  if(!input||typeof input!=='object'||Array.isArray(input)||typeof input.question!=='string'||!Array.isArray(input.sources))
    throw Error('The drafted input needs a question and a sources list.');
  return {service,input};
}

export function hireLink(origin,tokenId,service,input){
  return `${origin}/nfa/${encodeURIComponent(tokenId)}?service=${encodeURIComponent(service)}&input=${encodeURIComponent(JSON.stringify(input))}`;
}

// NEAR amount as typed by a person or an agent ("0.1") to yoctoNEAR, without floating point.
export function nearToYocto(value){
  const text=String(value).trim();
  if(!/^(0|[1-9][0-9]*)(\.[0-9]{1,24})?$/.test(text))throw Error('Budget must be a NEAR amount such as 0.1');
  const [whole,frac='']=text.split('.');
  const yocto=BigInt(whole)*YOCTO+BigInt(frac.padEnd(24,'0'));
  if(yocto<=0n)throw Error('Budget must be more than zero');
  return yocto.toString();
}

export function parseBudgetLink(search){
  const params=new URLSearchParams(search);
  const delegate=params.get('grant');
  if(!delegate)return null;
  if(!/^(([a-z0-9]+[-_])*[a-z0-9]+\.)*([a-z0-9]+[-_])*[a-z0-9]+$/.test(delegate)||delegate.length<2||delegate.length>64)
    throw Error('The agent account in this link is not a valid NEAR account ID.');
  const method=params.get('method')||'NFA_HIRE';
  if(method!=='NFA_HIRE')throw Error('Agent budget links only grant NFA hiring.');
  const recipient=params.get('recipient');
  if(!/^nfa-[1-9][0-9]*$/.test(recipient||''))throw Error('Name the one NFA your agent may hire, for example recipient=nfa-2.');
  const hours=Number(params.get('hours')||24);
  if(!Number.isInteger(hours)||hours<1||hours>168)throw Error('Agent budgets last 1 to 168 hours.');
  return {delegate,method,recipient,budget:nearToYocto(params.get('budgetNear')||'0.1'),hours};
}
