use super::*;

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct TransactionPolicy {
    pub epoch:u64, pub near_enabled:bool, pub evm_enabled:bool,
    pub near_recipients:Vec<AccountId>, pub evm_recipients:Vec<String>,
    pub max_near:U128, pub max_evm:U128, pub max_fee:u64,
}
fn policies()->LookupMap<TokenId,TransactionPolicy>{LookupMap::new(&b"studio:policy:v1"[..])}
fn grant_index()->LookupMap<TokenId,Vec<(AccountId,String)>>{LookupMap::new(&b"studio:grants:v1"[..])}
fn audits()->LookupMap<String,String>{LookupMap::new(&b"studio:audit:v1"[..])}
fn audit_count()->LookupMap<TokenId,u64>{LookupMap::new(&b"studio:audit-count:v1"[..])}
#[near(serializers=[borsh,json])]
#[derive(Clone)]
pub struct ServiceResume{pub id:u64,pub failed_job_id:u64}
fn resumes()->LookupMap<TokenId,ServiceResume>{LookupMap::new(&b"studio:resume:v1"[..])}

pub(super) fn audit(name:&str,data:&serde_json::Value){
    let Some(token)=data.get("token_id").and_then(|v|v.as_str()) else{return};
    let token=token.to_string();let id=audit_count().get(&token).unwrap_or(0)+1;
    audits().insert(&op_key(&token,id),&serde_json::json!({"id":id,"event":name,"data":data,
        "block_height":env::block_height(),"timestamp_ns":env::block_timestamp().to_string(),
        "caller":env::predecessor_account_id()}).to_string());
    audit_count().insert(&token,&id);
}
pub(super) fn index_grant(token:&TokenId,delegate:&AccountId,method:&str){
    let mut rows=grant_index().get(token).unwrap_or_default();
    if !rows.iter().any(|(d,m)|d==delegate&&m==method){
        require!(rows.len()<128,"Grant index full");rows.push((delegate.clone(),method.into()));
        grant_index().insert(token,&rows);
    }
}

