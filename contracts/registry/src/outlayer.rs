//! Optional hosted Scout lane. Separate storage keys keep the deployed registry Borsh layout.
use super::*;

const MAX_PROJECT_DEPOSIT: u128 = 500_000_000_000_000_000_000_000;
const MAX_JOB_DEPOSIT: u128 = 500_000_000_000_000_000_000_000;
const MIN_MARGIN: u128 = 10_000_000_000_000_000_000_000;
/// Below any measured OutLayer charge (~0.0012 NEAR); quotes add the live estimate on top.
const MIN_JOB_DEPOSIT: u128 = 1_000_000_000_000_000_000_000;
/// After this delay a started job whose vault callback has returned can be released.
/// It exceeds the OutLayer execution cap plus its yield window, so a result already
/// on its way to the registry is not pre-empted.
const RELEASE_DELAY_NS: u64 = 900_000_000_000;
const ASYNC_COMPUTE_CAP_MICROUSD:u64=30_000;

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct OutlayerProject {
    pub project_id: String, pub project_uuid: String, pub version_key: String,
    pub candidate_version: Option<String>, pub state: String, pub action: String,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct SkillLimits { pub max_instructions: u64, pub max_memory_mb: u32, pub max_execution_seconds: u64 }

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct ServicePolicy {
    pub service_id:String, pub version:u64, pub schema_hash:String, pub enabled:bool,
    pub min_margin:U128, pub max_deposit:U128, pub limits:SkillLimits,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct JobService { pub service_id:String, pub policy_version:u64 }

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct PaidJob {
    pub id: u64, pub epoch: u64, pub requester: AccountId, pub input_hash: String,
    pub fee: U128, pub replenish: U128, pub deposit_cap: U128,
    pub version_key: String, pub limits: SkillLimits, pub deadline_ns: u64,
    pub created_at_ns:u64, pub started_at_ns:Option<u64>,
    pub status: String, pub output_hash: Option<String>, pub output_uri: Option<String>,
    pub reimbursement_pending: bool,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Default)]
pub struct PaidLedger {
    pub customer_escrow: U128, pub vault_replenishment_pending: U128,
    pub gross_finalized_receipts: U128, pub customer_refunds: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct RecallRequest { pub id:u64, pub job_id:u64, pub owner:AccountId,
    pub deposit:U128, pub output_hash:String, pub summary:Option<String>,
    pub state:String, pub reimbursement_pending:bool }

#[near(serializers=[borsh,json])]
#[derive(Clone)]
pub struct AsyncResearchJob {
    pub execution_hash:String,pub call_id:Option<String>,pub state:String,
    pub compute_cost_microusd:Option<u64>,pub max_compute_microusd:u64,
}

fn projects() -> LookupMap<TokenId, OutlayerProject> { LookupMap::new(&b"OLP"[..]) }
fn paid_jobs() -> LookupMap<String, PaidJob> { LookupMap::new(&b"OLJ"[..]) }
fn ledgers() -> LookupMap<u8, PaidLedger> { LookupMap::new(&b"OLL"[..]) }
fn recalls() -> LookupMap<String, RecallRequest> { LookupMap::new(&b"OLR"[..]) }
fn async_research_jobs()->LookupMap<String,AsyncResearchJob>{LookupMap::new(&b"OLAJ:v1"[..])}
fn recall_started()->LookupMap<String,u64>{LookupMap::new(&b"OLRT"[..])}
const PAYMENT_KEY_APPROVAL_NS:u64=86_400_000_000_000;
#[near(serializers=[borsh,json])]
#[derive(Clone)]
pub struct PaymentKeySetup {
    pub epoch:u64, pub nonce:u32, pub ciphertext_hash:String,
    pub expires_at_ns:u64, pub operation_id:Option<u64>, pub state:String,
}
fn payment_key_setups()->LookupMap<TokenId,PaymentKeySetup>{LookupMap::new(&b"OLPK:v1"[..])}
fn recall_releasable(a:&Agent,r:&RecallRequest,started:Option<u64>,id:u64)->bool{
    a.pending_op==Some(id) && (r.state=="UNCERTAIN" || (r.state=="EXECUTING"
        && started.is_some_and(|t|env::block_timestamp()>=t.saturating_add(RELEASE_DELAY_NS))))
}
pub(super) fn recall_view(token_id:&str,id:u64)->Option<RecallRequest>{recalls().get(&op_key(token_id,id))}
fn service_policies()->LookupMap<String,ServicePolicy>{LookupMap::new(&b"OLSP"[..])}
/// Jobs that failed because of their input; settled like a completed job's compute.
fn customer_failures()->LookupMap<String,bool>{LookupMap::new(&b"OLCF"[..])}
/// Released executions have no trusted result: reserve and storage remain customer-funded.
fn released_jobs()->LookupMap<String,bool>{LookupMap::new(&b"OLREL"[..])}
/// Margins kept by agents when a requester reserved the slot but never started.
fn forfeits()->LookupMap<String,u128>{LookupMap::new(&b"OLFF"[..])}
/// Who caused a definite guest failure. An explicit guest `fault` wins. Older guests do
/// not report one: Scout/Compare failures come from typed customer input, and Research
/// failures are the operator's unless the model ran and its output failed validation.
fn failure_fault(service:&str,output:&serde_json::Value)->&'static str{
    match output.get("fault").and_then(|v|v.as_str()){Some("customer")=>return "customer",Some("operator")=>return "operator",_=>{}}
    if service!="research"{return "customer"}
    if output.get("inferenceOutcome").and_then(|v|v.as_str())==Some("succeeded"){"customer"}else{"operator"}
}
fn job_services()->LookupMap<String,JobService>{LookupMap::new(&b"OLJS"[..])}
/// A hired job's refunds belong to the hiring NFA, including after its NFT is sold.
fn job_hirers()->LookupMap<String,TokenId>{LookupMap::new(&b"OLHIRE"[..])}
fn job_refunds()->LookupMap<String,u128>{LookupMap::new(&b"OLJREF"[..])}
fn credit_job_refund(token_id:&str,id:u64,requester:&AccountId,amount:u128){
    job_refunds().insert(&op_key(token_id,id),&amount);
    if let Some(hirer)=job_hirers().get(&op_key(token_id,id)){
        let balance=incomes().get(&hirer).unwrap_or(0).checked_add(amount).unwrap();
        incomes().insert(&hirer,&balance);
    }else{
        let mut payout=payouts().get(requester).unwrap_or_default();
        payout.available.0=payout.available.0.checked_add(amount).unwrap();
        payouts().insert(requester,&payout);
    }
}
fn service_ledgers()->LookupMap<String,PaidLedger>{LookupMap::new(&b"OLSL"[..])}
fn service_key(token_id:&str,service_id:&str)->String{format!("{token_id}:{service_id}")}
fn job_service(token_id:&str,id:u64)->String{
    job_services().get(&op_key(token_id,id)).map(|s|s.service_id).unwrap_or_else(||"scout".into())
}
fn update_service_ledger(token_id:&str,id:u64,change:impl FnOnce(&mut PaidLedger)){
    // Jobs written before this index existed remain in the global ledger only.
    let Some(binding)=job_services().get(&op_key(token_id,id)) else{return};
    let key=binding.service_id;let mut ledger=service_ledgers().get(&key).unwrap_or_default();
    change(&mut ledger);service_ledgers().insert(&key,&ledger);
}
fn known_service(service_id:&str)->bool{matches!(service_id,"scout"|"compare"|"research")}
fn valid_limits(l:&SkillLimits)->bool{l.max_instructions>0 && l.max_instructions<=2_000_000_000
    && l.max_memory_mb>0 && l.max_memory_mb<=128 && l.max_execution_seconds>0 && l.max_execution_seconds<=30}
fn same_limits(request:&SkillLimits,policy:&SkillLimits)->bool{
    request.max_instructions==policy.max_instructions && request.max_memory_mb==policy.max_memory_mb
        && request.max_execution_seconds==policy.max_execution_seconds}
fn releasable(a:&Agent,j:&PaidJob,id:u64)->bool{
    a.pending_op==Some(id) && (j.status=="UNCERTAIN" || (j.status=="EXECUTING"
        && j.started_at_ns.is_some_and(|t|env::block_timestamp()>=t.saturating_add(RELEASE_DELAY_NS))))
}
fn save_ledger(ledger:&PaidLedger) { ledgers().insert(&0,ledger); }
pub(super) fn migration_escrow() -> u128 { ledgers().get(&0).unwrap_or_default().customer_escrow.0 }
pub(super) fn migration_recall(key: &str) -> u128 {
    recalls().get(&key.to_string()).filter(|r| matches!(r.state.as_str(),"EXECUTING"|"UNCERTAIN"|"RECONCILING"))
        .map(|r|r.deposit.0).unwrap_or(0)
}
fn ol_hash(s: &str) -> bool { s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()) }
fn ol_url(s: &str) -> bool { s.starts_with("https://") && s.len() <= 300 && !s.contains('@') && !s.contains('#') && !s.bytes().any(|b|b.is_ascii_whitespace()) }
fn ol_call(vault: AccountId, method: &str, args: serde_json::Value, gas: u64) -> Promise {
    Promise::new(vault).function_call(method.to_string(),args.to_string().into_bytes(),
        NearToken::from_yoctonear(0),Gas::from_tgas(gas))
}
fn ol_callback(method: &str, token_id: &str, id: u64) -> Promise {
    Promise::new(env::current_account_id()).function_call(method.to_string(),
        serde_json::json!({"token_id":token_id,"id":id}).to_string().into_bytes(),
        NearToken::from_yoctonear(0),Gas::from_tgas(40))
}

