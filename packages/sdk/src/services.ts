import type {WalletAction} from './client.js';
export type ServiceId='scout'|'compare';
export type ServiceQuote={service:ServiceId;tokenId:string;inputData:string;inputHash:string;versionKey:string;policyVersion:number;
  feeYocto:string;replenishYocto:string;depositCapYocto:string;deadlineNs:number;unsignedAction:WalletAction};
export type ServiceRecord={service_id:ServiceId;policy_version:number;job:{status:string;requester:string;input_hash:string;version_key:string;fee:string;output_hash?:string}};

/** REST preparation and exact payment reconciliation. The caller owns signing and retry policy. */
export class NfaServicesClient{
  readonly baseUrl:string;private readonly fetchImpl:typeof fetch;
  constructor({baseUrl,fetchImpl=fetch}:{baseUrl:string;fetchImpl?:typeof fetch}){
    const url=new URL(baseUrl);
    if(url.username||url.password||url.search||url.hash||!['http:','https:'].includes(url.protocol))throw Error('Invalid NFA API URL');
    this.baseUrl=baseUrl.replace(/\/$/,'');this.fetchImpl=fetchImpl.bind(globalThis);
  }
  async request<T>(path:string,body?:unknown):Promise<T>{
    const response=await this.fetchImpl(this.baseUrl+path,{method:body===undefined?'GET':'POST',
      headers:body===undefined?{}:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
    const value=await response.json();if(!response.ok)throw Error(value.error||`NFA API HTTP ${response.status}`);return value as T;
  }
  private path(tokenId:string,service?:ServiceId){
    if(!/^nfa-[1-9][0-9]*$/.test(tokenId)||service&&!['scout','compare'].includes(service))throw Error('Invalid service identity');
    return `/v1/nfas/${tokenId}/services`+(service?'/'+service:'');
  }
  discover(tokenId:string){return this.request<{items:Array<{id:ServiceId;available:boolean;schemaHash:string;reason:string|null}>}>(this.path(tokenId))}
  quote(tokenId:string,service:ServiceId,input:unknown){return this.request<ServiceQuote>(this.path(tokenId,service)+'/quotes',{input})}
  job(tokenId:string,service:ServiceId,jobId:number){
    if(!Number.isSafeInteger(jobId)||jobId<1)throw Error('Invalid assigned job ID');
    return this.request<ServiceRecord>(this.path(tokenId,service)+`/jobs/${jobId}`);
  }
  prepareStart(tokenId:string,service:ServiceId,jobId:number,inputData:string){
    if(!Number.isSafeInteger(jobId)||jobId<1)throw Error('Invalid assigned job ID');
    return this.request<{unsignedAction:WalletAction}>(this.path(tokenId,service)+`/jobs/${jobId}/prepare-start`,{inputData});
  }
  async inspectPayment({quote,hash,sender}:{quote:ServiceQuote;hash:string;sender:string}){
    const receipt=await this.request<{status:string;assignedJobId:number|null}>('/studio/transactions/inspect',{tokenId:quote.tokenId,hash,sender});
    if(receipt.status!=='SUCCEEDED'||!Number.isSafeInteger(receipt.assignedJobId)||!receipt.assignedJobId)
      throw Error('Payment is not finalized with an assigned job ID; inspect before retrying');
    const record=await this.job(quote.tokenId,quote.service,receipt.assignedJobId),job=record.job;
    if(record.service_id!==quote.service||record.policy_version!==quote.policyVersion||job.requester!==sender||
      job.input_hash!==quote.inputHash||job.version_key!==quote.versionKey||job.fee!==quote.feeYocto)
      throw Error('Finalized payment differs from reviewed service quote');
    return {jobId:receipt.assignedJobId,record};
  }
}
