//! Receipt-level sandbox stand-in. It does not emulate a TEE or run WASI.
use near_sdk::{env, json_types::U128, near, require, AccountId, NearToken, Promise};
use near_sdk::collections::LookupMap;

const COST: u128 = 1_000_000_000_000_000_000_000;

#[near(serializers=[borsh,json])]
#[derive(Clone)]
pub struct Project {
    project_id: String, project_uuid: String, active_version: String,
    versions: Vec<String>,
}

#[near(contract_state)]
pub struct Mock {
    next_uuid: u64,
    projects: LookupMap<String,Project>,
    memory: LookupMap<String,String>,
    fixtures:LookupMap<String,String>,
}

impl Default for Mock { fn default()->Self { env::panic_str("Initialize mock") } }

fn version(source:&serde_json::Value)->String{
    let hash=source.get("WasmUrl").and_then(|v|v.get("hash")).and_then(|v|v.as_str()).unwrap_or("");
    require!(hash.len()==64 && hash.bytes().all(|b|b.is_ascii_hexdigit()),"Mock requires WASM hash");
    hash.into()
}
fn hex(bytes:&[u8])->String{
    const CHARS:&[u8;16]=b"0123456789abcdef";
    bytes.iter().flat_map(|b|[CHARS[(b>>4) as usize] as char,CHARS[(b&15) as usize] as char]).collect()
}

#[near]
impl Mock {
    #[init]
    pub fn new()->Self{Self{next_uuid:1,projects:LookupMap::new(&b"projects"[..]),memory:LookupMap::new(&b"memory"[..]),fixtures:LookupMap::new(&b"fixtures"[..])}}
    pub fn estimate_execution_cost(&self,resource_limits:serde_json::Value,input_len:u64)->U128{
        let _=(resource_limits,input_len);U128(COST*2)
    }
    pub fn set_fixture(&mut self,vault:AccountId,service:String,job_id:u64,output_hash:String){
        require!(env::predecessor_account_id()==env::current_account_id(),"Local harness only");
        self.fixtures.insert(&format!("{vault}:{service}:{job_id}"),&output_hash);
    }