#[near]
impl Registry {
    /// Owner approval binds one operator prepared ciphertext to this ownership epoch.
    /// The operator retains the plaintext key privately so a seller cannot keep using it.
    #[payable]
    pub fn approve_payment_key(&mut self,token_id:TokenId,nonce:u32,ciphertext_hash:String)->PaymentKeySetup{
        assert_one_yocto();let a=self.active_owner(&token_id);
        require!(nonce>0 && ol_hash(&ciphertext_hash),"Invalid Payment Key commitment");
        require!(projects().get(&token_id).is_some_and(|p|p.state=="READY"),"Project unavailable");
        require!(!payment_key_setups().get(&token_id).is_some_and(|s|matches!(s.state.as_str(),"SUBMITTED"|"UNCERTAIN"|"READY")),"Payment Key already issued or unresolved");
        let setup=PaymentKeySetup{epoch:a.epoch,nonce,ciphertext_hash:ciphertext_hash.to_ascii_lowercase(),
            expires_at_ns:env::block_timestamp().saturating_add(PAYMENT_KEY_APPROVAL_NS),
            operation_id:None,state:"APPROVED".into()};
        payment_key_setups().insert(&token_id,&setup);
        event("payment_key_approved",serde_json::json!({"token_id":token_id,"epoch":a.epoch,"nonce":nonce,"ciphertext_hash":setup.ciphertext_hash}));
        setup
    }

    pub fn payment_key_setup(&self,token_id:TokenId)->Option<PaymentKeySetup>{payment_key_setups().get(&token_id)}

