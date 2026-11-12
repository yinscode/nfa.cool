use near_sdk::{env, json_types::{Base64VecU8, U128}, near, require, AccountId, Gas, NearToken, Promise, PromiseOrValue};
use near_sdk::collections::LookupMap;
use sha3::{Digest, Keccak256};

const SIGNER: &str = "v1.signer-prod.testnet";
const PATH: &str = "eth-sepolia-v1";
const CHAIN_ID: u64 = 11_155_111;
const GAS_LIMIT: u64 = 21_000;
const MAX_FEE: u64 = 100_000_000_000;
const MAX_VALUE: u128 = 1_000_000_000_000_000_000;
const NEAR_RESERVE: u128 = 100_000_000_000_000_000_000_000;
#[cfg(not(feature = "sandbox-outlayer"))]
const OUTLAYER: &str = "outlayer.testnet";
#[cfg(feature = "sandbox-outlayer")]
const OUTLAYER: &str = "outlayer.test.near";
const PROJECT_NAME: &str = "scout";
const MAX_PROJECT_DEPOSIT: u128 = 500_000_000_000_000_000_000_000;
const MAX_JOB_DEPOSIT: u128 = 500_000_000_000_000_000_000_000;
const MAX_DAILY_DEPOSITS: u128 = 2_000_000_000_000_000_000_000_000;
const DAY_NS: u64 = 86_400_000_000_000;

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct DailyBudget { pub day:u64, pub deposits:u128 }
fn daily_budget()->LookupMap<u8,DailyBudget>{LookupMap::new(&b"outlayer:day:v1"[..])}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct SkillLimits { pub max_instructions: u64, pub max_memory_mb: u32, pub max_execution_seconds: u64 }
#[near(serializers=[borsh,json])]
#[derive(Clone)]
pub struct SecretsReference {pub account_id:AccountId,pub profile:String}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct ProjectRecord { pub project_id: String, pub project_uuid: String, pub version_key: String,
    pub wasm_url: String, pub state: String }

fn project() -> LookupMap<u8, ProjectRecord> { LookupMap::new(&b"outlayer:project:v1"[..]) }
// Separate prefixes keep the deployed root `Vault` and `Pending` Borsh layout unchanged.
fn last_near() -> LookupMap<u8, (u64, bool)> { LookupMap::new(&b"near:last:v1"[..]) }
/// Earlier signed transactions for one EVM nonce. A replacement keeps every prior
/// signature visible: any of them may still be mined until the nonce is consumed.
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct EvmCandidate { pub digest: [u8; 32], pub unsigned: Vec<u8>, pub signature: Vec<u8> }
fn candidate_store() -> LookupMap<u64, Vec<EvmCandidate>> { LookupMap::new(&b"evm:candidates:v1"[..]) }
const MAX_EVM_CANDIDATES: usize = 8;
/// A guardian upgrade without the owner's approval waits this long after its proposal.
const UPGRADE_DELAY_NS: u64 = 7 * DAY_NS;
/// An owner approval of a proposed upgrade expires, so it cannot outlive a quick sale.
const APPROVAL_TTL_NS: u64 = DAY_NS;
/// A proposed vault code hash, visible in `status` to owners and buyers.
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct UpgradeProposal { pub code_hash: String, pub proposed_at_ns: u64, pub approved_at_ns: Option<u64> }
fn upgrade_store() -> LookupMap<u8, UpgradeProposal> { LookupMap::new(&b"upgrade:proposal:v1"[..]) }
fn rejected<T>() -> PromiseOrValue<T> where T: Default { PromiseOrValue::Value(T::default()) }
fn rejection() -> PromiseOrValue<serde_json::Value> { PromiseOrValue::Value(serde_json::json!("rejected")) }
fn valid_hash(hash: &str) -> bool { hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit()) }
fn valid_url(url: &str) -> bool { url.starts_with("https://") && url.len() <= 300
    && !url.contains('@') && !url.contains('#') && !url.bytes().any(|b| b.is_ascii_whitespace()) }
fn source(url: &str, hash: &str) -> serde_json::Value {
    serde_json::json!({"WasmUrl":{"url":url,"hash":hash,"build_target":"wasm32-wasip2"}})
}

#[derive(Clone)]
#[near(serializers = [borsh, json])]
pub enum Pending {
    Near { id: u64, recipient: AccountId, amount: u128 },
    Evm { id: u64, nonce: u64, digest: [u8; 32], unsigned: Vec<u8>, signature: Option<Vec<u8>>, uncertain: bool },
    Project { id: u64, action: String, version: String, uncertain: bool },
    Skill { id: u64, version: String, deposit: u128, reported: bool, uncertain: bool },
    Recall { id: u64, job_id: u64, reported: bool, uncertain: bool },
}

#[near(contract_state)]
pub struct Vault {
    controller: AccountId,
    reporter: AccountId,
    guardian: AccountId,
    next_operation_id: u64,
    next_evm_nonce: u64,
    pending: Option<Pending>,
    last_receipt: Option<(u64, String, u64, bool)>,
}

impl Default for Vault { fn default() -> Self { env::panic_str("Uninitialized vault") } }

#[near]
impl Vault {
    #[init]
    pub fn new(controller: AccountId, reporter: AccountId, guardian: AccountId) -> Self {
        require!(!env::state_exists(), "Already initialized");
        Self { controller, reporter, guardian, next_operation_id: 1, next_evm_nonce: 0,
            pending: None, last_receipt: None }
    }

    /// A rejected precondition returns `false` without starting the operation, so the
    /// registry can record a definite failure instead of an unresolvable panic.
    pub fn send_near(&mut self, id: u64, recipient: AccountId, amount: U128) -> PromiseOrValue<bool> {
        self.assert_controller();
        let storage = u128::from(env::storage_usage()) * env::storage_byte_cost().as_yoctonear();
        if self.pending.is_some() || id < self.next_operation_id || recipient == env::current_account_id()
            || amount.0 == 0 || env::account_balance().as_yoctonear() < storage.saturating_add(NEAR_RESERVE).saturating_add(amount.0) {
            env::log_str("NFA_NEAR_TRANSFER_REJECTED");
            return rejected();
        }
        self.begin(id);
        self.pending = Some(Pending::Near { id, recipient: recipient.clone(), amount: amount.0 });
        PromiseOrValue::Promise(Promise::new(recipient).transfer(NearToken::from_yoctonear(amount.0)).then(
            Promise::new(env::current_account_id()).function_call("on_near_transfer".to_string(),
                serde_json::json!({"id":id}).to_string().into_bytes(), NearToken::from_yoctonear(0), Gas::from_tgas(10))))
    }

