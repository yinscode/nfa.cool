//! Research configuration and USD usage reservations live outside the deployed state layout.
use super::*;
#[near(serializers=[borsh,json])]
#[derive(Clone)]
pub struct SourceRule {pub host:String,pub path_prefix:String}
#[near(serializers=[borsh,json])]
#[derive(Clone)]
pub struct SecretsReference {pub account_id:AccountId,pub profile:String}
#[near(serializers=[borsh,json])]
#[derive(Clone)]
pub struct ResearchSettings {
    pub version_key:String,pub secrets_ref:SecretsReference,pub allowed_sources:Vec<SourceRule>,
    pub model:String,pub max_input_tokens:u32,pub max_output_tokens:u32,
    pub input_microusd_per_token:u64,pub output_microusd_per_token:u64,
    pub max_cost_microusd:u64,pub daily_budget_microusd:u64,
}
#[near(serializers=[borsh,json])]
#[derive(Clone)]
pub struct ResearchConfig {pub version:u64,pub configuration_hash:String,pub settings:ResearchSettings}
#[near(serializers=[borsh,json])]
#[derive(Clone)]
pub struct ResearchUsage {pub configuration_hash:String,pub configuration_version:u64,pub reserved_microusd:u64,
    pub priced_usage_microusd:Option<u64>,pub state:String,pub day:u64}
#[near(serializers=[borsh,json])]
#[derive(Clone,Default)]
pub struct DailyResearchBudget {pub day:u64,pub reserved_microusd:u64}
fn configs()->LookupMap<TokenId,ResearchConfig>{LookupMap::new(&b"research:config:v1"[..])}
fn usage()->LookupMap<String,ResearchUsage>{LookupMap::new(&b"research:usage:v1"[..])}
fn budgets()->LookupMap<TokenId,DailyResearchBudget>{LookupMap::new(&b"research:budget:v1"[..])}
fn finalized()->LookupMap<TokenId,Vec<(u64,String)>>{LookupMap::new(&b"research:finalized:v1"[..])}
fn capable()->LookupMap<TokenId,bool>{LookupMap::new(&b"research:vault-capable:v1"[..])}
pub(super) fn mark_capable(token_id:&TokenId){capable().insert(token_id,&true);}
fn reservation(s:&ResearchSettings)->u64{u64::from(s.max_input_tokens).checked_mul(s.input_microusd_per_token).unwrap()
    .checked_add(u64::from(s.max_output_tokens).checked_mul(s.output_microusd_per_token).unwrap()).unwrap()}
fn allowed_host(host:&str)->bool{matches!(host,"docs.near.org"|"app.outlayer.ai"|"near.org"|"docs.rs")}

