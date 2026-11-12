//! Upgrade powers, made visible and bounded (review M4). State lives under separate prefixes.
use super::*;

/// A registry code change waits this long after its proposal, so owners can see it coming
/// (and exit) before it applies. With this path available the operator can remove the
/// registry's full-access key; until then that key remains an unrestricted trust.
pub(crate) const REGISTRY_UPGRADE_DELAY_NS: u64 = 2 * 86_400_000_000_000;

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct RegistryUpgrade { pub code_hash: String, pub proposed_at_ns: u64 }
pub(super) fn vault_upgrade_locked(token_id: &TokenId) -> bool { vault_upgrades().get(token_id).is_some() }
fn vault_upgrades() -> LookupMap<TokenId, String> { LookupMap::new(&b"governance:vault-inflight:v1"[..]) }
fn registry_upgrade() -> LookupMap<u8, RegistryUpgrade> { LookupMap::new(&b"governance:registry-upgrade:v1"[..]) }

#[near]
impl Registry {
    /// Owner approves the vault code hash the guardian proposed. Without it the guardian
    /// must wait out the vault's public seven-day delay. Blocked while listed or mid-transfer,
    /// so a seller cannot change what a buyer is about to receive.
    #[payable]
    pub fn approve_vault_upgrade(&mut self, token_id: TokenId, code_hash: String) -> Promise {
        assert_one_yocto();
        require!(self.owner(&token_id) == env::predecessor_account_id(), "Owner only");
        let a = self.agents.get(&token_id).unwrap();
        require!(matches!(a.lifecycle, Lifecycle::Active | Lifecycle::Draining), "Not while listed or transferring");
        require!(!vault_upgrade_locked(&token_id), "Vault upgrade in flight");
        require!(code_hash.len() == 64 && code_hash.bytes().all(|b| b.is_ascii_hexdigit()), "Invalid code hash");
        event("vault_upgrade_approved", serde_json::json!({"token_id":token_id,"code_hash":code_hash,"epoch":a.epoch}));
        Promise::new(a.vault_id).function_call("approve_upgrade".to_string(),
            serde_json::json!({"code_hash":code_hash,"expected_epoch":a.epoch}).to_string().into_bytes(), NearToken::from_yoctonear(0), Gas::from_tgas(10))
    }

    /// Called only by this NFA's vault, after it checks the proposal and approval TTL
    /// (or public delay). Epoch validation and the handover barrier are one receipt.
    /// Returning the deployment promise keeps the barrier until deployment succeeds/fails.
    pub fn authorize_vault_upgrade(&mut self, token_id: TokenId, code_hash: String,
        expected_epoch: Option<u64>, code: near_sdk::json_types::Base64VecU8) -> Promise {
        let a=self.agents.get(&token_id).unwrap();
        require!(env::predecessor_account_id()==a.vault_id,"Vault only");
        require!(a.lifecycle!=Lifecycle::TransferCallPending && !vault_upgrade_locked(&token_id),"Agent transferring or upgrading");
        if let Some(epoch)=expected_epoch {
            require!(matches!(a.lifecycle,Lifecycle::Active|Lifecycle::Draining)
                && a.pending_op.is_none(),"Agent busy or listed");
            require!(epoch==a.epoch,"Upgrade approval owner changed");
        }
        // The vault enforces the seven-day delay when no approval epoch is supplied.
        // Keep that recovery path usable for stuck operations and listed agents; the
        // deployment barrier still prevents a buy/transfer from racing the code change.
        require!(code_hash.len()==64 && hex(&env::sha256(&code.0))==code_hash,"Invalid upgrade code");
        vault_upgrades().insert(&token_id,&code_hash);
        Promise::new(a.vault_id).function_call("apply_authorized_upgrade".to_string(),
            serde_json::json!({"code":code}).to_string().into_bytes(),NearToken::from_yoctonear(0),Gas::from_tgas(80))
            .then(Promise::new(env::current_account_id()).function_call("on_vault_upgrade_applied".to_string(),
                serde_json::json!({"token_id":token_id,"code_hash":code_hash}).to_string().into_bytes(),
                NearToken::from_yoctonear(0),Gas::from_tgas(15)))
    }

    #[private]
    pub fn on_vault_upgrade_applied(&mut self,token_id:TokenId,code_hash:String)->bool {
        require!(vault_upgrades().get(&token_id)==Some(code_hash.clone()),"Wrong upgrade callback");
        let success=env::promise_results_count()==1 && env::promise_result_checked(0,32).is_ok();
        vault_upgrades().remove(&token_id);
        event("vault_upgrade_settled",serde_json::json!({"token_id":token_id,"code_hash":code_hash,"success":success}));
        success
    }

    pub fn propose_registry_upgrade(&mut self, code_hash: String) {
        require!(env::predecessor_account_id() == self.admin, "Admin only");
        require!(code_hash.len() == 64 && code_hash.bytes().all(|b| b.is_ascii_hexdigit()), "Invalid code hash");
        let proposal = RegistryUpgrade { code_hash: code_hash.to_ascii_lowercase(), proposed_at_ns: env::block_timestamp() };
        registry_upgrade().insert(&0, &proposal);
        env::log_str(&format!("EVENT_JSON:{}", serde_json::json!({"standard":"nfa","version":"1.0.0",
            "event":"registry_upgrade_proposed","data":[proposal]})));
    }
    pub fn cancel_registry_upgrade(&mut self) {
        require!(env::predecessor_account_id() == self.admin, "Admin only");
        registry_upgrade().remove(&0);
    }
    /// Admin deploys the proposed code after the delay. The raw WASM is the call input
    /// (not JSON), so a 1.4 MB registry still fits in one transaction.
    pub fn apply_registry_upgrade(&mut self) -> Promise {
        require!(env::predecessor_account_id() == self.admin, "Admin only");
        let proposal = registry_upgrade().get(&0).unwrap_or_else(|| env::panic_str("No proposed upgrade"));
        require!(env::block_timestamp() >= proposal.proposed_at_ns.saturating_add(REGISTRY_UPGRADE_DELAY_NS), "Upgrade delay not elapsed");
        let code = env::input().unwrap_or_default();
        require!(!code.is_empty() && hex(&env::sha256(&code)) == proposal.code_hash, "Code differs from proposal");
        registry_upgrade().remove(&0);
        Promise::new(env::current_account_id()).deploy_contract(code)
    }

    /// Who can change the rules. Account access keys are not visible to a contract; check
    /// them with `scripts/authority-inventory.mjs`.
    pub fn authorities(&self) -> serde_json::Value {
        serde_json::json!({"admin":self.admin,"reporter":self.reporter,"guardian":self.guardian,
            "embedded_vault_code_sha256":VAULT_CODE_SHA256,
            "registry_upgrade":registry_upgrade().get(&0),
            "registry_upgrade_delay_ns":REGISTRY_UPGRADE_DELAY_NS.to_string(),
            "vault_upgrade":"guardian proposal; owner approval or 7-day delay (vault code with upgrade_proposal)"})
    }
}
