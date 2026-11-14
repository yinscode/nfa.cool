// Public, read-only summary of an NFA for listings (landing page, agents): who it is, what it
// has done, and how to get its services. Built from studioNfa() and the published manifest.
const IMAGE_HOSTS=['test.fastfs.io','main.fastfs.io'];

function imagePath(hash,uri){
  if(!/^sha256:[0-9a-f]{64}$/.test(hash||'')||typeof uri!=='string')return null;
  try{const url=new URL(uri);if(url.protocol!=='https:'||!IMAGE_HOSTS.includes(url.hostname))return null}catch{return null}
  return `/studio/images/${hash.slice(7)}?uri=${encodeURIComponent(uri)}`;
}
const median=values=>{if(!values.length)return null;const s=[...values].sort((a,b)=>a<b?-1:a>b?1:0);return s[Math.floor((s.length-1)/2)].toString()};

export function nfaSummary(snapshot,manifest=null){
  const {identity,economics,availability=[],jobs=[],chainKey,agent}=snapshot;
  const id=identity.tokenId,number=Number(id.slice(4));
  const character=manifest?.publicCharacter||{};
  const finalized=jobs.map(row=>row.service).filter(s=>s?.job?.status==='FINALIZED');
  const services=availability.map(item=>{
    const fees=finalized.filter(s=>s.service_id===item.id).map(s=>BigInt(s.job.fee));
    const counts=economics?.byService?.[item.id]||{};
    return {id:item.id,name:item.name,description:item.description,available:!!item.available,reason:item.reason||null,
      inputSchema:item.inputSchema||null,marginYocto:item.quotePolicy?.marginYocto||null,maxDepositYocto:item.quotePolicy?.maxDepositYocto||null,
      typicalFeeYocto:median(fees),finalizedJobs:counts.finalized||0,
      quote:`/v1/nfas/${id}/services/${item.id}/quotes`};
  });
  return {
    tokenId:id,name:typeof manifest?.displayName==='string'&&manifest.displayName.trim()?manifest.displayName.trim():`NFA #${number}`,
    image:imagePath(character.cutoutHash,character.cutoutUri)||imagePath(character.imageHash,character.imageUri),
    owner:identity.ownerAccountId,ownerEpoch:identity.ownerEpoch,lifecycle:identity.lifecycle,
    listing:identity.listing||(agent?.listing_price?{price:agent.listing_price}:null),
    vault:identity.vaultAccountId,ethereumAddress:identity.foreignWallet?.address||chainKey?.address||null,
    trackRecord:{finalizedJobs:economics?.jobs?.finalized||0,failedJobs:economics?.jobs?.failed||0,
      hiredByNfas:finalized.filter(s=>s.hired_by).length,hiredBy:[...new Set(finalized.map(s=>s.hired_by).filter(Boolean))],creditedEarningsYocto:economics?.creditedServiceEarnings||'0',
      withdrawableIncomeYocto:economics?.withdrawableIncome||identity.income||'0'},
    services,
    links:{profile:`/nfa/${id}`,services:`/v1/nfas/${id}/services`,economics:`/v1/nfas/${id}/economics`},
  };
}

// Across a listing, count the paid hires each NFA made of the others.
export function withHiresMade(items){
  return items.map(item=>({...item,trackRecord:{...item.trackRecord,
    hired:items.filter(other=>other.trackRecord.hiredBy.includes(item.tokenId)).map(other=>other.tokenId)}}));
}