    pub fn create_project(&mut self, id: u64, wasm_url: String, version_key: String,
        deposit: U128) -> Promise {
        self.assert_controller();
        require!(project().get(&0).is_none(), "Project already provisioned or unresolved");
        require!(valid_url(&wasm_url) && valid_hash(&version_key), "Invalid immutable source");
        require!(deposit.0 > 0 && deposit.0 <= MAX_PROJECT_DEPOSIT, "Project deposit cap");
        self.check_balance(deposit.0); self.begin(id);
        let project_id = format!("{}/{}", env::current_account_id(), PROJECT_NAME);
        project().insert(&0, &ProjectRecord { project_id, project_uuid: String::new(),
            version_key: version_key.clone(), wasm_url: wasm_url.clone(), state: "CREATING".into() });
        self.pending = Some(Pending::Project { id, action: "create".into(), version: version_key.clone(), uncertain: false });
        self.call_outlayer("create_project", serde_json::json!({"name":PROJECT_NAME,
            "source":source(&wasm_url,&version_key)}), deposit.0, 40, "on_project_write", id, 60)
    }

    pub fn add_version(&mut self, id: u64, wasm_url: String, version_key: String,
        deposit: U128) -> Promise {
        self.assert_controller();
        let p = project().get(&0).unwrap_or_else(|| env::panic_str("No project"));
        require!(p.state == "READY" && valid_url(&wasm_url) && valid_hash(&version_key), "Project/source unavailable");
        require!(deposit.0 > 0 && deposit.0 <= MAX_PROJECT_DEPOSIT, "Version deposit cap");
        self.check_balance(deposit.0); self.begin(id);
        self.pending = Some(Pending::Project { id, action: "add".into(), version: version_key.clone(), uncertain: false });
        self.call_outlayer("add_version", serde_json::json!({"project_name":PROJECT_NAME,
            "source":source(&wasm_url,&version_key),"set_active":false}), deposit.0, 40, "on_project_write", id, 60)
    }

    pub fn set_active_version(&mut self, id: u64, version_key: String) -> Promise {
        self.assert_controller();
        let p = project().get(&0).unwrap_or_else(|| env::panic_str("No project"));
        require!(p.state == "READY" && valid_hash(&version_key), "Project/version unavailable");
        self.begin(id);
        self.pending = Some(Pending::Project { id, action: "activate".into(), version: version_key.clone(), uncertain: false });
        self.call_outlayer("set_active_version", serde_json::json!({"project_name":PROJECT_NAME,
            "version_key":version_key}), 0, 20, "on_project_write", id, 60)
    }

    #[private]
    pub fn on_project_write(&mut self, id: u64) -> PromiseOrValue<Option<ProjectRecord>> {
        let Some(Pending::Project { id: current, uncertain, .. }) = &mut self.pending else { env::panic_str("No project write") };
        require!(*current == id, "Wrong project callback");
        if env::promise_result_checked(0, 2048).is_err() {
            *uncertain = true;
            if let Some(mut p) = project().get(&0) { p.state = "UNCERTAIN".into(); project().insert(&0,&p); }
            return PromiseOrValue::Value(None);
        }
        let project_id = project().get(&0).unwrap().project_id;
        PromiseOrValue::Promise(self.call_outlayer("get_project", serde_json::json!({"project_id":project_id}),
            0, 20, "on_project_verified", id, 25))
    }