    #[payable]
    pub fn create_project(&mut self,name:String,source:serde_json::Value)->serde_json::Value{
        require!(!name.is_empty() && name.len()<=64 && name.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'-'||b==b'_'),"Invalid name");
        let id=format!("{}/{}",env::predecessor_account_id(),name);
        require!(self.projects.get(&id).is_none(),"Project already exists");
        let hash=version(&source);
        let p=Project{project_id:id.clone(),project_uuid:format!("p{:016}",self.next_uuid),
            active_version:hash.clone(),versions:vec![hash]};
        self.next_uuid+=1;self.projects.insert(&id,&p);
        serde_json::json!({"project_id":id,"project_uuid":p.project_uuid})
    }

    pub fn get_project(&self,project_id:String)->Option<Project>{self.projects.get(&project_id)}
    pub fn get_version(&self,project_id:String,version_key:String)->Option<serde_json::Value>{
        let p=self.projects.get(&project_id)?;
        p.versions.contains(&version_key).then(||serde_json::json!({"project_id":project_id,"version_key":version_key}))
    }

    #[payable]
    pub fn add_version(&mut self,project_name:String,source:serde_json::Value,set_active:bool)->serde_json::Value{
        let id=format!("{}/{}",env::predecessor_account_id(),project_name);
        let mut p=self.projects.get(&id).unwrap_or_else(||env::panic_str("Missing project"));
        let hash=version(&source);
        if !p.versions.contains(&hash){p.versions.push(hash.clone())}
        if set_active {p.active_version=hash.clone()}
        self.projects.insert(&id,&p);
        serde_json::json!({"project_id":id,"project_uuid":p.project_uuid,"version_key":hash})
    }

    pub fn set_active_version(&mut self,project_name:String,version_key:String)->serde_json::Value{
        let id=format!("{}/{}",env::predecessor_account_id(),project_name);
        let mut p=self.projects.get(&id).unwrap_or_else(||env::panic_str("Missing project"));
        require!(p.versions.contains(&version_key),"Unknown version");
        p.active_version=version_key;self.projects.insert(&id,&p);
        serde_json::json!({"project_id":id,"project_uuid":p.project_uuid})
    }

    #[payable]
    pub fn request_execution(&mut self,source:serde_json::Value,input_data:String,
        resource_limits:serde_json::Value,response_format:String,secrets_ref:Option<serde_json::Value>)->serde_json::Value{
        require!(response_format=="Json" && resource_limits.is_object(),"Mock requires JSON execution");
        let s=source.get("Project").unwrap_or_else(||env::panic_str("Mock requires Project"));
        let id=s.get("project_id").and_then(|x|x.as_str()).unwrap_or("");
        let p=self.projects.get(&id.to_string()).unwrap_or_else(||env::panic_str("Missing project"));
        require!(id.starts_with(&format!("{}/",env::predecessor_account_id())),"Wrong project caller");
        let hash=s.get("version_key").and_then(|x|x.as_str()).unwrap_or(&p.active_version);
        require!(p.versions.iter().any(|v|v==hash),"Unknown version");
        let input:serde_json::Value=serde_json::from_str(&input_data).unwrap_or_else(|_|env::panic_str("Invalid JSON"));
        let job=input.get("jobId").and_then(|v|v.as_u64()).unwrap_or(0);
        require!(job>0,"Missing job ID");
        let deposit=env::attached_deposit().as_yoctonear();
        require!(deposit>COST,"Mock deposit below simulated cost");
        Promise::new(env::predecessor_account_id()).transfer(NearToken::from_yoctonear(deposit-COST)).detach();
        let service=input.get("service").and_then(|v|v.as_str()).unwrap_or("scout");
        let key=format!("{}:{}:{}:{}",p.project_uuid,env::predecessor_account_id(),service,job);
        if input.get("operation").and_then(|v|v.as_str())==Some("recall") {
            let expected=input.get("expectedHash").and_then(|v|v.as_str()).unwrap_or("");
            let found=self.memory.get(&key).unwrap_or_default();
            require!(!found.is_empty() && found==expected,"No finalized matching memory");
            return serde_json::json!({"schemaVersion":1,"jobId":job,"status":"ok","outputHash":found,
                "outputUri":format!("nfa://work/{}",&expected[7..]),"summary":format!("Stored {service} result")});
        }
        require!(input.get("operation").and_then(|v|v.as_str())==Some("scout")
            || input.get("operation").and_then(|v|v.as_str())==Some("run"),"Unknown operation");
        if service=="research"{
            require!(secrets_ref.as_ref()==input.pointer("/research/settings/secrets_ref"),"Research reference not bound");
            require!(input["context"]["vaultAccountId"]==env::predecessor_account_id().as_str(),"Research predecessor differs");
            for prior in input["context"]["priorWork"].as_array().unwrap(){
                let prior_id=prior["jobId"].as_u64().unwrap();
                require!(self.memory.get(&format!("{}:{}:research:{}",p.project_uuid,env::predecessor_account_id(),prior_id))
                    .is_some_and(|h|prior["outputHash"]==h),"Prior work not in stable vault cell");
            }
            self.memory.insert(&format!("context:{}:{job}",p.project_uuid),&input["context"].to_string());
            // Deterministic local fixture only: no retrieval, model, secret or TEE is exercised.
            if input["question"]=="[fixture] unknown inference result"{
                return serde_json::json!({"schemaVersion":1,"jobId":job,"status":"failed","inferenceOutcome":"unknown"})
            }
        }
        if input.get("sources").and_then(|v|v.as_array()).is_some_and(|s|s.is_empty()){
            return serde_json::json!({"schemaVersion":1,"jobId":job,"status":"failed"})
        }
        let commitment=self.fixtures.get(&format!("{}:{service}:{job}",env::predecessor_account_id()))
            .unwrap_or_else(||format!("sha256:{}",hex(&env::sha256(input_data.as_bytes()))));
        self.memory.insert(&key,&commitment);
        let mut result=serde_json::json!({"schemaVersion":1,"jobId":job,"status":"ok","outputHash":commitment,
            "outputUri":format!("nfa://work/{}",&commitment[7..])});
        if service=="research"{result["inferenceOutcome"]=serde_json::json!("succeeded");result["pricedUsageMicrousd"]=serde_json::json!(160)}
        result
    }

    pub fn stored(&self,project_id:String,caller:AccountId,service:String,job_id:u64)->Option<String>{
        let p=self.projects.get(&project_id)?;
        self.memory.get(&format!("{}:{}:{}:{}",p.project_uuid,caller,service,job_id))
    }
    pub fn cost(&self)->U128{U128(COST)}
    pub fn research_context(&self,project_uuid:String,job_id:u64)->Option<serde_json::Value>{
        self.memory.get(&format!("context:{project_uuid}:{job_id}")).map(|s|serde_json::from_str(&s).unwrap())
    }
}