#[near]
impl Registry{
    pub fn service_resume(&self,token_id:TokenId)->Option<ServiceResume>{resumes().get(&token_id)}
    #[payable]
    pub fn resume_failed_service(&mut self,token_id:TokenId,failed_job_id:u64)->Promise{
        assert_one_yocto();let mut a=self.agents.get(&token_id).unwrap();
        require!(self.owner(&token_id)==env::predecessor_account_id(),"Owner only");
        let job=self.paid_scout_job(token_id.clone(),failed_job_id).unwrap();
        require!(a.lifecycle==Lifecycle::Draining&&job.status=="FAILED","No definite failed service");
        let request=if let Some(request)=resumes().get(&token_id){
            require!(request.failed_job_id==failed_job_id&&a.pending_op==Some(request.id),"Wrong resume request");request
        }else{
            require!(a.pending_op.is_none()&&a.next_op_id==failed_job_id+1,"Operation unresolved");
            let request=ServiceResume{id:a.next_op_id,failed_job_id};a.next_op_id+=1;a.pending_op=Some(request.id);
            self.agents.insert(&token_id,&a);resumes().insert(&token_id,&request);request
        };
        Promise::new(a.vault_id).function_call("status".to_string(),b"{}".to_vec(),NearToken::from_yoctonear(0),Gas::from_tgas(15))
            .then(Promise::new(env::current_account_id()).function_call("on_service_resume".to_string(),
                serde_json::json!({"token_id":token_id,"id":request.id}).to_string().into_bytes(),NearToken::from_yoctonear(0),Gas::from_tgas(30)))
    }
    #[private]
    pub fn on_service_resume(&mut self,token_id:TokenId,id:u64)->bool{
        let mut a=self.agents.get(&token_id).unwrap();let request=resumes().get(&token_id).unwrap();
        require!(a.pending_op==Some(id)&&request.id==id&&a.lifecycle==Lifecycle::Draining,"Stale resume callback");
        let Ok(bytes)=env::promise_result_checked(0,4096) else{return false};
        let Ok(status)=serde_json::from_slice::<serde_json::Value>(&bytes) else{return false};
        if status["controller"]!=env::current_account_id().as_str()||!status["pending"].is_null()
            ||status["next_operation_id"].as_u64().unwrap_or(0)<=request.failed_job_id{return false}
        require!(self.paid_scout_job(token_id.clone(),request.failed_job_id).unwrap().status=="FAILED","Failed job changed");
        a.pending_op=None;a.lifecycle=Lifecycle::Active;self.agents.insert(&token_id,&a);resumes().remove(&token_id);
        event("service_failure_recovered",serde_json::json!({"token_id":token_id,"id":id,"failed_job_id":request.failed_job_id}));true
    }
    #[payable]
    pub fn configure_transaction_policy(&mut self,token_id:TokenId,near_enabled:bool,evm_enabled:bool,
        near_recipients:Vec<AccountId>,evm_recipients:Vec<String>,max_near:U128,max_evm:U128,max_fee:u64){
        assert_one_yocto();let a=self.active_owner(&token_id);
        require!(near_recipients.len()<=20&&evm_recipients.len()<=20&&
            (!near_enabled||(!near_recipients.is_empty()&&max_near.0>0))&&
            (!evm_enabled||(!evm_recipients.is_empty()&&max_evm.0>0&&max_evm.0<=1_000_000_000_000_000_000))&&
            max_fee>0&&max_fee<=100_000_000_000,"Invalid transaction policy");
        require!(evm_recipients.iter().all(|s|s.len()==42&&s.starts_with("0x")&&
            s[2..].bytes().all(|b|b.is_ascii_hexdigit())),"Invalid EVM allowlist");
        let policy=TransactionPolicy{epoch:a.epoch,near_enabled,evm_enabled,near_recipients,
            evm_recipients:evm_recipients.iter().map(|s|s.to_ascii_lowercase()).collect(),max_near,max_evm,max_fee};
        policies().insert(&token_id,&policy);
        event("transaction_policy_updated",serde_json::json!({"token_id":token_id,"epoch":a.epoch,"policy":policy}));
    }
    pub fn transaction_policy(&self,token_id:TokenId)->Option<TransactionPolicy>{
        let a=self.agents.get(&token_id)?;policies().get(&token_id).filter(|p|p.epoch==a.epoch)
    }
    pub fn studio_grants(&self,token_id:TokenId)->Vec<Grant>{
        let Some(a)=self.agents.get(&token_id) else{return vec![]};
        grant_index().get(&token_id).unwrap_or_default().iter()
            .filter_map(|(d,m)|grants().get(&grant_key(&token_id,d,m)))
            .filter(|g|g.epoch==a.epoch&&g.expires_at_ns>env::block_timestamp()&&g.remaining.0>0).collect()
    }
    pub fn studio_page(&self,token_id:TokenId,from:u64,limit:u64)->serde_json::Value{
        require!(from>=1&&limit>0&&limit<=50,"Invalid page");
        let a=self.agents.get(&token_id).unwrap_or_else(||env::panic_str("No NFA"));
        let end=from.saturating_add(limit).min(a.next_op_id);
        let rows:Vec<_>=(from..end).map(|id|serde_json::json!({"id":id,
            "operation":self.operation(token_id.clone(),id),
            "service":self.service_job(token_id.clone(),id),
            "legacy_job":self.scout_job(token_id.clone(),id),
            "recall":super::outlayer::recall_view(&token_id,id),
            "evm":self.evm_operation(token_id.clone(),id)})).collect();
        serde_json::json!({"rows":rows,"next":if end<a.next_op_id{Some(end)}else{None},
            "next_operation_id":a.next_op_id})
    }
    pub fn studio_audit(&self,token_id:TokenId,from:u64,limit:u64)->serde_json::Value{
        require!(from>=1&&limit>0&&limit<=50,"Invalid page");
        let count=audit_count().get(&token_id).unwrap_or(0);
        let end=from.saturating_add(limit).min(count+1);
        let rows:Vec<serde_json::Value>=(from..end).filter_map(|id|audits().get(&op_key(&token_id,id)))
            .map(|v|serde_json::from_str(&v).unwrap()).collect();
        serde_json::json!({"rows":rows,"next":if end<=count{Some(end)}else{None},"count":count})
    }
}
