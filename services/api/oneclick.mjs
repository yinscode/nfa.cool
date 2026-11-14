/** 1Click is mainnet only. Keep its credential server-side and its origin fixed. */
export class OneClickClient{
  constructor({jwt,fetchImpl=fetch,baseUrl='https://1click.chaindefuser.com'}){
    if(!/^https:\/\//.test(baseUrl))throw Error('HTTPS 1Click endpoint required');
    this.jwt=jwt;this.fetchImpl=fetchImpl;this.baseUrl=baseUrl;
  }
  async #request(path,body){
    const response=await this.fetchImpl(this.baseUrl+path,{method:body?'POST':'GET',
      headers:{'content-type':'application/json',...(this.jwt?{authorization:`Bearer ${this.jwt}`}:{})},
      ...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(10_000)});
    if(!response.ok)throw Error(`1Click request failed (${response.status})`);
    return response.json();
  }
  quote(body){return this.#request('/v0/quote',body)}
  status(depositAddress){return this.#request('/v0/status?depositAddress='+encodeURIComponent(depositAddress))}
}
