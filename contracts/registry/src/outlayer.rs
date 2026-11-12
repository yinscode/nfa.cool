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

fn projects() -> LookupMap<TokenId, OutlayerProject> { LookupMap::new(&b"OLP"[..]) }
fn paid_jobs() -> LookupMap<String, PaidJob> { LookupMap::new(&b"OLJ"[..]) }
fn ledgers() -> LookupMap<u8, PaidLedger> { LookupMap::new(&b"OLL"[..]) }
fn recalls() -> LookupMap<String, RecallRequest> { LookupMap::new(&b"OLR"[..]) }
fn recall_started()->LookupMap<String,u64>{LookupMap::new(&b"OLRT"[..])}
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
        self.request_job(&token_id,&service_id,input_hash,deadline_ns,fee,replenish,deposit_cap,limits)
    }

    // Customers pay for a job but do not choose its resources: limits are the owner's
    // policy limits exactly, and the execution deposit has a floor. A customer-chosen
    // 1-instruction or 1-yocto execution would otherwise force an unresolvable result.
    fn request_job(&mut self,token_id:&TokenId,service_id:&str,input_hash:String,
        deadline_ns:u64,fee:U128,replenish:U128,deposit_cap:U128,limits:SkillLimits)->u64{
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
            && env::attached_deposit().as_yoctonear() == fee.0,"Invalid paid job quote");
        require!(valid_limits(&limits),"Resource cap");
        require!(deadline_ns > env::block_timestamp() && deadline_ns.saturating_sub(env::block_timestamp()) <= START_WINDOW_NS,"Start deadline must be within 30 minutes");
        require!(fee.0-replenish.0>=job_storage_fee(),"Margin must cover job storage");
        let id = a.next_op_id;
        if service_id=="research"{self.reserve_research(token_id,id,&p.version_key,&env::predecessor_account_id())}
        add_liability(fee.0);
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
        event("service_job_requested",serde_json::json!({"token_id":token_id,"id":id,"service_id":service_id,
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
            let mut payout = payouts().get(&j.requester).unwrap_or_default();
            payout.available.0 = payout.available.0.checked_add(j.fee.0).unwrap(); payouts().insert(&j.requester,&payout);
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
            let mut payout=payouts().get(&j.requester).unwrap_or_default();
            payout.available.0=payout.available.0.checked_add(remainder).unwrap(); payouts().insert(&j.requester,&payout);
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
        let mut payout=payouts().get(&j.requester).unwrap_or_default();
        payout.available.0=payout.available.0.checked_add(refund).unwrap();payouts().insert(&j.requester,&payout);
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
        let mut payout=payouts().get(&requester).unwrap_or_default();
        payout.available.0=payout.available.0.checked_add(fee).unwrap();payouts().insert(&requester,&payout);
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
pub(crate) mod tests_support{pub fn fault(service:&str,output:&serde_json::Value)->&'static str{super::failure_fault(service,output)}}

// Tests reach the shared request path directly; customers use `request_reviewed_service_job`.
#[cfg(test)]
impl Registry {
    /// Test shortcut: clear a started job's slot (state assertions happen before this).
    pub fn cancel_unstarted_job_for_tests(&mut self,token_id:TokenId,id:u64){
        let mut a=self.agents.get(&token_id).unwrap();if a.pending_op==Some(id){a.pending_op=None;self.agents.insert(&token_id,&a);}
    }
    pub fn request_paid_scout(&mut self, token_id: TokenId, input_hash: String,
        deadline_ns: u64, fee: U128, replenish: U128, deposit_cap: U128, limits: SkillLimits) -> u64 {
        self.request_job(&token_id,"scout",input_hash,deadline_ns,fee,replenish,deposit_cap,limits)
    }
    pub fn request_service_job(&mut self,token_id:TokenId,service_id:String,input_hash:String,
        deadline_ns:u64,fee:U128,replenish:U128,deposit_cap:U128,limits:SkillLimits)->u64{
        require!(service_id!="research","Reviewed research quote required");
        self.request_job(&token_id,&service_id,input_hash,deadline_ns,fee,replenish,deposit_cap,limits)
    }
}