    /// The admin submits the exact package approved by the NFT owner. No key
    /// plaintext is accepted or logged by this contract.
    pub fn issue_payment_key(&mut self,token_id:TokenId,encrypted_secrets_base64:String)->Promise{
        require!(env::predecessor_account_id()==self.admin,"Admin only");
        let mut a=self.transferable(&token_id);
        let mut setup=payment_key_setups().get(&token_id).unwrap_or_else(||env::panic_str("No Payment Key approval"));
        require!(setup.state=="APPROVED" && setup.epoch==a.epoch
            && env::block_timestamp()<=setup.expires_at_ns,"Approval expired or stale");
        require!(encrypted_secrets_base64.len()>=80 && encrypted_secrets_base64.len()<=4096
            && encrypted_secrets_base64.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'+'||b==b'/'||b==b'='),"Invalid ciphertext");
        require!(hex(&env::sha256(encrypted_secrets_base64.as_bytes()))==setup.ciphertext_hash,"Ciphertext differs from owner approval");
        let id=a.next_op_id;a.next_op_id+=1;a.pending_op=Some(id);
        setup.operation_id=Some(id);setup.state="SUBMITTED".into();
        self.agents.insert(&token_id,&a);payment_key_setups().insert(&token_id,&setup);
        ol_call(a.vault_id,"create_payment_key",serde_json::json!({
            "id":id,"nonce":setup.nonce,"encrypted_secrets_base64":encrypted_secrets_base64
        }),210).then(ol_callback("on_payment_key_issued",&token_id,id))
    }

    #[private]
    pub fn on_payment_key_issued(&mut self,token_id:TokenId,id:u64)->bool{
        let mut a=self.agents.get(&token_id).unwrap();
        let mut setup=payment_key_setups().get(&token_id).unwrap();
        require!(a.pending_op==Some(id)&&setup.operation_id==Some(id)
            && matches!(setup.state.as_str(),"SUBMITTED"|"UNCERTAIN"),"Stale Payment Key callback");
        let result=env::promise_result_checked(0,32).ok()
            .and_then(|b|serde_json::from_slice::<Option<bool>>(&b).ok()).flatten();
        match result {
            Some(true)=>{setup.state="READY".into();a.pending_op=None;},
            Some(false)=>{setup.state="FAILED".into();a.pending_op=None;},
            None=>{setup.state="UNCERTAIN".into();},
        }
        payment_key_setups().insert(&token_id,&setup);self.agents.insert(&token_id,&a);
        event("payment_key_issuance",serde_json::json!({"token_id":token_id,"id":id,"state":setup.state}));
        result==Some(true)
    }

    /// Requery OutLayer after an uncertain callback. Never resubmit ciphertext.
    pub fn reconcile_payment_key_setup(&mut self,token_id:TokenId)->Promise{
        require!(env::predecessor_account_id()==self.admin,"Admin only");
        let a=self.agents.get(&token_id).unwrap_or_else(||env::panic_str("Unknown agent"));
        let setup=payment_key_setups().get(&token_id).unwrap_or_else(||env::panic_str("No Payment Key setup"));
        require!(setup.state=="UNCERTAIN"&&a.pending_op==setup.operation_id,"No uncertain issuance");
        let id=setup.operation_id.unwrap();
        ol_call(a.vault_id,"reconcile_payment_key",serde_json::json!({"id":id}),80)
            .then(ol_callback("on_payment_key_issued",&token_id,id))
    }
    #[payable]
    pub fn configure_service(&mut self,token_id:TokenId,service_id:String,schema_hash:String,
        enabled:bool,min_margin:U128,max_deposit:U128,limits:SkillLimits)->ServicePolicy{
        assert_one_yocto();let _=self.active_owner(&token_id);
        let project=projects().get(&token_id).unwrap_or_else(||env::panic_str("No Project"));
        require!(project.state=="READY" && known_service(&service_id) && valid_content_hash(&schema_hash)
            && min_margin.0>=MIN_MARGIN && max_deposit.0>0 && max_deposit.0<=MAX_JOB_DEPOSIT
            && valid_limits(&limits),"Invalid service policy");
        let key=service_key(&token_id,&service_id);
        let version=service_policies().get(&key).map(|p|p.version+1).unwrap_or(1);
        let policy=ServicePolicy{service_id,version,schema_hash,enabled,min_margin,max_deposit,limits};
        service_policies().insert(&key,&policy);
        event("service_policy_updated",serde_json::json!({"token_id":token_id,"policy":policy}));policy
    }
    pub fn service_policy(&self,token_id:TokenId,service_id:String)->Option<ServicePolicy>{
        if !known_service(&service_id){return None}service_policies().get(&service_key(&token_id,&service_id))
    }
    pub fn service_catalog(&self,token_id:TokenId)->Vec<ServicePolicy>{
        ["scout","compare","research"].iter().filter_map(|s|service_policies().get(&service_key(&token_id,s))).collect()
    }
    #[payable]
    pub fn provision_outlayer(&mut self, token_id: TokenId, wasm_url: String,
        version_key: String, deposit: U128) -> Promise {
        assert_one_yocto(); let mut a = self.active_owner(&token_id);
        require!(projects().get(&token_id).is_none(), "Project already provisioned or unresolved");
        require!(ol_url(&wasm_url) && ol_hash(&version_key) && deposit.0 > 0
            && deposit.0 <= MAX_PROJECT_DEPOSIT, "Invalid source/deposit");
        let id = a.next_op_id; a.next_op_id += 1; a.pending_op = Some(id);
        projects().insert(&token_id, &OutlayerProject { project_id: format!("{}/scout",a.vault_id),
            project_uuid:String::new(),version_key:version_key.clone(),candidate_version:None,
            state:"CREATING".into(),action:"create".into() });
        self.agents.insert(&token_id,&a);
        ol_call(a.vault_id,"create_project",serde_json::json!({"id":id,"wasm_url":wasm_url,
            "version_key":version_key,"deposit":deposit}),130).then(ol_callback("on_outlayer_project",&token_id,id))
    }

    #[payable]
    pub fn add_outlayer_version(&mut self, token_id: TokenId, wasm_url: String,
        version_key: String, deposit: U128) -> Promise {
        assert_one_yocto(); let mut a = self.active_owner(&token_id);
        let mut p = projects().get(&token_id).unwrap_or_else(|| env::panic_str("No project"));
        require!(p.state == "READY" && ol_url(&wasm_url) && ol_hash(&version_key)
            && deposit.0 > 0 && deposit.0 <= MAX_PROJECT_DEPOSIT, "Invalid version");
        let id = a.next_op_id; a.next_op_id += 1; a.pending_op = Some(id);
        p.candidate_version = Some(version_key.clone()); p.state = "ADDING".into(); p.action="add".into();
        projects().insert(&token_id,&p); self.agents.insert(&token_id,&a);
        ol_call(a.vault_id,"add_version",serde_json::json!({"id":id,"wasm_url":wasm_url,
            "version_key":version_key,"deposit":deposit}),130).then(ol_callback("on_outlayer_project",&token_id,id))
    }

    #[payable]
    pub fn activate_outlayer_version(&mut self, token_id: TokenId) -> Promise {
        assert_one_yocto(); let mut a = self.active_owner(&token_id);
        let mut p = projects().get(&token_id).unwrap_or_else(|| env::panic_str("No project"));
        require!(p.state == "READY" && p.candidate_version.is_some(), "No approved candidate");
        let version = p.candidate_version.clone().unwrap();
        let id = a.next_op_id; a.next_op_id += 1; a.pending_op = Some(id);
        p.state = "ACTIVATING".into(); p.action="activate".into(); projects().insert(&token_id,&p); self.agents.insert(&token_id,&a);
        ol_call(a.vault_id,"set_active_version",serde_json::json!({"id":id,
            "version_key":version}),110).then(ol_callback("on_outlayer_project",&token_id,id))
    }

    #[private]
    pub fn on_outlayer_project(&mut self, token_id: TokenId, id: u64) -> bool {
        let mut a = self.agents.get(&token_id).unwrap();
        let mut p = projects().get(&token_id).unwrap();
        require!(a.pending_op == Some(id) && matches!(p.state.as_str(),"CREATING"|"ADDING"|"ACTIVATING"|"UNCERTAIN"),"Stale project callback");
        let result = env::promise_result_checked(0, 4096).ok()
            .and_then(|b|serde_json::from_slice::<Option<serde_json::Value>>(&b).ok()).flatten();
        let uuid = result.as_ref().and_then(|v|v.get("project_uuid")).and_then(|v|v.as_str()).unwrap_or("");
        let project_id = result.as_ref().and_then(|v|v.get("project_id")).and_then(|v|v.as_str()).unwrap_or("");
        if uuid.is_empty() || uuid.len()>80 || project_id != p.project_id || (!p.project_uuid.is_empty() && uuid != p.project_uuid) {
            p.state = "UNCERTAIN".into(); projects().insert(&token_id,&p); return false;
        }
        p.project_uuid = uuid.into();
        if p.action == "activate" { p.version_key = p.candidate_version.take().unwrap(); }
        p.state = "READY".into(); p.action.clear(); projects().insert(&token_id,&p);
        event("runtime_ready",serde_json::json!({"token_id":token_id,"id":id,"project":p}));
        a.pending_op = None; self.agents.insert(&token_id,&a); true
    }

    pub fn outlayer_project(&self, token_id: TokenId) -> Option<OutlayerProject> { projects().get(&token_id) }

    pub fn reconcile_outlayer_project(&mut self, token_id: TokenId) -> Promise {
        let a = self.agents.get(&token_id).unwrap();
        let p = projects().get(&token_id).unwrap();
        require!(p.state == "UNCERTAIN" && a.pending_op.is_some(),"Project not uncertain");
        let id = a.pending_op.unwrap();
        ol_call(a.vault_id,"reconcile_project",serde_json::json!({"id":id}),55)
            .then(ol_callback("on_outlayer_project",&token_id,id))
    }

    /// The only paid-job entry point: the quote pins the runtime version, the service
    /// policy version and (for Research) the configuration hash, so an owner change between
    /// quote and payment is rejected before any fee is escrowed.
    #[payable]
    pub fn request_reviewed_service_job(&mut self,token_id:TokenId,service_id:String,input_hash:String,
        deadline_ns:u64,fee:U128,replenish:U128,deposit_cap:U128,limits:SkillLimits,
        expected_version:String,expected_policy_version:u64,expected_research_config:Option<String>)->u64{
        let project=projects().get(&token_id).unwrap_or_else(||env::panic_str("No Project"));
        let policy_version=service_policies().get(&service_key(&token_id,&service_id)).map(|p|p.version).unwrap_or(0);
        require!(project.version_key==expected_version&&policy_version==expected_policy_version,"Quote runtime or policy changed");
        if service_id=="research"{require!(self.research_config(token_id.clone()).is_some_and(|c|
            Some(c.configuration_hash)==expected_research_config),"Quote research configuration changed")}
        self.request_job(&token_id,&service_id,input_hash,deadline_ns,fee,replenish,deposit_cap,limits,None)
    }

    /// Spend only the hiring NFA's accrued income. The owner authorizes a single
    /// capped quote; unused funds and later refunds remain with that NFA on sale.
    #[payable]
    pub fn hire_reviewed_service_job(&mut self,source_token_id:TokenId,token_id:TokenId,
        service_id:String,input_hash:String,deadline_ns:u64,fee:U128,replenish:U128,
        deposit_cap:U128,limits:SkillLimits,expected_version:String,
        expected_policy_version:u64,expected_research_config:Option<String>,
        expected_source_epoch:u64,max_fee:U128)->u64{
        assert_one_yocto();
        require!(source_token_id!=token_id,"An NFA cannot hire itself");
        require!(service_id=="scout"||service_id=="compare","Hired service output must be reconstructible");
        let source=self.transferable(&source_token_id);
        require!(source.epoch==expected_source_epoch && fee.0>0 && fee.0<=max_fee.0
            && incomes().get(&source_token_id).unwrap_or(0)>=fee.0,"Hiring budget or owner epoch changed");
        let target_scope:AccountId=token_id.parse().unwrap_or_else(|_|env::panic_str("Invalid hiring target"));
        self.authorize(&source_token_id,&source,"NFA_HIRE",Some(&target_scope),fee.0);
        let project=projects().get(&token_id).unwrap_or_else(||env::panic_str("No Project"));
        let policy_version=service_policies().get(&service_key(&token_id,&service_id)).map(|p|p.version).unwrap_or(0);
        require!(project.version_key==expected_version&&policy_version==expected_policy_version,"Quote runtime or policy changed");
        if service_id=="research"{require!(self.research_config(token_id.clone()).is_some_and(|c|
            Some(c.configuration_hash)==expected_research_config),"Quote research configuration changed")}
        self.request_job(&token_id,&service_id,input_hash,deadline_ns,fee,replenish,deposit_cap,limits,Some(source_token_id))
    }

    // Customers pay for a job but do not choose its resources: limits are the owner's
    // policy limits exactly, and the execution deposit has a floor. A customer-chosen
    // 1-instruction or 1-yocto execution would otherwise force an unresolvable result.
    fn request_job(&mut self,token_id:&TokenId,service_id:&str,input_hash:String,
        deadline_ns:u64,fee:U128,replenish:U128,deposit_cap:U128,limits:SkillLimits,
        hirer:Option<TokenId>)->u64{
        require!(known_service(service_id),"Unknown service");
        let p=service_policies().get(&service_key(token_id,service_id)).unwrap_or_else(||env::panic_str("Service not configured"));
        require!(p.enabled && fee.0>=replenish.0.saturating_add(p.min_margin.0)
            && deposit_cap.0<=p.max_deposit.0,"Service policy exceeded");
        require!(same_limits(&limits,&p.limits),"Job limits must equal the service policy");
        require!(deposit_cap.0>=MIN_JOB_DEPOSIT,"Execution deposit below floor");
        let policy=Some(p);
        let mut a = self.transferable(&token_id);
        let p = projects().get(token_id).unwrap_or_else(||env::panic_str("No OutLayer project"));
        require!(p.state == "READY" && !p.project_uuid.is_empty(),"Project not ready");
        require!(valid_content_hash(&input_hash) && deposit_cap.0 > 0 && deposit_cap.0 <= MAX_JOB_DEPOSIT
            && replenish.0 >= deposit_cap.0 && fee.0 >= replenish.0.saturating_add(MIN_MARGIN)
            && (hirer.is_some() || env::attached_deposit().as_yoctonear() == fee.0),"Invalid paid job quote");
        require!(valid_limits(&limits),"Resource cap");
        require!(deadline_ns > env::block_timestamp() && deadline_ns.saturating_sub(env::block_timestamp()) <= START_WINDOW_NS,"Start deadline must be within 30 minutes");
        require!(fee.0-replenish.0>=job_storage_fee(),"Margin must cover job storage");
        let id = a.next_op_id;
        if service_id=="research"{self.reserve_research(token_id,id,&p.version_key,&env::predecessor_account_id())}
        if let Some(ref source)=hirer{
            let balance=incomes().get(source).unwrap_or(0);
            require!(balance>=fee.0,"Insufficient hiring income");
            incomes().insert(source,&(balance-fee.0));
            job_hirers().insert(&op_key(token_id,id),source);
        }else{add_liability(fee.0)}
        a.next_op_id += 1; a.pending_op = Some(id); self.agents.insert(token_id,&a);
        paid_jobs().insert(&op_key(token_id,id),&PaidJob {id,epoch:a.epoch,requester:env::predecessor_account_id(),
            input_hash,fee,replenish,deposit_cap,version_key:p.version_key,limits,deadline_ns,
            created_at_ns:env::block_timestamp(),started_at_ns:None,
            status:"REQUESTED".into(),output_hash:None,output_uri:None,reimbursement_pending:false});
        job_services().insert(&op_key(token_id,id),&JobService{service_id:service_id.into(),
            policy_version:policy.map(|p|p.version).unwrap_or(0)});
        let mut ledger=ledgers().get(&0).unwrap_or_default();
        ledger.customer_escrow.0=ledger.customer_escrow.0.checked_add(fee.0).unwrap(); save_ledger(&ledger);
        update_service_ledger(token_id,id,|s|s.customer_escrow.0=s.customer_escrow.0.checked_add(fee.0).unwrap());
        event("service_job_requested",serde_json::json!({"token_id":token_id,"id":id,"service_id":service_id,"hired_by":hirer,
            "input_hash":paid_jobs().get(&op_key(token_id,id)).unwrap().input_hash,"fee":fee,"replenish":replenish,
            "deposit_cap":deposit_cap,"epoch":a.epoch}));
        id
    }

    // input_data is the committed service payload only. The registry adds the
    // assigned job ID after payment, so quotes cannot race the next operation ID.
    pub fn start_paid_scout(&mut self, token_id: TokenId, id: u64, input_data: String) -> Promise {
        require!(job_services().get(&op_key(&token_id,id)).map(|s|s.service_id=="scout").unwrap_or(true),"Wrong service");
        self.start_service_job(token_id,id,input_data)
    }

    pub fn start_service_job(&mut self, token_id: TokenId, id:u64,input_data:String)->Promise{
        let a = self.agents.get(&token_id).unwrap();
        let mut j = paid_jobs().get(&op_key(&token_id,id)).unwrap();
        let service=job_service(&token_id,id);
        let input_hash = format!("sha256:{}",hex(&env::sha256(input_data.as_bytes())));
        require!(a.pending_op == Some(id) && a.lifecycle == Lifecycle::Active && j.epoch==a.epoch && j.status == "REQUESTED"
            && env::block_timestamp() < j.deadline_ns && j.input_hash == input_hash
            && input_data.len() <= 8_192, "Job input/stage mismatch");
        let value: serde_json::Value = serde_json::from_str(&input_data).unwrap_or_else(|_|env::panic_str("Input must be JSON"));
        let object=value.as_object().unwrap_or_else(||env::panic_str("Scout input must be an object"));
        require!(object.get("question").and_then(|x|x.as_str()).is_some()
            && object.get("sources").and_then(|x|x.as_array()).is_some(),"Typed service input only");
        let execution_input=if service=="research"{self.research_execution(&token_id,id,&value)}else if service=="scout"{
            require!(object.len()==2,"Typed Scout input only");
            serde_json::json!({"operation":"scout","jobId":id,
                "question":object.get("question").unwrap(),"sources":object.get("sources").unwrap()})
        }else{
            require!(service=="compare" && object.len()==3
                && object.get("criteria").and_then(|x|x.as_array()).is_some(),"Typed Compare input only");
            serde_json::json!({"operation":"run","service":"compare","jobId":id,
                "question":object.get("question").unwrap(),"criteria":object.get("criteria").unwrap(),
                "sources":object.get("sources").unwrap()})
        }.to_string();
        require!(execution_input.len()<=8_192,"Execution input size cap");
        j.status = "EXECUTING".into(); j.started_at_ns=Some(env::block_timestamp()); paid_jobs().insert(&op_key(&token_id,id),&j);
        event("service_job_started",serde_json::json!({"token_id":token_id,"id":id,"service_id":service,
            "input_hash":j.input_hash,"runtime_hash":j.version_key}));
        let mut args=serde_json::json!({"id":id,"version_key":j.version_key,"input_data":execution_input,"limits":j.limits,"deposit":j.deposit_cap});
        if service=="research"{args["secrets_ref"]=serde_json::to_value(self.research_config(token_id.clone()).unwrap().settings.secrets_ref).unwrap();}
        ol_call(a.vault_id,if service=="research"{"execute_research_skill"}else{"execute_skill"},args,175)
            .then(ol_callback("on_outlayer_start_returned",&token_id,id))
    }

    /// Prepare a paid Research job for a single operator-submitted HTTPS call.
    /// The returned input is committed on-chain; this method does not dispatch OutLayer.
    pub fn prepare_async_research_job(&mut self,token_id:TokenId,id:u64,input_data:String)->String{
        require!(job_service(&token_id,id)=="research","Research only");
        let a=self.agents.get(&token_id).unwrap();
        let mut j=paid_jobs().get(&op_key(&token_id,id)).unwrap();
        let project=projects().get(&token_id).unwrap();
        require!(a.pending_op==Some(id)&&a.lifecycle==Lifecycle::Active&&j.epoch==a.epoch&&
            j.status=="REQUESTED"&&env::block_timestamp()<j.deadline_ns&&project.state=="READY"&&
            project.version_key==j.version_key&&
            payment_key_setups().get(&token_id).is_some_and(|s|s.state=="READY")&&
            input_data.len()<=8192&&format!("sha256:{}",hex(&env::sha256(input_data.as_bytes())))==j.input_hash,
            "Async Research input, owner or key changed");
        let value:serde_json::Value=serde_json::from_str(&input_data).unwrap_or_else(|_|env::panic_str("Input must be JSON"));
        require!(value.get("question").and_then(|v|v.as_str()).is_some()&&
            value.get("sources").and_then(|v|v.as_array()).is_some(),"Typed Research input only");
        let execution=self.research_execution(&token_id,id,&value).to_string();
        require!(execution.len()<=8192,"Execution input size cap");
        let execution_hash=format!("sha256:{}",hex(&env::sha256(execution.as_bytes())));
        j.status="ASYNC_PREPARED".into();j.started_at_ns=Some(env::block_timestamp());
        paid_jobs().insert(&op_key(&token_id,id),&j);
        async_research_jobs().insert(&op_key(&token_id,id),&AsyncResearchJob{execution_hash:execution_hash.clone(),
            call_id:None,state:"PREPARED".into(),compute_cost_microusd:None,max_compute_microusd:ASYNC_COMPUTE_CAP_MICROUSD});
        event("async_research_prepared",serde_json::json!({"token_id":token_id,"id":id,"execution_hash":execution_hash,
            "runtime_hash":j.version_key,"epoch":j.epoch}));
        execution
    }

    /// The restricted reporter binds the admitted OutLayer call before it can settle.
    pub fn bind_async_research_call(&mut self,token_id:TokenId,id:u64,call_id:String,
        execution_hash:String,version_key:String,epoch:u64){
        require!(env::predecessor_account_id()==self.reporter,"Reporter only");
        let a=self.agents.get(&token_id).unwrap();let mut j=paid_jobs().get(&op_key(&token_id,id)).unwrap();
        let mut r=async_research_jobs().get(&op_key(&token_id,id)).unwrap();
        require!(call_id.len()==36&&call_id.bytes().enumerate().all(|(i,b)|
            if matches!(i,8|13|18|23){b==b'-'}else{b.is_ascii_hexdigit()}),"Invalid OutLayer call ID");
        require!(a.pending_op==Some(id)&&a.epoch==epoch&&j.epoch==epoch&&j.version_key==version_key&&
            j.status=="ASYNC_PREPARED"&&r.state=="PREPARED"&&r.call_id.is_none()&&
            r.execution_hash==execution_hash&&j.started_at_ns.is_some_and(|t|env::block_timestamp()<t.saturating_add(RELEASE_DELAY_NS)),
            "Async Research binding changed");
        r.call_id=Some(call_id.clone());r.state="RUNNING".into();j.status="ASYNC_RUNNING".into();
        async_research_jobs().insert(&op_key(&token_id,id),&r);paid_jobs().insert(&op_key(&token_id,id),&j);
        event("async_research_admitted",serde_json::json!({"token_id":token_id,"id":id,"call_id":call_id}));
    }

    /// The reporter checks OutLayer's call result off-chain and takes responsibility
    /// for its authenticity. The registry verifies every pinned job field and output.
    pub fn settle_async_research_job(&mut self,token_id:TokenId,id:u64,call_id:String,
        execution_hash:String,version_key:String,epoch:u64,output:Option<serde_json::Value>,
        compute_cost_microusd:u64)->bool{
        require!(env::predecessor_account_id()==self.reporter,"Reporter only");
        let mut a=self.agents.get(&token_id).unwrap();let mut j=paid_jobs().get(&op_key(&token_id,id)).unwrap();
        let mut r=async_research_jobs().get(&op_key(&token_id,id)).unwrap();
        require!(a.pending_op==Some(id)&&a.epoch==epoch&&j.epoch==epoch&&j.version_key==version_key&&
            j.status=="ASYNC_RUNNING"&&r.state=="RUNNING"&&r.call_id.as_deref()==Some(call_id.as_str())&&
            r.execution_hash==execution_hash&&compute_cost_microusd<=r.max_compute_microusd,
            "Async Research result changed or exceeds compute cap");
        r.compute_cost_microusd=Some(compute_cost_microusd);
        let valid=output.as_ref().filter(|o|o["schemaVersion"].as_u64()==Some(1)&&o["jobId"].as_u64()==Some(id));
        let mut success=false;let mut customer_failure=false;
        if let Some(o)=valid{
            if o["status"]=="ok"{
                let hash=o["outputHash"].as_str().unwrap_or("");let uri=o["outputUri"].as_str().unwrap_or("");
                let usage=o["pricedUsageMicrousd"].as_u64();
                let reserve=self.research_usage(token_id.clone(),id).map(|u|u.reserved_microusd).unwrap_or(0);
                if valid_content_hash(hash)&&uri==format!("nfa://work/{}",&hash[7..])&&
                    o["inferenceOutcome"]=="succeeded"&&usage.is_some_and(|u|u>0&&u<=reserve){
                    j.output_hash=Some(hash.into());j.output_uri=Some(uri.into());success=true;
                }
            }else if o["status"]=="failed"&&failure_fault("research",o)=="customer"&&
                o["inferenceOutcome"]=="succeeded"&&o["pricedUsageMicrousd"].as_u64().is_some_and(|u|
                    u>0&&u<=self.research_usage(token_id.clone(),id).map(|r|r.reserved_microusd).unwrap_or(0)){
                customer_failure=true;
            }
            if success||customer_failure{self.research_result(&token_id,id,o)}
            else{self.research_released(&token_id,id)}
        }else{self.research_released(&token_id,id)}
        let mut ledger=ledgers().get(&0).unwrap_or_default();
        ledger.customer_escrow.0=ledger.customer_escrow.0.saturating_sub(j.fee.0);
        if success||customer_failure{
            let reimbursement=j.replenish.0.saturating_mul(u128::from(compute_cost_microusd))
                .div_ceil(u128::from(r.max_compute_microusd));
            let storage=job_storage_fee().min(j.fee.0.saturating_sub(reimbursement));
            collect_storage(storage);
            let remainder=j.fee.0-reimbursement-storage;
            let mut reporter_credit=payouts().get(&self.reporter).unwrap_or_default();
            reporter_credit.available.0=reporter_credit.available.0.checked_add(reimbursement).unwrap();
            payouts().insert(&self.reporter,&reporter_credit);
            if success{
                j.status="FINALIZED".into();r.state="FINALIZED".into();
                self.research_finalized(&token_id,id,j.output_hash.as_deref().unwrap());
                incomes().insert(&token_id,&incomes().get(&token_id).unwrap_or(0).checked_add(remainder).unwrap());
                ledger.gross_finalized_receipts.0=ledger.gross_finalized_receipts.0.checked_add(j.fee.0).unwrap();
            }else{
                j.status="FAILED".into();r.state="FAILED".into();
                credit_job_refund(&token_id,id,&j.requester,remainder);
                ledger.customer_refunds.0=ledger.customer_refunds.0.checked_add(remainder).unwrap();
            }
            update_service_ledger(&token_id,id,|s|{
                s.customer_escrow.0=s.customer_escrow.0.saturating_sub(j.fee.0);
                if success{s.gross_finalized_receipts.0=s.gross_finalized_receipts.0.checked_add(j.fee.0).unwrap()}
                else{s.customer_refunds.0=s.customer_refunds.0.checked_add(remainder).unwrap()}
            });
            event("async_research_settled",serde_json::json!({"token_id":token_id,"id":id,"call_id":call_id,
                "status":j.status,"output_hash":j.output_hash,
                "priced_usage_microusd":output.as_ref().and_then(|o|o["pricedUsageMicrousd"].as_u64()),
                "compute_cost_microusd":compute_cost_microusd,"operator_reimbursement":U128(reimbursement)}));
        }else{
            self.research_released(&token_id,id);
            charge_storage_to_agent(&token_id);
            j.status="FAILED".into();r.state="FAILED".into();a.lifecycle=Lifecycle::Draining;
            credit_job_refund(&token_id,id,&j.requester,j.fee.0);
            ledger.customer_refunds.0=ledger.customer_refunds.0.checked_add(j.fee.0).unwrap();
            update_service_ledger(&token_id,id,|s|{s.customer_escrow.0=s.customer_escrow.0.saturating_sub(j.fee.0);
                s.customer_refunds.0=s.customer_refunds.0.checked_add(j.fee.0).unwrap()});
            event("async_research_settled",serde_json::json!({"token_id":token_id,"id":id,"call_id":call_id,
                "status":"FAILED","fault":"operator","compute_cost_microusd":compute_cost_microusd}));
        }
        save_ledger(&ledger);a.pending_op=None;self.agents.insert(&token_id,&a);
        paid_jobs().insert(&op_key(&token_id,id),&j);async_research_jobs().insert(&op_key(&token_id,id),&r);
        success
    }

    /// An unreported HTTPS call cannot hold the NFA forever. Late reports are rejected.
    pub fn release_async_research_job(&mut self,token_id:TokenId,id:u64){
        let mut a=self.agents.get(&token_id).unwrap();let mut j=paid_jobs().get(&op_key(&token_id,id)).unwrap();
        let mut r=async_research_jobs().get(&op_key(&token_id,id)).unwrap();
        require!(a.pending_op==Some(id)&&matches!(j.status.as_str(),"ASYNC_PREPARED"|"ASYNC_RUNNING")&&
            j.started_at_ns.is_some_and(|t|env::block_timestamp()>=t.saturating_add(RELEASE_DELAY_NS)),
            "Async Research is not releasable");
        self.research_released(&token_id,id);charge_storage_to_agent(&token_id);
        credit_job_refund(&token_id,id,&j.requester,j.fee.0);
        let mut ledger=ledgers().get(&0).unwrap_or_default();
        ledger.customer_escrow.0=ledger.customer_escrow.0.saturating_sub(j.fee.0);
        ledger.customer_refunds.0=ledger.customer_refunds.0.checked_add(j.fee.0).unwrap();save_ledger(&ledger);
        update_service_ledger(&token_id,id,|s|{s.customer_escrow.0=s.customer_escrow.0.saturating_sub(j.fee.0);
            s.customer_refunds.0=s.customer_refunds.0.checked_add(j.fee.0).unwrap()});
        j.status="FAILED".into();r.state="RELEASED".into();a.pending_op=None;a.lifecycle=Lifecycle::Draining;
        paid_jobs().insert(&op_key(&token_id,id),&j);async_research_jobs().insert(&op_key(&token_id,id),&r);
        self.agents.insert(&token_id,&a);
        event("async_research_released",serde_json::json!({"token_id":token_id,"id":id,"call_id":r.call_id,
            "refund_credit":j.fee}));
    }

    pub fn async_research_job(&self,token_id:TokenId,id:u64)->Option<AsyncResearchJob>{
        async_research_jobs().get(&op_key(&token_id,id))
    }

    #[private]
    pub fn on_outlayer_start_returned(&mut self, token_id: TokenId, id: u64) {
        let mut j = paid_jobs().get(&op_key(&token_id,id)).unwrap();
        if j.status == "EXECUTING" && env::promise_result_checked(0, 2048).is_err() {
            j.status = "UNCERTAIN".into(); paid_jobs().insert(&op_key(&token_id,id),&j);
        }
    }

    pub fn on_outlayer_job(&mut self, token_id: TokenId, id: u64, result: Option<serde_json::Value>) -> PromiseOrValue<bool> {
        let mut a = self.agents.get(&token_id).unwrap();
        let mut j = paid_jobs().get(&op_key(&token_id,id)).unwrap();
        require!(env::predecessor_account_id() == a.vault_id && a.pending_op == Some(id)
            && matches!(j.status.as_str(),"EXECUTING"|"UNCERTAIN"), "Vault/job mismatch");
        let Some(output) = result else { j.status="UNCERTAIN".into(); paid_jobs().insert(&op_key(&token_id,id),&j); return PromiseOrValue::Value(false) };
        if output.get("schemaVersion").and_then(|x|x.as_u64()) != Some(1)
            || output.get("jobId").and_then(|x|x.as_u64()) != Some(id) {
            j.status="UNCERTAIN".into(); paid_jobs().insert(&op_key(&token_id,id),&j); return PromiseOrValue::Value(false);
        }
        if output.get("status").and_then(|x|x.as_str()) == Some("failed") {
            let service=job_service(&token_id,id);
            if service=="research"{self.research_result(&token_id,id,&output)}
            if failure_fault(&service,&output)=="customer" {
                // The input caused the failure: the vault is reimbursed for compute from the
                // fee, the rest is refunded at settlement, and the agent stays available.
                customer_failures().insert(&op_key(&token_id,id),&true);
                return self.reimburse_vault(&token_id,id,j,a.vault_id);
            }
            charge_storage_to_agent(&token_id);
            j.status="FAILED".into(); paid_jobs().insert(&op_key(&token_id,id),&j);
            a.pending_op=None; a.lifecycle=Lifecycle::Draining; self.agents.insert(&token_id,&a);
            credit_job_refund(&token_id,id,&j.requester,j.fee.0);
            let mut ledger=ledgers().get(&0).unwrap_or_default();
            ledger.customer_escrow.0=ledger.customer_escrow.0.saturating_sub(j.fee.0);
            ledger.customer_refunds.0=ledger.customer_refunds.0.checked_add(j.fee.0).unwrap(); save_ledger(&ledger);
            update_service_ledger(&token_id,id,|s|{
                s.customer_escrow.0=s.customer_escrow.0.saturating_sub(j.fee.0);
                s.customer_refunds.0=s.customer_refunds.0.checked_add(j.fee.0).unwrap();
            });
            event("service_job_failed",serde_json::json!({"token_id":token_id,"id":id,"fault":"operator","refund_credit":j.fee,"runtime_hash":j.version_key}));
            return PromiseOrValue::Promise(ol_call(a.vault_id,"ack_skill",serde_json::json!({"id":id}),15));
        }
        let hash = output.get("outputHash").and_then(|x|x.as_str()).unwrap_or("");
        let uri = output.get("outputUri").and_then(|x|x.as_str()).unwrap_or("");
        if output.get("status").and_then(|x|x.as_str()) != Some("ok") || !valid_content_hash(hash)
            || uri != format!("nfa://work/{}",&hash[7..]) {
            j.status="UNCERTAIN".into(); paid_jobs().insert(&op_key(&token_id,id),&j); return PromiseOrValue::Value(false);
        }
        j.output_hash=Some(hash.into()); j.output_uri=Some(uri.into());
        if job_service(&token_id,id)=="research"{self.research_result(&token_id,id,&output)}
        self.reimburse_vault(&token_id,id,j,a.vault_id)
    }

    fn reimburse_vault(&mut self,token_id:&TokenId,id:u64,mut j:PaidJob,vault:AccountId)->PromiseOrValue<bool>{
        j.status="RECONCILING".into(); j.reimbursement_pending=true;
        paid_jobs().insert(&op_key(token_id,id),&j);
        let mut ledger=ledgers().get(&0).unwrap_or_default();
        ledger.vault_replenishment_pending.0=ledger.vault_replenishment_pending.0.checked_add(j.replenish.0).unwrap(); save_ledger(&ledger);
        update_service_ledger(token_id,id,|s|s.vault_replenishment_pending.0=
            s.vault_replenishment_pending.0.checked_add(j.replenish.0).unwrap());
        PromiseOrValue::Promise(Promise::new(vault).transfer(NearToken::from_yoctonear(j.replenish.0))
            .then(ol_callback("on_outlayer_replenished",token_id,id)))
    }

    #[private]
    pub fn on_outlayer_replenished(&mut self, token_id: TokenId, id: u64) -> PromiseOrValue<bool> {
        let mut a = self.agents.get(&token_id).unwrap();
        let mut j = paid_jobs().get(&op_key(&token_id,id)).unwrap();
        require!(a.pending_op == Some(id) && j.status == "RECONCILING" && j.reimbursement_pending,"Wrong reimbursement callback");
        if env::promise_results_count()!=1 { return PromiseOrValue::Value(false) }
        match env::promise_result_checked(0,32) {
            Ok(_) => {},
            Err(PromiseError::Failed) => {j.reimbursement_pending=false;paid_jobs().insert(&op_key(&token_id,id),&j);
                event("replenishment_failed",serde_json::json!({"token_id":token_id,"id":id,"liability":j.replenish}));return PromiseOrValue::Value(false)},
            Err(_) => return PromiseOrValue::Value(false),
        }
        j.reimbursement_pending=false;
        release_liability(j.replenish.0);
        let storage=job_storage_fee().min(j.fee.0-j.replenish.0);
        collect_storage(storage);
        let remainder=j.fee.0-j.replenish.0-storage;
        let released=released_jobs().get(&op_key(&token_id,id)).is_some();
        let failed=released || customer_failures().get(&op_key(&token_id,id)).is_some();
        if failed{customer_failures().remove(&op_key(&token_id,id));}
        if released{released_jobs().remove(&op_key(&token_id,id));}
        let mut ledger=ledgers().get(&0).unwrap_or_default();
        ledger.customer_escrow.0=ledger.customer_escrow.0.saturating_sub(j.fee.0);
        ledger.vault_replenishment_pending.0=ledger.vault_replenishment_pending.0.saturating_sub(j.replenish.0);
        if failed{ledger.customer_refunds.0=ledger.customer_refunds.0.checked_add(remainder).unwrap()}
        else{ledger.gross_finalized_receipts.0=ledger.gross_finalized_receipts.0.checked_add(j.fee.0).unwrap()}
        save_ledger(&ledger);
        update_service_ledger(&token_id,id,|s|{
            s.customer_escrow.0=s.customer_escrow.0.saturating_sub(j.fee.0);
            s.vault_replenishment_pending.0=s.vault_replenishment_pending.0.saturating_sub(j.replenish.0);
            if failed{s.customer_refunds.0=s.customer_refunds.0.checked_add(remainder).unwrap()}
            else{s.gross_finalized_receipts.0=s.gross_finalized_receipts.0.checked_add(j.fee.0).unwrap()}
        });
        if failed{
            j.status="FAILED".into(); paid_jobs().insert(&op_key(&token_id,id),&j);
            credit_job_refund(&token_id,id,&j.requester,remainder);
            event("service_job_failed",serde_json::json!({"token_id":token_id,"id":id,"fault":if released{"unresolved"}else{"customer"},
                "refund_credit":U128(remainder),"compute_charged":j.replenish,"storage_fee":U128(storage),"runtime_hash":j.version_key}));
        }else{
            j.status="FINALIZED".into();
            if job_service(&token_id,id)=="research"{self.research_finalized(&token_id,id,j.output_hash.as_deref().unwrap())}
            paid_jobs().insert(&op_key(&token_id,id),&j);
            let income = incomes().get(&token_id).unwrap_or(0).checked_add(remainder).unwrap();
            incomes().insert(&token_id,&income);
            event("service_job_finalized",serde_json::json!({"token_id":token_id,"id":id,"output_hash":j.output_hash,
                "runtime_hash":j.version_key,"fee":j.fee,"replenished":j.replenish,"storage_fee":U128(storage)}));
        }
        a.pending_op=None; self.agents.insert(&token_id,&a);
        // release_skill already cleared the vault; do not send a stale acknowledgement.
        if released { PromiseOrValue::Value(true) }
        else { PromiseOrValue::Promise(ol_call(a.vault_id,"ack_skill",serde_json::json!({"id":id}),15)) }
    }

    pub fn retry_outlayer_replenishment(&mut self, token_id: TokenId, id: u64) -> Promise {
        let a = self.agents.get(&token_id).unwrap();
        let mut j = paid_jobs().get(&op_key(&token_id,id)).unwrap();
        require!(a.pending_op == Some(id) && j.status == "RECONCILING" && !j.reimbursement_pending,"Reimbursement in flight");
        j.reimbursement_pending=true; paid_jobs().insert(&op_key(&token_id,id),&j);
        Promise::new(a.vault_id).transfer(NearToken::from_yoctonear(j.replenish.0))
            .then(ol_callback("on_outlayer_replenished",&token_id,id))
    }

    /// Permissionless. Ends a started job whose result can no longer arrive: the vault's
    /// OutLayer callback has returned (or the vault never began), but the registry has
    /// no definite result. The customer pays the quoted reserve and storage, receives
    /// the remainder as a refund, the work never enters memory and
    /// the NFA is usable again. Any late OutLayer storage write stays unreachable because
    /// recall and prior-work context require FINALIZED jobs.
    pub fn release_service_job(&mut self,token_id:TokenId,id:u64)->Promise{
        let a=self.agents.get(&token_id).unwrap_or_else(||env::panic_str("Unknown agent"));
        let j=paid_jobs().get(&op_key(&token_id,id)).unwrap_or_else(||env::panic_str("Unknown job"));
        require!(releasable(&a,&j,id),"Job is not releasable");
        ol_call(a.vault_id,"release_skill",serde_json::json!({"id":id}),15)
            .then(ol_call(env::current_account_id(),"on_service_job_released",
                serde_json::json!({"token_id":token_id,"id":id}),90))
    }

    #[private]
    pub fn on_service_job_released(&mut self,token_id:TokenId,id:u64)->PromiseOrValue<bool>{
        let a=self.agents.get(&token_id).unwrap();
        let j=paid_jobs().get(&op_key(&token_id,id)).unwrap();
        if !releasable(&a,&j,id){return PromiseOrValue::Value(false)}
        if !matches!(env::promise_result_checked(0,16),Ok(ref b) if b==b"true"){return PromiseOrValue::Value(false)}
        if job_service(&token_id,id)=="research"{self.research_released(&token_id,id)}
        // An unparseable/rejected result does not establish zero execution cost. Never
        // insure a customer-chosen underfunded deposit from agent income or pooled funds.
        // Reimburse the quoted reserve, charge storage, then refund only the remainder.
        // Keep the slot until the transfer settles; the usual retry path handles failure.
        released_jobs().insert(&op_key(&token_id,id),&true);
        event("service_job_released",serde_json::json!({"token_id":token_id,"id":id,
            "reimbursement_pending":j.replenish,"runtime_hash":j.version_key}));
        self.reimburse_vault(&token_id,id,j,a.vault_id)
    }

    /// Permissionless. Re-sends the vault acknowledgement for a settled job if the
    /// original `ack_skill` failed, so a stale vault pending cannot block later work.
    pub fn retry_job_ack(&mut self,token_id:TokenId,id:u64)->Promise{
        let a=self.agents.get(&token_id).unwrap_or_else(||env::panic_str("Unknown agent"));
        let j=paid_jobs().get(&op_key(&token_id,id)).unwrap_or_else(||env::panic_str("Unknown job"));
        require!(a.pending_op!=Some(id) && matches!(j.status.as_str(),"FINALIZED"|"FAILED"),"Job not settled");
        ol_call(a.vault_id,"ack_skill",serde_json::json!({"id":id}),15)
    }

    pub fn paid_scout_job(&self, token_id: TokenId, id: u64) -> Option<PaidJob> { paid_jobs().get(&op_key(&token_id,id)) }
    pub fn service_job(&self,token_id:TokenId,id:u64)->Option<serde_json::Value>{
        let job=paid_jobs().get(&op_key(&token_id,id))?;
        let binding=job_services().get(&op_key(&token_id,id)).unwrap_or(JobService{service_id:"scout".into(),policy_version:0});
        Some(serde_json::json!({"job":job,"service_id":binding.service_id,"policy_version":binding.policy_version,
            "hired_by":job_hirers().get(&op_key(&token_id,id)),
            "refund_credit":job_refunds().get(&op_key(&token_id,id)).map(U128),
            "research_usage":self.research_usage(token_id,id)}))
    }
    pub fn paid_scout_ledger(&self) -> PaidLedger { ledgers().get(&0).unwrap_or_default() }
    pub fn service_ledger(&self,service_id:String)->PaidLedger{
        require!(known_service(&service_id),"Unknown service");
        service_ledgers().get(&service_id).unwrap_or_default()
    }

    pub fn expire_unstarted_paid_scout(&mut self, token_id: TokenId, id: u64) {
        let mut a=self.agents.get(&token_id).unwrap();
        let mut j=paid_jobs().get(&op_key(&token_id,id)).unwrap();
        require!(a.pending_op==Some(id) && j.status=="REQUESTED" && env::block_timestamp()>=j.deadline_ns,"Job already started or not expired");
        j.status="FAILED".into(); paid_jobs().insert(&op_key(&token_id,id),&j);
        a.pending_op=None; self.agents.insert(&token_id,&a);
        if job_service(&token_id,id)=="research"{self.research_not_started(&token_id,id)}
        // The requester held the agent's only slot without starting: the execution deposit
        // is refunded, storage is paid and the remaining margin compensates the agent.
        let storage=job_storage_fee().min(j.fee.0-j.replenish.0);
        let forfeit=j.fee.0-j.replenish.0-storage;
        collect_storage(storage);
        incomes().insert(&token_id,&incomes().get(&token_id).unwrap_or(0).checked_add(forfeit).unwrap());
        let service=job_service(&token_id,id);
        for key in ["all".to_string(),service]{forfeits().insert(&key,&forfeits().get(&key).unwrap_or(0).saturating_add(forfeit));}
        let refund=j.replenish.0;
        credit_job_refund(&token_id,id,&j.requester,refund);
        let mut ledger=ledgers().get(&0).unwrap_or_default();
        ledger.customer_escrow.0=ledger.customer_escrow.0.saturating_sub(j.fee.0);
        ledger.customer_refunds.0=ledger.customer_refunds.0.checked_add(refund).unwrap();save_ledger(&ledger);
        update_service_ledger(&token_id,id,|s|{
            s.customer_escrow.0=s.customer_escrow.0.saturating_sub(j.fee.0);
            s.customer_refunds.0=s.customer_refunds.0.checked_add(refund).unwrap();
        });
        event("service_job_expired",serde_json::json!({"token_id":token_id,"id":id,"refund_credit":U128(refund),
            "forfeit":U128(forfeit),"storage_fee":U128(storage)}));
    }

    /// Owner: cancel a job that has not started (paid) or not completed (legacy), refunding
    /// the customer in full. The agent pays the job's storage from its income.
    #[payable]
    pub fn cancel_unstarted_job(&mut self,token_id:TokenId,id:u64){
        assert_one_yocto();
        require!(self.owner(&token_id)==env::predecessor_account_id(),"Owner only");
        let mut a=self.agents.get(&token_id).unwrap();
        require!(a.pending_op==Some(id),"Job is not the pending operation");
        let key=op_key(&token_id,id);
        let (requester,fee)=if let Some(mut j)=paid_jobs().get(&key){
            require!(j.status=="REQUESTED","Job already started");
            j.status="FAILED".into(); paid_jobs().insert(&key,&j);
            if job_service(&token_id,id)=="research"{self.research_not_started(&token_id,id)}
            let mut ledger=ledgers().get(&0).unwrap_or_default();
            ledger.customer_escrow.0=ledger.customer_escrow.0.saturating_sub(j.fee.0);
            ledger.customer_refunds.0=ledger.customer_refunds.0.checked_add(j.fee.0).unwrap();save_ledger(&ledger);
            update_service_ledger(&token_id,id,|s|{
                s.customer_escrow.0=s.customer_escrow.0.saturating_sub(j.fee.0);
                s.customer_refunds.0=s.customer_refunds.0.checked_add(j.fee.0).unwrap();
            });
            (j.requester,j.fee.0)
        }else{
            let mut j=scout_jobs().get(&key).unwrap_or_else(||env::panic_str("Unknown job"));
            require!(j.status=="REQUESTED","Job already settled");
            j.status="FAILED".into(); scout_jobs().insert(&key,&j);
            (j.requester,j.fee.0)
        };
        if let Some(mut op)=self.operations.get(&key){op.status=OpStatus::Failed;self.operations.insert(&key,&op);}
        a.pending_op=None; self.agents.insert(&token_id,&a);
        let storage=charge_storage_to_agent(&token_id);
        credit_job_refund(&token_id,id,&requester,fee);
        event("service_job_cancelled",serde_json::json!({"token_id":token_id,"id":id,"refund_credit":U128(fee),"storage_fee":U128(storage)}));
    }
    pub fn service_forfeits(&self,service_id:String)->U128{U128(forfeits().get(&service_id).unwrap_or(0))}
    pub fn owner_memory_receipt(&self, token_id: TokenId, id: u64) -> Option<serde_json::Value> {
        // Views cannot authenticate a caller. This exposes only public commitments.
        let j = paid_jobs().get(&op_key(&token_id,id))?;
        require!(j.status == "FINALIZED", "Memory is not final");
        Some(serde_json::json!({"project":projects().get(&token_id),"job_id":id,
            "output_hash":j.output_hash,"output_uri":j.output_uri}))
    }

    #[payable]
    pub fn recall_owner_memory(&mut self, token_id: TokenId, job_id:u64,
        deposit:U128) -> Promise {
        let mut a=self.active_owner(&token_id);
        let j=paid_jobs().get(&op_key(&token_id,job_id)).unwrap_or_else(||env::panic_str("No paid job"));
        let p=projects().get(&token_id).unwrap_or_else(||env::panic_str("No project"));
        require!(j.status=="FINALIZED" && p.state=="READY" && deposit.0>0
            && deposit.0<=MAX_JOB_DEPOSIT && env::attached_deposit().as_yoctonear()==deposit.0,"Recall requires finalized memory and exact funding");
        let id=a.next_op_id;a.next_op_id+=1;a.pending_op=Some(id);self.agents.insert(&token_id,&a);
        add_liability(deposit.0);
        recall_started().insert(&op_key(&token_id,id),&env::block_timestamp());
        recalls().insert(&op_key(&token_id,id),&RecallRequest{id,job_id,
            owner:env::predecessor_account_id(),deposit,output_hash:j.output_hash.clone().unwrap(),
            summary:None,state:"EXECUTING".into(),reimbursement_pending:false});
        ol_call(a.vault_id,"recall_skill",serde_json::json!({"id":id,"job_id":job_id,
            "version_key":p.version_key,"output_hash":j.output_hash,"limits":j.limits,
            "deposit":deposit,"service_id":job_services().get(&op_key(&token_id,job_id))
                .map(|s|s.service_id).unwrap_or_else(||"scout".into())}),175)
    }

    pub fn on_outlayer_recall(&mut self, token_id:TokenId,id:u64,job_id:u64,
        result:Option<serde_json::Value>)->PromiseOrValue<bool> {
        let a=self.agents.get(&token_id).unwrap();let mut recall=recalls().get(&op_key(&token_id,id)).unwrap();
        require!(env::predecessor_account_id()==a.vault_id && a.pending_op==Some(id)
            && recall.job_id==job_id && recall.state=="EXECUTING","Recall mismatch");
        let Some(v)=result else {recall.state="UNCERTAIN".into();recalls().insert(&op_key(&token_id,id),&recall);return PromiseOrValue::Value(false)};
        let summary=v.get("summary").and_then(|x|x.as_str()).unwrap_or("");
        if v.get("schemaVersion").and_then(|x|x.as_u64())!=Some(1)
            || v.get("jobId").and_then(|x|x.as_u64())!=Some(job_id)
            || v.get("status").and_then(|x|x.as_str())!=Some("ok")
            || v.get("outputHash").and_then(|x|x.as_str())!=Some(recall.output_hash.as_str())
            || summary.len()>220 {
            recall.state="UNCERTAIN".into();recalls().insert(&op_key(&token_id,id),&recall);return PromiseOrValue::Value(false);
        }
        recall.summary=Some(summary.into());recall.state="RECONCILING".into();recall.reimbursement_pending=true;
        recalls().insert(&op_key(&token_id,id),&recall);
        PromiseOrValue::Promise(Promise::new(a.vault_id).transfer(NearToken::from_yoctonear(recall.deposit.0))
            .then(ol_callback("on_recall_replenished",&token_id,id)))
    }

    #[private]
    pub fn on_recall_replenished(&mut self,token_id:TokenId,id:u64)->PromiseOrValue<bool>{
        let mut a=self.agents.get(&token_id).unwrap();let mut recall=recalls().get(&op_key(&token_id,id)).unwrap();
        require!(a.pending_op==Some(id) && recall.state=="RECONCILING" && recall.reimbursement_pending,"Wrong recall reimbursement");
        if env::promise_results_count()!=1{return PromiseOrValue::Value(false)}
        match env::promise_result_checked(0,32){
            Ok(_)=>{},
            Err(PromiseError::Failed)=>{recall.reimbursement_pending=false;recalls().insert(&op_key(&token_id,id),&recall);return PromiseOrValue::Value(false)},
            Err(_)=>return PromiseOrValue::Value(false),
        }
        recall.state="FINALIZED".into();recall.reimbursement_pending=false;recalls().insert(&op_key(&token_id,id),&recall);
        release_liability(recall.deposit.0);
        event("memory_recalled",serde_json::json!({"token_id":token_id,"id":id,"job_id":recall.job_id,
            "output_hash":recall.output_hash}));
        a.pending_op=None;self.agents.insert(&token_id,&a);
        PromiseOrValue::Promise(ol_call(a.vault_id,"ack_recall",serde_json::json!({"id":id}),15))
    }

    pub fn retry_recall_replenishment(&mut self,token_id:TokenId,id:u64)->Promise{
        let a=self.agents.get(&token_id).unwrap();let mut recall=recalls().get(&op_key(&token_id,id)).unwrap();
        require!(a.pending_op==Some(id) && recall.state=="RECONCILING" && !recall.reimbursement_pending,"Recall not retryable");
        recall.reimbursement_pending=true;recalls().insert(&op_key(&token_id,id),&recall);
        Promise::new(a.vault_id).transfer(NearToken::from_yoctonear(recall.deposit.0))
            .then(ol_callback("on_recall_replenished",&token_id,id))
    }

    /// Permissionless. Ends a recall whose OutLayer callback returned without a usable
    /// result (recall is read-only, so nothing can change afterwards). The deposit is
    /// credited back to the owner who paid it.
    pub fn release_recall(&mut self,token_id:TokenId,id:u64)->Promise{
        let a=self.agents.get(&token_id).unwrap_or_else(||env::panic_str("Unknown agent"));
        let r=recalls().get(&op_key(&token_id,id)).unwrap_or_else(||env::panic_str("Unknown recall"));
        require!(recall_releasable(&a,&r,recall_started().get(&op_key(&token_id,id)),id),"Recall is not releasable");
        ol_call(a.vault_id,"release_recall",serde_json::json!({"id":id}),15)
            .then(ol_callback("on_recall_released",&token_id,id))
    }
    #[private]
    pub fn on_recall_released(&mut self,token_id:TokenId,id:u64)->bool{
        let mut a=self.agents.get(&token_id).unwrap();let key=op_key(&token_id,id);
        let mut r=recalls().get(&key).unwrap();
        if !recall_releasable(&a,&r,recall_started().get(&key),id){return false}
        if !matches!(env::promise_result_checked(0,16),Ok(ref b) if b==b"true"){return false}
        r.state="FAILED".into();recalls().insert(&key,&r);
        a.pending_op=None;self.agents.insert(&token_id,&a);
        let mut payout=payouts().get(&r.owner).unwrap_or_default();
        payout.available.0=payout.available.0.checked_add(r.deposit.0).unwrap();payouts().insert(&r.owner,&payout);
        event("recall_released",serde_json::json!({"token_id":token_id,"id":id,"refund_credit":r.deposit}));
        true
    }

    pub fn owner_recall_result(&self,token_id:TokenId,id:u64)->Option<serde_json::Value>{
        // Execution is owner-gated; NEAR transaction outputs and view receipts are public.
        let recall=recalls().get(&op_key(&token_id,id))?;
        require!(recall.state=="FINALIZED","Recall not finalized");
        Some(serde_json::json!({"job_id":recall.job_id,"output_hash":recall.output_hash,
            "summary":recall.summary}))
    }
}