    #[private]
    pub fn on_project_verified(&mut self, id: u64) -> Option<ProjectRecord> {
        let Some(Pending::Project { id: current, action, version, .. }) = &self.pending else { env::panic_str("No project verification") };
        require!(*current == id, "Wrong verification callback");
        let action = action.clone(); let version = version.clone();
        let Ok(bytes) = env::promise_result_checked(0, 8192) else { self.mark_project_uncertain(); return None };
        let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) else { self.mark_project_uncertain(); return None };
        let mut p = project().get(&0).unwrap();
        let uuid = value.get("project_uuid").or_else(||value.get("uuid")).and_then(|x|x.as_str()).unwrap_or("");
        let observed_id=value.get("project_id").or_else(||value.get("id")).and_then(|x|x.as_str()).unwrap_or("");
        if observed_id!=p.project_id || uuid.is_empty() || uuid.len() > 80
            || (!p.project_uuid.is_empty() && p.project_uuid != uuid) {
            self.mark_project_uncertain(); return None;
        }
        p.project_uuid = uuid.into();
        if action == "create" || action == "activate" { p.version_key = version; }
        p.state = "READY".into(); project().insert(&0, &p);
        self.pending = None;
        Some(p)
    }

    pub fn reconcile_project(&mut self, id: u64) -> Promise {
        self.assert_controller();
        require!(matches!(&self.pending,Some(Pending::Project { id: current, uncertain: true, .. }) if *current == id),"No uncertain project write");
        let project_id = project().get(&0).unwrap().project_id;
        self.call_outlayer("get_project",serde_json::json!({"project_id":project_id}),
            0,20,"on_project_verified",id,25)
    }

    pub fn execute_skill(&mut self, id: u64, version_key: String, input_data: String,
        limits: SkillLimits, deposit: U128) -> Promise {
        self.execute_internal(id,version_key,input_data,limits,deposit,None)
    }

    pub fn execute_research_skill(&mut self,id:u64,version_key:String,input_data:String,
        limits:SkillLimits,deposit:U128,secrets_ref:SecretsReference)->Promise{
        self.assert_controller();
        let value:serde_json::Value=serde_json::from_str(&input_data).unwrap_or_else(|_|env::panic_str("Invalid research input"));
        require!(value["operation"]=="run"&&value["service"]=="research"&&value["jobId"]==id&&
            value["context"]["vaultAccountId"]==env::current_account_id().as_str()&&
            value["context"]["registryAccountId"]==self.controller.as_str()&&
            value["research"]["settings"]["version_key"]==version_key&&
            value["research"]["settings"]["secrets_ref"]["account_id"]==secrets_ref.account_id.as_str()&&
            value["research"]["settings"]["secrets_ref"]["profile"]==secrets_ref.profile,"Research context or secret reference mismatch");
        require!(!secrets_ref.profile.is_empty()&&secrets_ref.profile.len()<=32,"Invalid research secret profile");
        self.execute_internal(id,version_key,input_data,limits,deposit,Some(secrets_ref))
    }

    fn execute_internal(&mut self,id:u64,version_key:String,input_data:String,limits:SkillLimits,
        deposit:U128,secrets_ref:Option<SecretsReference>)->Promise{
        self.assert_controller();
        let p = project().get(&0).unwrap_or_else(|| env::panic_str("No OutLayer project"));
        require!(p.state == "READY" && p.version_key == version_key && !p.project_uuid.is_empty(), "Unapproved version");
        require!(input_data.len() <= 8_192 && serde_json::from_str::<serde_json::Value>(&input_data).is_ok(), "Invalid job input");
        require!(limits.max_instructions > 0 && limits.max_instructions <= 2_000_000_000
            && limits.max_memory_mb > 0 && limits.max_memory_mb <= 128
            && limits.max_execution_seconds > 0 && limits.max_execution_seconds <= 30, "Resource cap");
        require!(deposit.0 > 0 && deposit.0 <= MAX_JOB_DEPOSIT, "Execution deposit cap");
        self.check_balance(deposit.0); self.begin(id); self.reserve_daily(deposit.0);
        self.pending = Some(Pending::Skill { id, version: version_key.clone(), deposit: deposit.0,
            reported: false, uncertain: false });
        let mut args=serde_json::json!({
            "source":{"Project":{"project_id":p.project_id,"version_key":version_key}},
            "input_data":input_data,"resource_limits":limits,"response_format":"Json"
        });
        if let Some(reference)=secrets_ref{args["secrets_ref"]=serde_json::to_value(reference).unwrap();}
        self.call_outlayer("request_execution",args, deposit.0, 80, "on_skill_execution", id, 75)
    }

    #[private]
    pub fn on_skill_execution(&mut self, id: u64) -> Promise {
        let Some(Pending::Skill { id: current, reported, uncertain, .. }) = &mut self.pending else { env::panic_str("No skill request") };
        require!(*current == id && !*reported, "Wrong skill callback");
        let result = env::promise_result_checked(0, 2048);
        let output = result.ok().and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok());
        // An unparseable or failed callback is unresolved until reconciled against OutLayer.
        *uncertain = output.is_none(); *reported = true;
        self.call_registry("on_outlayer_job", serde_json::json!({"token_id":self.token_id(),"id":id,
            "result":output}), 60)
    }

    /// Clear a skill whose OutLayer callback already returned (or that never began).
    /// After that callback no execution result can reach the vault or registry again.
    pub fn release_skill(&mut self, id: u64) -> bool {
        self.assert_controller();
        match &self.pending {
            Some(Pending::Skill { id: current, reported: true, .. }) if *current == id => {
                self.pending = None; env::log_str("NFA_SKILL_RELEASED"); true
            }
            None => true,
            _ => false,
        }
    }

    pub fn ack_skill(&mut self, id: u64) {
        self.assert_controller();
        require!(matches!(self.pending, Some(Pending::Skill { id: current, reported: true, uncertain: false, .. }) if current == id), "Skill not settled");
        self.pending = None;
    }

    pub fn recall_skill(&mut self, id: u64, job_id: u64, version_key: String,
        output_hash: String, limits: SkillLimits, deposit: U128,
        service_id: Option<String>) -> Promise {
        self.assert_controller();
        let p=project().get(&0).unwrap_or_else(||env::panic_str("No project"));
        let service_id=service_id.unwrap_or_else(||"scout".into());
        require!(matches!(service_id.as_str(),"scout"|"compare"|"research"),"Unknown service");
        require!(p.state=="READY" && p.version_key==version_key && output_hash.starts_with("sha256:")
            && valid_hash(&output_hash[7..]) && job_id>0,"Invalid finalized memory commitment");
        require!(limits.max_instructions>0 && limits.max_instructions<=2_000_000_000
            && limits.max_memory_mb>0 && limits.max_memory_mb<=128
            && limits.max_execution_seconds>0 && limits.max_execution_seconds<=30,"Resource cap");
        require!(deposit.0>0 && deposit.0<=MAX_JOB_DEPOSIT,"Recall deposit cap");
        self.check_balance(deposit.0); self.begin(id); self.reserve_daily(deposit.0);
        self.pending=Some(Pending::Recall{id,job_id,reported:false,uncertain:false});
        self.call_outlayer("request_execution",serde_json::json!({
            "source":{"Project":{"project_id":p.project_id,"version_key":version_key}},
            "input_data":serde_json::json!({"operation":"recall","service":service_id,
                "jobId":job_id,"expectedHash":output_hash}).to_string(),
            "resource_limits":limits,"response_format":"Json"}),deposit.0,80,"on_recall_execution",id,75)
    }

    #[private]
    pub fn on_recall_execution(&mut self, id:u64)->Promise {
        let Some(Pending::Recall{id:current,job_id,reported,uncertain})=&mut self.pending else{env::panic_str("No recall")};
        require!(*current==id && !*reported,"Wrong recall callback");
        let job_id=*job_id;
        let result=env::promise_result_checked(0,2048).ok()
            .and_then(|b|serde_json::from_slice::<serde_json::Value>(&b).ok());
        *uncertain=result.is_none();*reported=true;
        self.call_registry("on_outlayer_recall",serde_json::json!({"token_id":self.token_id(),
            "id":id,"job_id":job_id,"result":result}),60)
    }

    /// Clear a recall whose OutLayer callback already returned (or that never began).
    pub fn release_recall(&mut self, id: u64) -> bool {
        self.assert_controller();
        match &self.pending {
            Some(Pending::Recall { id: current, reported: true, .. }) if *current == id => {
                self.pending = None; env::log_str("NFA_RECALL_RELEASED"); true
            }
            None => true,
            _ => false,
        }
    }

    pub fn ack_recall(&mut self,id:u64){
        self.assert_controller();
        require!(matches!(self.pending,Some(Pending::Recall{id:current,reported:true,uncertain:false,..}) if current==id),"Recall not settled");
        self.pending=None;
    }

    pub fn outlayer_status(&self) -> serde_json::Value {
        let budget=daily_budget().get(&0);
        serde_json::json!({"project":project().get(&0),"pending":self.pending_json(),
            "available":self.treasury().get("available").cloned(),
            "daily_budget":budget.map(|b|serde_json::json!({"day":b.day,"deposits":b.deposits.to_string()})),
            "daily_cap":MAX_DAILY_DEPOSITS.to_string(),"storage_account":"predecessor"})
    }

    fn mark_project_uncertain(&mut self) {
        if let Some(Pending::Project { uncertain, .. }) = &mut self.pending { *uncertain = true; }
        if let Some(mut p) = project().get(&0) { p.state = "UNCERTAIN".into(); project().insert(&0, &p); }
    }
    fn check_balance(&self, amount: u128) {
        let storage = u128::from(env::storage_usage()) * env::storage_byte_cost().as_yoctonear();
        require!(env::account_balance().as_yoctonear() >= storage.saturating_add(NEAR_RESERVE).saturating_add(amount), "Vault runway");
    }
    fn reserve_daily(&self,amount:u128){
        let day=env::block_timestamp()/DAY_NS;
        let mut budget=daily_budget().get(&0).filter(|b|b.day==day)
            .unwrap_or(DailyBudget{day,deposits:0});
        budget.deposits=budget.deposits.checked_add(amount).unwrap();
        require!(budget.deposits<=MAX_DAILY_DEPOSITS,"Daily OutLayer deposit cap");
        daily_budget().insert(&0,&budget);
    }
    fn call_outlayer(&self, method: &str, args: serde_json::Value, deposit: u128, gas: u64, callback: &str, id: u64, callback_gas:u64) -> Promise {
        Promise::new(OUTLAYER.parse().unwrap()).function_call(method.to_string(),args.to_string().into_bytes(),
            NearToken::from_yoctonear(deposit),Gas::from_tgas(gas)).then(
            Promise::new(env::current_account_id()).function_call(callback.to_string(),
                serde_json::json!({"id":id}).to_string().into_bytes(),NearToken::from_yoctonear(0),Gas::from_tgas(callback_gas)))
    }
    fn call_registry(&self, method: &str, args: serde_json::Value, gas: u64) -> Promise {
        Promise::new(self.controller.clone()).function_call(method.to_string(), args.to_string().into_bytes(),
            NearToken::from_yoctonear(0),Gas::from_tgas(gas))
    }
    fn token_id(&self) -> String { env::current_account_id().as_str().split('.').next().unwrap_or("").into() }

    #[private]
    pub fn on_near_transfer(&mut self, id: u64) -> bool {
        require!(matches!(&self.pending, Some(Pending::Near { id: current, .. }) if *current == id), "Wrong pending operation");
        let ok = env::promise_result_checked(0, 1024).is_ok();
        self.pending = None; last_near().insert(&0, &(id, ok));
        env::log_str(if ok { "NFA_NEAR_TRANSFER_FINALIZED" } else { "NFA_NEAR_TRANSFER_FAILED" });
        ok
    }

    /// Returns the signer promise, or the JSON string `"rejected"` when no signature
    /// was requested (the registry then records a definite failure).
    pub fn request_evm_transfer(&mut self, id: u64, nonce: u64, recipient_hex: String,
        value_wei: U128, priority_fee: u64, max_fee: u64) -> PromiseOrValue<serde_json::Value> {
        self.assert_controller();
        if self.pending.is_some() || id < self.next_operation_id || nonce != self.next_evm_nonce
            || value_wei.0 == 0 || value_wei.0 > MAX_VALUE || !valid_fees(priority_fee, max_fee)
            || !valid_address(&recipient_hex) {
            env::log_str("NFA_EVM_REQUEST_REJECTED");
            return rejection();
        }
        self.begin(id);
        let unsigned = unsigned_eip1559(nonce, priority_fee, max_fee, &decode20(&recipient_hex), value_wei.0);
        let digest: [u8; 32] = Keccak256::digest(&unsigned).into();
        self.pending = Some(Pending::Evm { id, nonce, digest, unsigned, signature: None, uncertain: false });
        PromiseOrValue::Promise(self.sign(id, &digest))
    }

    /// Retry the signer for the identical digest after an uncertain signer result.
    /// Any signature over the same digest authorizes exactly the same transaction.
    pub fn resign_evm(&mut self, id: u64) -> PromiseOrValue<serde_json::Value> {
        self.assert_controller();
        let digest = match &mut self.pending {
            Some(Pending::Evm { id: current, signature: None, uncertain, digest, .. }) if *current == id && *uncertain => {
                *uncertain = false; *digest
            }
            _ => return rejection(),
        };
        PromiseOrValue::Promise(self.sign(id, &digest))
    }

    /// Sign a replacement at the same nonce (higher fees, or a zero-value self-send to
    /// cancel). Prior signatures stay recorded because they remain valid until the nonce
    /// is consumed; the registry checks the fee bump and the cancel recipient.
    pub fn replace_evm(&mut self, id: u64, recipient_hex: String, value_wei: U128,
        priority_fee: u64, max_fee: u64) -> PromiseOrValue<serde_json::Value> {
        self.assert_controller();
        let Some(Pending::Evm { id: current, nonce, digest, unsigned, signature: Some(signature), uncertain: false }) = self.pending.clone()
            else { return rejection() };
        let mut previous = candidate_store().get(&nonce).unwrap_or_default();
        if current != id || value_wei.0 > MAX_VALUE || !valid_fees(priority_fee, max_fee)
            || !valid_address(&recipient_hex) || previous.len() >= MAX_EVM_CANDIDATES { return rejection() }
        previous.push(EvmCandidate { digest, unsigned, signature });
        candidate_store().insert(&nonce, &previous);
        let unsigned = unsigned_eip1559(nonce, priority_fee, max_fee, &decode20(&recipient_hex), value_wei.0);
        let digest: [u8; 32] = Keccak256::digest(&unsigned).into();
        self.pending = Some(Pending::Evm { id, nonce, digest, unsigned, signature: None, uncertain: false });
        env::log_str("NFA_EVM_REPLACEMENT_REQUESTED");
        PromiseOrValue::Promise(self.sign(id, &digest))
    }

    pub fn evm_candidates(&self, nonce: u64) -> Vec<EvmCandidate> { candidate_store().get(&nonce).unwrap_or_default() }

    fn sign(&self, id: u64, digest: &[u8; 32]) -> Promise {
        let args = serde_json::json!({"request":{"path":PATH,"payload_v2":{"Ecdsa":hex(digest)},"domain_id":0}});
        Promise::new(SIGNER.parse().unwrap()).function_call("sign".to_string(),
            args.to_string().into_bytes(), NearToken::from_yoctonear(1), Gas::from_tgas(30))
            .then(Promise::new(env::current_account_id()).function_call("on_evm_signature".to_string(),
                serde_json::json!({"id":id}).to_string().into_bytes(), NearToken::from_yoctonear(0), Gas::from_tgas(20)))
    }

    #[private]
    pub fn on_evm_signature(&mut self, id: u64) -> bool {
        let Some(Pending::Evm { id: current, signature, uncertain, .. }) = &mut self.pending else { env::panic_str("No EVM request") };
        require!(*current == id && signature.is_none(), "Wrong signature callback");
        match env::promise_result_checked(0, 2048) {
            Ok(bytes) => { *signature = Some(bytes); env::log_str("NFA_EVM_SIGNATURE_READY"); true },
            Err(_) => { *uncertain = true; env::log_str("NFA_EVM_SIGNATURE_UNCERTAIN"); false },
        }
    }

    // Reporter is trusted for the receipt and finality. A timeout or missing tx is not settlement.
    pub fn report_evm_receipt(&mut self, id: u64, tx_hash: String, observed_block: u64, success: bool) {
        require!(env::predecessor_account_id() == self.reporter, "Reporter only");
        require!(tx_hash.len() == 66 && tx_hash.starts_with("0x") && tx_hash[2..].bytes().all(|b| b.is_ascii_hexdigit()), "Invalid hash");
        require!(observed_block > 0, "Missing block");
        let Some(Pending::Evm { id: current, nonce, signature, unsigned, .. }) = &self.pending else { env::panic_str("No signed operation") };
        // A replacement may still be signing while an earlier candidate is mined. The reported
        // hash must be one of the transactions this vault signed for the nonce: the reporter
        // stays trusted for inclusion and finality, but cannot name an unrelated transaction.
        let mut known: Vec<String> = signature.as_ref().and_then(|sig| signed_tx_hash(unsigned, sig)).into_iter().collect();
        known.extend(candidate_store().get(nonce).unwrap_or_default().iter().filter_map(|c| signed_tx_hash(&c.unsigned, &c.signature)));
        require!(!known.is_empty(), "No signed operation");
        require!(known.iter().any(|h| h.eq_ignore_ascii_case(&tx_hash)), "Receipt hash is not a signed candidate");
        require!(*current == id && *nonce == self.next_evm_nonce, "Wrong receipt");
        let nonce = *nonce;
        candidate_store().remove(&nonce);
        self.next_evm_nonce += 1;
        self.last_receipt = Some((nonce, tx_hash, observed_block, success));
        self.pending = None;
        env::log_str("NFA_EVM_RECEIPT_REPORTED");
    }

    /// Guardian proposes exact vault code. It deploys after the NFT owner approves it
    /// through the registry, or after a seven-day delay that owners and buyers can see.
    pub fn propose_upgrade(&mut self, code_hash: String) {
        require!(env::predecessor_account_id() == self.guardian, "Guardian only");
        require!(valid_hash(&code_hash), "Invalid code hash");
        let proposal = UpgradeProposal { code_hash: code_hash.to_ascii_lowercase(), proposed_at_ns: env::block_timestamp(), approved_at_ns: None };
        upgrade_store().insert(&0, &proposal);
        env::log_str(&format!("NFA_VAULT_UPGRADE_PROPOSED:{}", proposal.code_hash));
    }
    /// Registry relays the current NFT owner's approval of the proposed hash.
    pub fn approve_upgrade(&mut self, code_hash: String) {
        self.assert_controller();
        let mut proposal = upgrade_store().get(&0).unwrap_or_else(|| env::panic_str("No proposed upgrade"));
        require!(proposal.code_hash.eq_ignore_ascii_case(&code_hash), "Different proposed code");
        proposal.approved_at_ns = Some(env::block_timestamp());
        upgrade_store().insert(&0, &proposal);
    }
    pub fn cancel_upgrade(&mut self) {
        let caller = env::predecessor_account_id();
        require!(caller == self.guardian || caller == self.controller, "Guardian or controller only");
        upgrade_store().remove(&0);
    }
    pub fn upgrade_proposal(&self) -> Option<UpgradeProposal> { upgrade_store().get(&0) }

    // Trusted recovery authority, now bounded by an owner approval or a public delay.
    pub fn emergency_upgrade(&mut self, code: Base64VecU8) -> Promise {
        require!(env::predecessor_account_id() == self.guardian, "Guardian only");
        require!(!code.0.is_empty() && code.0.len() <= 512_000, "Invalid code size");
        let proposal = upgrade_store().get(&0).unwrap_or_else(|| env::panic_str("Propose the code hash first"));
        require!(hex(&env::sha256(&code.0)) == proposal.code_hash, "Code differs from proposal");
        let now = env::block_timestamp();
        let approved = proposal.approved_at_ns.is_some_and(|t| now <= t.saturating_add(APPROVAL_TTL_NS));
        require!(approved || now >= proposal.proposed_at_ns.saturating_add(UPGRADE_DELAY_NS), "Upgrade needs owner approval or the delay");
        upgrade_store().remove(&0);
        Promise::new(env::current_account_id()).deploy_contract(code.0)
    }

    pub fn status(&self) -> serde_json::Value {
        serde_json::json!({"controller":self.controller,"reporter":self.reporter,"guardian":self.guardian,
            "path":PATH,"chain_id":CHAIN_ID,"next_operation_id":self.next_operation_id,
            "next_evm_nonce":self.next_evm_nonce,"pending":self.pending_json(),"last_receipt":self.last_receipt,"research_interface":1,
            "last_near":last_near().get(&0),"recovery_interface":1,"upgrade_proposal":upgrade_store().get(&0)})
    }

    pub fn treasury(&self) -> serde_json::Value {
        let balance = env::account_balance().as_yoctonear();
        let storage = u128::from(env::storage_usage()) * env::storage_byte_cost().as_yoctonear();
        serde_json::json!({"balance":balance.to_string(),"storage_reserve":storage.to_string(),
            "gas_reserve":NEAR_RESERVE.to_string(),
            "available":balance.saturating_sub(storage.saturating_add(NEAR_RESERVE)).to_string()})
    }

    fn assert_controller(&self) { require!(env::predecessor_account_id() == self.controller, "Controller only"); }
    fn pending_json(&self)->serde_json::Value{
        match &self.pending{
            Some(Pending::Near{id,recipient,amount})=>serde_json::json!({"Near":{"id":id,"recipient":recipient,"amount":amount.to_string()}}),
            Some(Pending::Skill{id,version,deposit,reported,uncertain})=>serde_json::json!({"Skill":{
                "id":id,"version":version,"deposit":deposit.to_string(),"reported":reported,"uncertain":uncertain}}),
            other=>serde_json::to_value(other).unwrap(),
        }
    }
    fn begin(&mut self, id: u64) {
        require!(self.pending.is_none(), "Operation unresolved");
        // Registry IDs also cover off-chain Scout jobs that never call this
        // vault. Accept gaps, but never an old or repeated vault operation.
        require!(id >= self.next_operation_id, "Operation ID replayed");
        self.next_operation_id = id.checked_add(1).unwrap();
    }
}