#[near]
impl Registry {
    #[payable]
    pub fn verify_research_vault(&mut self,token_id:TokenId)->Promise{
        assert_one_yocto();let mut a=self.active_owner(&token_id);let id=a.next_op_id;a.next_op_id+=1;a.pending_op=Some(id);
        self.agents.insert(&token_id,&a);
        Promise::new(a.vault_id).function_call("status".to_string(),b"{}".to_vec(),NearToken::from_yoctonear(0),Gas::from_tgas(15))
            .then(Promise::new(env::current_account_id()).function_call("on_research_vault_verified".to_string(),
                serde_json::json!({"token_id":token_id,"id":id}).to_string().into_bytes(),NearToken::from_yoctonear(0),Gas::from_tgas(25)))
    }
    #[private]
    pub fn on_research_vault_verified(&mut self,token_id:TokenId,id:u64)->bool{
        let mut a=self.agents.get(&token_id).unwrap();require!(a.pending_op==Some(id),"Stale research verification");
        let valid=env::promise_result_checked(0,4096).ok().and_then(|b|serde_json::from_slice::<serde_json::Value>(&b).ok()).is_some_and(|s|
            s["controller"]==env::current_account_id().as_str()&&s["reporter"]==self.reporter.as_str()&&s["guardian"]==self.guardian.as_str()&&
            s["pending"].is_null()&&s["research_interface"]==1&&s["path"]=="eth-sepolia-v1"&&s["chain_id"]==11155111);
        // This operation only reads a view; a failed probe creates no external authority to drain.
        a.pending_op=None;self.agents.insert(&token_id,&a);capable().insert(&token_id,&valid);
        event("research_vault_verified",serde_json::json!({"token_id":token_id,"id":id,"compatible":valid}));valid
    }
    #[payable]
    pub fn configure_research(&mut self,token_id:TokenId,settings:ResearchSettings){
        assert_one_yocto();self.active_owner(&token_id);
        require!(self.research_vault_capable(token_id.clone()),"Research requires a verified compatible vault");
        let project=self.outlayer_project(token_id.clone()).unwrap();
        require!(project.state=="READY"&&project.version_key==settings.version_key,"Research runtime is not active");
        require!(!settings.secrets_ref.profile.is_empty()&&settings.secrets_ref.profile.len()<=32&&
            settings.secrets_ref.profile.bytes().all(|b|b.is_ascii_alphanumeric()||b"-_".contains(&b)),"Invalid secret profile");
        require!(!settings.allowed_sources.is_empty()&&settings.allowed_sources.len()<=3&&settings.allowed_sources.iter().all(|r|
            allowed_host(&r.host)&&r.path_prefix.starts_with('/')&&r.path_prefix.len()<=100&&
            !r.path_prefix.bytes().any(|b|b"?%#\\".contains(&b))&&!r.path_prefix.contains("..")),"Invalid research sources");
        require!(!settings.model.is_empty()&&settings.model.len()<=120&&settings.model.bytes().all(|b|b.is_ascii_alphanumeric()||b"-_/.:".contains(&b)),"Invalid model");
        require!(settings.max_input_tokens>0&&settings.max_input_tokens<=24_000&&settings.max_output_tokens>0&&settings.max_output_tokens<=512&&
            settings.input_microusd_per_token<=1000&&settings.output_microusd_per_token<=1000&&
            settings.max_cost_microusd>0&&settings.max_cost_microusd<=1_000_000&&
            settings.daily_budget_microusd>=settings.max_cost_microusd&&settings.daily_budget_microusd<=10_000_000,"Research budget cap");
        require!(reservation(&settings)>0&&reservation(&settings)<=settings.max_cost_microusd,"Research pricing exceeds cap");
        let configuration_hash=format!("sha256:{}",hex(&env::sha256(&serde_json::to_vec(&settings).unwrap())));
        let version=configs().get(&token_id).map(|c|c.version+1).unwrap_or(1);
        configs().insert(&token_id,&ResearchConfig{version,configuration_hash:configuration_hash.clone(),settings});
        event("research_configured",serde_json::json!({"token_id":token_id,"configuration_hash":configuration_hash,"version":version}));
    }
    pub fn research_config(&self,token_id:TokenId)->Option<ResearchConfig>{configs().get(&token_id)}
    pub fn research_usage(&self,token_id:TokenId,id:u64)->Option<ResearchUsage>{usage().get(&op_key(&token_id,id))}
    pub fn research_budget(&self,token_id:TokenId)->DailyResearchBudget{budgets().get(&token_id).unwrap_or_default()}
    pub fn research_vault_capable(&self,token_id:TokenId)->bool{capable().get(&token_id).unwrap_or(false)}
}
impl Registry {
    pub(super) fn reserve_research(&self,token_id:&TokenId,id:u64,version_key:&str){
        let c=configs().get(token_id).unwrap_or_else(||env::panic_str("Research is not configured"));
        require!(c.settings.version_key==version_key,"Research configuration/runtime mismatch");
        let day=env::block_timestamp()/86_400_000_000_000;
        let mut b=budgets().get(token_id).unwrap_or_default();if b.day!=day{b=DailyResearchBudget{day,reserved_microusd:0}}
        let amount=reservation(&c.settings);b.reserved_microusd=b.reserved_microusd.checked_add(amount).unwrap();
        require!(b.reserved_microusd<=c.settings.daily_budget_microusd,"Research daily allowance exhausted");
        require!(usage().get(&op_key(token_id,id)).is_none(),"Research already reserved");
        budgets().insert(token_id,&b);usage().insert(&op_key(token_id,id),&ResearchUsage{configuration_hash:c.configuration_hash,
            configuration_version:c.version,reserved_microusd:amount,priced_usage_microusd:None,state:"RESERVED".into(),day});
    }
    pub(super) fn research_execution(&self,token_id:&TokenId,id:u64,value:&serde_json::Value)->serde_json::Value{
        let a=self.agents.get(token_id).unwrap();let c=configs().get(token_id).unwrap();let u=usage().get(&op_key(token_id,id)).unwrap();
        require!(u.configuration_hash==c.configuration_hash&&u.configuration_version==c.version,"Research configuration changed");
        let object=value.as_object().unwrap();
        require!(object.len()==2&&object["question"].as_str().is_some_and(|q|q.trim().len()>=5&&q.len()<=240),"Typed research input only");
        let sources=object["sources"].as_array().unwrap();
        require!(!sources.is_empty()&&sources.len()<=3&&sources.iter().all(|s|s.as_object().is_some_and(|o|
            o.len()==2&&o.get("title").and_then(|t|t.as_str()).is_some_and(|t|!t.is_empty()&&t.len()<=120)&&
            o.get("url").and_then(|u|u.as_str()).is_some_and(|u|u.len()<=500&&!u.bytes().any(|b|b"@?%#\\".contains(&b))&&!u.contains("..")&&c.settings.allowed_sources.iter().any(|r|u.starts_with(&format!("https://{}{}",r.host,r.path_prefix)))))),"Typed research sources only");
        let prior:Vec<serde_json::Value>=finalized().get(token_id).unwrap_or_default().into_iter().rev().take(3)
            .map(|(job_id,output_hash)|serde_json::json!({"jobId":job_id,"outputHash":output_hash})).collect();
        serde_json::json!({"operation":"run","service":"research","jobId":id,"question":object["question"],"sources":sources,
            "research":c,"context":{"registryAccountId":env::current_account_id(),"tokenId":token_id,
                "vaultAccountId":a.vault_id,"ownerEpoch":a.epoch,"priorWork":prior}})
    }
    /// A released job has no definite inference outcome; its reservation stays consumed.
    pub(super) fn research_released(&self,token_id:&TokenId,id:u64){
        let Some(mut u)=usage().get(&op_key(token_id,id)) else{return};
        if u.state=="RESERVED"{u.state="UNKNOWN".into();usage().insert(&op_key(token_id,id),&u);}
    }
    pub(super) fn research_finalized(&self,token_id:&TokenId,id:u64,hash:&str){
        let mut rows=finalized().get(token_id).unwrap_or_default();rows.push((id,hash.into()));
        if rows.len()>3{rows.remove(0);}finalized().insert(token_id,&rows);
    }
    pub(super) fn research_result(&self,token_id:&TokenId,id:u64,output:&serde_json::Value){
        let Some(mut u)=usage().get(&op_key(token_id,id)) else{return};
        require!(u.state=="RESERVED","Research usage already settled");
        let cost=output.get("pricedUsageMicrousd").and_then(|v|v.as_u64());
        if let Some(cost)=cost{require!(cost<=u.reserved_microusd,"Inference usage exceeds reservation");u.priced_usage_microusd=Some(cost)}
        u.state=match output.get("inferenceOutcome").and_then(|v|v.as_str()){
            Some("not_started")=>"NOT_STARTED",Some("succeeded") if cost.is_some()=>"PRICED_USAGE",_=>"UNKNOWN"
        }.into();
        // Reservations stay consumed for the day, including failed/unknown attempts.
        usage().insert(&op_key(token_id,id),&u);
    }
}