#[cfg(test)]
pub(crate) mod tests_support{
    use super::*;
    pub fn fault(service:&str,output:&serde_json::Value)->&'static str{failure_fault(service,output)}
    pub fn ready_key(token_id:&str,epoch:u64){payment_key_setups().insert(&token_id.to_string(),&PaymentKeySetup{
        epoch,nonce:1,ciphertext_hash:"a".repeat(64),expires_at_ns:u64::MAX,operation_id:None,state:"READY".into()});}
}

// Tests reach the shared request path directly; customers use `request_reviewed_service_job`.
#[cfg(test)]
impl Registry {
    /// Test shortcut: clear a started job's slot (state assertions happen before this).
    pub fn cancel_unstarted_job_for_tests(&mut self,token_id:TokenId,id:u64){
        let mut a=self.agents.get(&token_id).unwrap();if a.pending_op==Some(id){a.pending_op=None;self.agents.insert(&token_id,&a);}
    }
    pub fn request_paid_scout(&mut self, token_id: TokenId, input_hash: String,
        deadline_ns: u64, fee: U128, replenish: U128, deposit_cap: U128, limits: SkillLimits) -> u64 {
        self.request_job(&token_id,"scout",input_hash,deadline_ns,fee,replenish,deposit_cap,limits,None)
    }
    pub fn request_service_job(&mut self,token_id:TokenId,service_id:String,input_hash:String,
        deadline_ns:u64,fee:U128,replenish:U128,deposit_cap:U128,limits:SkillLimits)->u64{
        require!(service_id!="research","Reviewed research quote required");
        self.request_job(&token_id,&service_id,input_hash,deadline_ns,fee,replenish,deposit_cap,limits,None)
    }
}