fn valid_fees(priority_fee: u64, max_fee: u64) -> bool { priority_fee > 0 && priority_fee <= max_fee && max_fee <= MAX_FEE }
fn valid_address(s: &str) -> bool {
    let s = s.strip_prefix("0x").unwrap_or(s); s.len() == 40 && s.bytes().all(|b| b.is_ascii_hexdigit())
}
fn decode_hex(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 { return None }
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok()).collect()
}
/// Ethereum hash of the EIP-1559 transaction `unsigned` signed by an MPC response. It is
/// the same encoding as `services/worker/assemble-evm.mjs`.
fn signed_tx_hash(unsigned: &[u8], signature: &[u8]) -> Option<String> {
    let sig: serde_json::Value = serde_json::from_slice(signature).ok()?;
    let r = decode_hex(sig["big_r"]["affine_point"].as_str()?.get(2..)?)?;
    let s = decode_hex(sig["s"]["scalar"].as_str()?)?;
    let v = sig["recovery_id"].as_u64()?;
    if r.len() != 32 || s.len() != 32 || v > 1 || unsigned.first() != Some(&2) { return None }
    let encoded = &unsigned[1..];
    let head = *encoded.first()?;
    let body = if head <= 0xf7 { encoded.get(1..1 + (head.checked_sub(0xc0)? as usize))? }
        else if head == 0xf8 { encoded.get(2..2 + *encoded.get(1)? as usize)? } else { return None };
    if body.len() + if head <= 0xf7 { 1 } else { 2 } != encoded.len() { return None }
    let trim = |b: &[u8]| b[b.iter().position(|x| *x != 0).unwrap_or(b.len())..].to_vec();
    let mut items = body.to_vec();
    items.extend(rlp_bytes(if v == 0 { &[] } else { &[1] }));
    items.extend(rlp_bytes(&trim(&r)));
    items.extend(rlp_bytes(&trim(&s)));
    let mut raw = vec![2];
    raw.extend(rlp_list(&[items]));
    Some(format!("0x{}", hex(&Keccak256::digest(&raw))))
}
fn decode20(s: &str) -> [u8; 20] {
    let s = s.strip_prefix("0x").unwrap_or(s);
    require!(s.len() == 40 && s.bytes().all(|b| b.is_ascii_hexdigit()), "Invalid address");
    let mut out = [0; 20];
    for (i, pair) in s.as_bytes().chunks(2).enumerate() {
        out[i] = u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap();
    }
    out
}
fn hex(bytes: &[u8]) -> String {
    const A: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes { s.push(A[(b >> 4) as usize] as char); s.push(A[(b & 15) as usize] as char); }
    s
}
fn rlp_bytes(b: &[u8]) -> Vec<u8> {
    if b.len() == 1 && b[0] < 128 { return b.to_vec(); }
    require!(b.len() <= 55, "Oversized RLP field");
    let mut v = vec![0x80 + b.len() as u8]; v.extend_from_slice(b); v
}
fn rlp_list(items: &[Vec<u8>]) -> Vec<u8> {
    let b: Vec<u8> = items.iter().flat_map(|v| v.iter().copied()).collect();
    if b.len() <= 55 { let mut v = vec![0xc0 + b.len() as u8]; v.extend(b); return v; }
    require!(b.len() < 256, "Oversized transaction");
    let mut v = vec![0xf8, b.len() as u8]; v.extend(b); v
}
fn rlp_uint(n: u128) -> Vec<u8> {
    let b = n.to_be_bytes();
    rlp_bytes(if n == 0 { &[] } else { &b[b.iter().position(|x| *x != 0).unwrap()..] })
}
fn unsigned_eip1559(nonce: u64, priority: u64, max: u64, to: &[u8; 20], value: u128) -> Vec<u8> {
    let fields = vec![rlp_uint(CHAIN_ID.into()), rlp_uint(nonce.into()), rlp_uint(priority.into()),
        rlp_uint(max.into()), rlp_uint(GAS_LIMIT.into()), rlp_bytes(to), rlp_uint(value),
        rlp_bytes(&[]), vec![0xc0]];
    let mut tx = vec![2]; tx.extend(rlp_list(&fields)); tx
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::{testing_env, test_vm_config, PromiseResult, RuntimeFeesConfig};
    use near_sdk::test_utils::VMContextBuilder;

    fn id(s: &str) -> AccountId { s.parse().unwrap() }
    fn context(caller: &str) -> VMContextBuilder {
        let mut b = VMContextBuilder::new();
        b.current_account_id(id("vault.testnet")).predecessor_account_id(id(caller))
            .signer_account_id(id(caller)).account_balance(NearToken::from_near(5))
            .prepaid_gas(Gas::from_tgas(250)); b
    }
    fn vault() -> Vault {
        testing_env!(context("controller.testnet").build());
        Vault::new(id("controller.testnet"), id("reporter.testnet"), id("guardian.testnet"))
    }

    #[test]
    fn research_secret_reference_is_bound_to_controller_context(){
        let mut v=vault();let version="a".repeat(64);
        project().insert(&0,&ProjectRecord{project_id:"vault.testnet/scout".into(),project_uuid:"stable".into(),version_key:version.clone(),wasm_url:"https://test.fastfs.io/research.wasm".into(),state:"READY".into()});
        let source=serde_json::json!({"operation":"run","service":"research","jobId":1,
            "context":{"registryAccountId":"controller.testnet","vaultAccountId":"vault.testnet"},
            "research":{"settings":{"version_key":version,"secrets_ref":{"account_id":"operator.testnet","profile":"inference"}}}}).to_string();
        let limits=SkillLimits{max_instructions:1_000_000,max_memory_mb:64,max_execution_seconds:10};
        let bad=std::panic::catch_unwind(std::panic::AssertUnwindSafe(||v.execute_research_skill(1,version.clone(),source.clone(),limits.clone(),U128(100),
            SecretsReference{account_id:id("attacker.testnet"),profile:"inference".into()})));
        assert!(bad.is_err());assert!(v.pending.is_none());
        let _=v.execute_research_skill(1,version,source,limits,U128(100),SecretsReference{account_id:id("operator.testnet"),profile:"inference".into()});
        let receipts=near_sdk::test_utils::get_created_receipts();
        let payload=receipts.iter().flat_map(|r|r.actions.iter()).find_map(|a|match a{
            near_sdk::mock::MockAction::FunctionCallWeight{method_name,args,..} if method_name==b"request_execution"=>Some(serde_json::from_slice::<serde_json::Value>(args).unwrap()),_=>None}).unwrap();
        assert_eq!(payload["secrets_ref"]["account_id"],"operator.testnet");
        assert_eq!(payload["source"]["Project"]["project_id"],"vault.testnet/scout");
    }
    #[test]
    fn failed_signature_callback_keeps_nonce_and_blocks_new_work() {
        let mut v = vault();
        let _ = v.request_evm_transfer(1, 0, "0x1111111111111111111111111111111111111111".into(),
            U128(1_000_000_000_000), 1_000_000_000, 2_000_000_000);
        testing_env!(context("vault.testnet").build(), test_vm_config(), RuntimeFeesConfig::test(),
            Default::default(), vec![PromiseResult::Failed]);
        assert!(!v.on_evm_signature(1));
        assert_eq!(v.next_evm_nonce, 0);
        assert!(matches!(v.pending, Some(Pending::Evm { uncertain: true, signature: None, .. })));
    }

    #[test]
    fn unresolved_signature_rejects_second_transfer_without_starting_it() {
        let mut v = vault();
        let _ = v.request_evm_transfer(1, 0, "0x1111111111111111111111111111111111111111".into(),
            U128(1), 1, 2);
        assert!(matches!(v.send_near(2, id("recipient.testnet"), U128(100)), PromiseOrValue::Value(false)));
        assert_eq!(v.next_operation_id, 2);
        assert!(matches!(v.pending, Some(Pending::Evm { id: 1, .. })));
    }

    #[test]
    fn successful_report_allows_second_signature() {
        let mut v = vault();
        let _ = v.request_evm_transfer(1, 0, "0x1111111111111111111111111111111111111111".into(),
            U128(1), 1, 2);
        signed(&mut v,1);let hash=pending_hash(&v);
        testing_env!(context("reporter.testnet").build());
        v.report_evm_receipt(1, hash, 123, true);
        assert_eq!(v.next_evm_nonce, 1);
        testing_env!(context("controller.testnet").build());
        let _ = v.request_evm_transfer(2, 1, "0x2222222222222222222222222222222222222222".into(), U128(2), 1, 2);
        assert!(matches!(v.pending, Some(Pending::Evm { nonce: 1, .. })));
    }

    #[test]
    fn near_withdrawal_repeats_after_callback() {
        let mut v = vault();
        let _ = v.send_near(1, id("recipient.testnet"), U128(NearToken::from_millinear(100).as_yoctonear()));
        testing_env!(context("vault.testnet").build(), test_vm_config(), RuntimeFeesConfig::test(),
            Default::default(), vec![PromiseResult::Successful(vec![])]);
        assert!(v.on_near_transfer(1));
        testing_env!(context("controller.testnet").build());
        let _ = v.send_near(2, id("recipient.testnet"), U128(NearToken::from_millinear(100).as_yoctonear()));
        assert!(matches!(v.pending, Some(Pending::Near { id: 2, .. })));
    }

    #[test]
    fn registry_offchain_job_gap_does_not_block_next_vault_action() {
        let mut v=vault();
        let _=v.send_near(3,id("recipient.testnet"),U128(100));
        assert_eq!(v.next_operation_id,4);
        testing_env!(context("vault.testnet").build(),test_vm_config(),RuntimeFeesConfig::test(),
            Default::default(),vec![PromiseResult::Successful(vec![])]);
        assert!(v.on_near_transfer(3));
        testing_env!(context("controller.testnet").build());
        assert!(matches!(v.send_near(2,id("recipient.testnet"),U128(100)),PromiseOrValue::Value(false)));
        assert_eq!(v.next_operation_id,4);
    }

    #[test]
    fn large_near_values_are_readable_during_pending_work(){
        let mut v=vault();
        let amount=NearToken::from_near(1).as_yoctonear();
        let _=v.send_near(1,id("recipient.testnet"),U128(amount));
        assert_eq!(v.status()["pending"]["Near"]["amount"],amount.to_string());
        daily_budget().insert(&0,&DailyBudget{day:1,deposits:amount});
        assert_eq!(v.outlayer_status()["daily_budget"]["deposits"],amount.to_string());
    }
    #[test]
    fn studio_simulation_uses_the_vault_unsigned_transaction_encoding(){
        assert_eq!(hex(&unsigned_eip1559(0,1,2,&[0x11;20],1)),
            "02e283aa36a78001028252089411111111111111111111111111111111111111110180c0");
    }

    #[test]
    fn guardian_can_schedule_upgrade_without_deployment_key() {
        let mut v = vault();let code=vec![0, 97, 115, 109];
        testing_env!(context("guardian.testnet").build());v.propose_upgrade(hex(&env::sha256(&code)));
        testing_env!(context("guardian.testnet").block_timestamp(UPGRADE_DELAY_NS).build());
        let _ = v.emergency_upgrade(Base64VecU8(code));
        assert!(!near_sdk::test_utils::get_created_receipts().is_empty());
    }

    #[test]
    fn concurrent_near_spend_cannot_overbook() {
        let mut v = vault();
        let _ = v.send_near(1,id("recipient.testnet"),U128(100));
        assert!(matches!(v.send_near(2,id("recipient.testnet"),U128(100)),PromiseOrValue::Value(false)));
        assert!(matches!(v.pending,Some(Pending::Near { id: 1, .. })));
    }

    // MPC response shape with arbitrary scalars; the vault only hashes it.
    fn mpc_sig(seed:u8)->Vec<u8>{serde_json::json!({"scheme":"Secp256k1","big_r":{"affine_point":format!("02{}",hex(&[seed;32]))},
        "s":{"scalar":hex(&[seed.wrapping_add(1);32])},"recovery_id":seed%2}).to_string().into_bytes()}
    fn signed(v:&mut Vault,id:u64){
        testing_env!(context("vault.testnet").build(), test_vm_config(), RuntimeFeesConfig::test(),
            Default::default(), vec![PromiseResult::Successful(mpc_sig(id as u8+40))]);
        assert!(v.on_evm_signature(id));
        testing_env!(context("controller.testnet").build());
    }
    fn pending_hash(v:&Vault)->String{
        let Some(Pending::Evm{unsigned,signature:Some(sig),..})=&v.pending else{panic!("not signed")};signed_tx_hash(unsigned,sig).unwrap()
    }

    #[test]
    fn signed_hash_matches_the_settler_encoding(){
        // Generated by services/worker/assemble-evm.mjs from a real secp256k1 signature.
        let unsigned=decode_hex("02e283aa36a78001028252089411111111111111111111111111111111111111110180c0").unwrap();
        let sig=br#"{"scheme":"Secp256k1","big_r":{"affine_point":"02ba6f00faf4788cc7abea17e24459352d61ce7142242d762d09b0cd95730e11d0"},"s":{"scalar":"3ec57bac5cd27c4c11222d06cc67bbb2ee31d379d81fa06080664283f80e38c2"},"recovery_id":0}"#;
        assert_eq!(signed_tx_hash(&unsigned,sig).unwrap(),"0x2c5a15442063c049c8820427d711ce4d25b01b7f8093bdc09968b69fe57078cd");
        assert!(signed_tx_hash(&unsigned,b"{}").is_none());
    }
    #[test]
    #[should_panic(expected = "Receipt hash is not a signed candidate")]
    fn reporter_cannot_settle_with_an_unrelated_hash(){
        let mut v=vault();
        let _ = v.request_evm_transfer(1, 0, "0x1111111111111111111111111111111111111111".into(), U128(5), 1, 2);
        signed(&mut v,1);
        testing_env!(context("reporter.testnet").build());
        v.report_evm_receipt(1, format!("0x{}", "a".repeat(64)), 9, true);
    }
    #[test]
    fn upgrade_requires_proposal_and_owner_approval_or_delay(){
        let mut v=vault();let code=vec![0u8,97,115,109,1];let hash=hex(&env::sha256(&code));
        testing_env!(context("guardian.testnet").build());
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(||v.emergency_upgrade(Base64VecU8(code.clone())))).is_err(),"no proposal");
        v.propose_upgrade(hash.clone());
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(||v.emergency_upgrade(Base64VecU8(code.clone())))).is_err(),"no approval, no delay");
        testing_env!(context("guardian.testnet").block_timestamp(UPGRADE_DELAY_NS).build());
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(||v.emergency_upgrade(Base64VecU8(vec![1,2,3])))).is_err(),"different code");
        let _=v.emergency_upgrade(Base64VecU8(code.clone()));
        assert!(v.upgrade_proposal().is_none(),"proposal consumed");
        // Owner approval (relayed by the registry) allows an immediate upgrade.
        testing_env!(context("guardian.testnet").block_timestamp(UPGRADE_DELAY_NS+1).build());v.propose_upgrade(hash.clone());
        testing_env!(context("alice.testnet").build());
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(||v.approve_upgrade(hash.clone()))).is_err(),"only the registry relays approval");
        testing_env!(context("controller.testnet").block_timestamp(UPGRADE_DELAY_NS+2).build());v.approve_upgrade(hash.clone());
        testing_env!(context("guardian.testnet").block_timestamp(UPGRADE_DELAY_NS+3).build());
        let _=v.emergency_upgrade(Base64VecU8(code));
    }

    #[test]
    fn over_balance_withdrawal_is_a_definite_rejection_and_records_nothing() {
        let mut v = vault();
        assert!(matches!(v.send_near(1,id("recipient.testnet"),U128(NearToken::from_near(10).as_yoctonear())),PromiseOrValue::Value(false)));
        assert!(v.pending.is_none()); assert_eq!(v.next_operation_id,1);
        assert!(v.status()["last_near"].is_null());
        let _ = v.send_near(2,id("recipient.testnet"),U128(100));
        testing_env!(context("vault.testnet").build(), test_vm_config(), RuntimeFeesConfig::test(),
            Default::default(), vec![PromiseResult::Successful(vec![])]);
        assert!(v.on_near_transfer(2));
        assert_eq!(v.status()["last_near"],serde_json::json!([2,true]));
    }

    #[test]
    fn invalid_evm_request_is_rejected_before_any_signature() {
        let mut v = vault();
        for (nonce,fee) in [(1,2),(0,200_000_000_000)] {
            assert!(matches!(v.request_evm_transfer(1,nonce,"0x1111111111111111111111111111111111111111".into(),U128(1),1,fee),
                PromiseOrValue::Value(ref r) if r=="rejected"));
        }
        assert!(v.pending.is_none()); assert_eq!(v.next_operation_id,1);
        assert!(get_created_receipts_empty());
    }
    fn get_created_receipts_empty()->bool{near_sdk::test_utils::get_created_receipts().is_empty()}

    #[test]
    fn uncertain_signature_can_be_requested_again_for_the_same_digest() {
        let mut v = vault();
        let _ = v.request_evm_transfer(1, 0, "0x1111111111111111111111111111111111111111".into(), U128(5), 1, 2);
        let Some(Pending::Evm { digest, .. }) = v.pending.clone() else { panic!() };
        testing_env!(context("vault.testnet").build(), test_vm_config(), RuntimeFeesConfig::test(),
            Default::default(), vec![PromiseResult::Failed]);
        assert!(!v.on_evm_signature(1));
        testing_env!(context("controller.testnet").build());
        assert!(matches!(v.resign_evm(2), PromiseOrValue::Value(ref r) if r=="rejected"));
        assert!(matches!(v.resign_evm(1), PromiseOrValue::Promise(_)));
        assert!(matches!(&v.pending, Some(Pending::Evm { digest: d, uncertain: false, signature: None, .. }) if *d==digest));
        assert!(matches!(v.resign_evm(1), PromiseOrValue::Value(ref r) if r=="rejected"), "Second concurrent re-sign");
        signed(&mut v,1);
        let hash=pending_hash(&v);
        testing_env!(context("reporter.testnet").build());
        v.report_evm_receipt(1, hash, 9, true);
        assert_eq!(v.next_evm_nonce, 1);
    }

    #[test]
    fn same_nonce_replacement_keeps_prior_signature_reportable() {
        let mut v = vault();
        let _ = v.request_evm_transfer(1, 0, "0x1111111111111111111111111111111111111111".into(), U128(5), 1, 2);
        let Some(Pending::Evm { digest: first, .. }) = v.pending.clone() else { panic!() };
        assert!(matches!(v.replace_evm(1,"0x2222222222222222222222222222222222222222".into(),U128(0),2,3),
            PromiseOrValue::Value(ref r) if r=="rejected"), "Unsigned operation cannot be replaced");
        signed(&mut v,1);
        assert!(matches!(v.replace_evm(1,"0x2222222222222222222222222222222222222222".into(),U128(0),2,3),PromiseOrValue::Promise(_)));
        let Some(Pending::Evm { nonce, digest, unsigned, signature: None, .. }) = v.pending.clone() else { panic!() };
        assert_eq!(nonce,0); assert_ne!(digest,first);
        assert_eq!(hex(&unsigned),hex(&unsigned_eip1559(0,2,3,&[0x22;20],0)));
        assert_eq!(v.evm_candidates(0).len(),1); assert_eq!(v.evm_candidates(0)[0].digest,first);
        // The original transaction lands while the replacement signature is pending.
        let original=signed_tx_hash(&v.evm_candidates(0)[0].unsigned,&v.evm_candidates(0)[0].signature).unwrap();
        testing_env!(context("reporter.testnet").build());
        v.report_evm_receipt(1, original, 10, true);
        assert_eq!(v.next_evm_nonce,1); assert!(v.pending.is_none()); assert!(v.evm_candidates(0).is_empty());
    }

    #[test]
    fn released_skill_requires_a_returned_callback() {
        let mut v = vault();
        project().insert(&0,&ProjectRecord{project_id:"vault.testnet/scout".into(),project_uuid:"p1".into(),
            version_key:"a".repeat(64),wasm_url:"https://test.fastfs.io/a.wasm".into(),state:"READY".into()});
        assert!(v.release_skill(4), "Never-started skill has nothing in flight");
        let _ = v.execute_skill(5,"a".repeat(64),"{\"jobId\":5}".into(),SkillLimits{max_instructions:1,max_memory_mb:1,max_execution_seconds:1},U128(100));
        assert!(!v.release_skill(5), "OutLayer callback still outstanding");
        testing_env!(context("vault.testnet").build(), test_vm_config(), RuntimeFeesConfig::test(),
            Default::default(), vec![PromiseResult::Failed]);
        let _ = v.on_skill_execution(5);
        testing_env!(context("controller.testnet").build());
        assert!(!v.release_skill(6)); assert!(v.release_skill(5)); assert!(v.pending.is_none());
    }

    #[test]
    fn pre_outlayer_state_deserializes_with_new_code() {
        let old = vault();
        let bytes = near_sdk::borsh::to_vec(&old).unwrap();
        let recovered: Vault = near_sdk::borsh::from_slice(&bytes).unwrap();
        assert_eq!(recovered.controller, id("controller.testnet"));
        assert_eq!(recovered.next_operation_id, 1);
        assert!(recovered.outlayer_status().get("project").unwrap().is_null());
    }

    #[test]
    fn project_stays_owned_by_vault_and_pins_hash() {
        let mut v = vault();
        let hash = "a".repeat(64);
        let _ = v.create_project(1,"https://test.fastfs.io/scout.wasm".into(),hash.clone(),U128(100));
        assert_eq!(project().get(&0).unwrap().project_id,"vault.testnet/scout");
        testing_env!(context("vault.testnet").build(),test_vm_config(),RuntimeFeesConfig::test(),
            Default::default(),vec![PromiseResult::Successful(b"null".to_vec())]);
        assert!(matches!(v.on_project_write(1),PromiseOrValue::Promise(_)));
        let project_info = serde_json::json!({"project_id":"vault.testnet/scout","project_uuid":"p0001"});
        testing_env!(context("vault.testnet").build(),test_vm_config(),RuntimeFeesConfig::test(),
            Default::default(),vec![PromiseResult::Successful(project_info.to_string().into_bytes())]);
        assert_eq!(v.on_project_verified(1).unwrap().project_uuid,"p0001");
        testing_env!(context("controller.testnet").build());
        let _ = v.execute_skill(2,hash,"{\"jobId\":2}".into(), SkillLimits {
            max_instructions:1_000_000,max_memory_mb:64,max_execution_seconds:10 },U128(100));
        assert!(matches!(v.pending,Some(Pending::Skill { id:2, .. })));
    }

    #[test]
    #[should_panic(expected = "Controller only")]
    fn former_owner_cannot_provision_vault_project() {
        let mut v = vault(); testing_env!(context("alice.testnet").build());
        let _ = v.create_project(1,"https://test.fastfs.io/scout.wasm".into(),"a".repeat(64),U128(100));
    }

    #[test]
    fn unresolved_project_creation_cannot_duplicate() {
        let mut v = vault();
        let _ = v.create_project(1,"https://test.fastfs.io/scout.wasm".into(),"a".repeat(64),U128(100));
        testing_env!(context("vault.testnet").build(),test_vm_config(),RuntimeFeesConfig::test(),
            Default::default(),vec![PromiseResult::Failed]);
        assert!(matches!(v.on_project_write(1),PromiseOrValue::Value(None)));
        assert!(matches!(v.pending,Some(Pending::Project { uncertain:true, .. })));
        assert_eq!(project().get(&0).unwrap().state,"UNCERTAIN");
    }

    #[test]
    fn failed_near_transfer_clears_exact_pending_operation() {
        let mut v = vault();
        let _ = v.send_near(1,id("recipient.testnet"),U128(100));
        testing_env!(context("vault.testnet").build(), test_vm_config(), RuntimeFeesConfig::test(),
            Default::default(), vec![PromiseResult::Failed]);
        assert!(!v.on_near_transfer(1));
        assert!(v.pending.is_none());
        testing_env!(context("controller.testnet").build());
        let _ = v.send_near(2,id("recipient.testnet"),U128(100));
    }
}
