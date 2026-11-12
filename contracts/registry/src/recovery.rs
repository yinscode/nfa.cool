//! Recovery for vault operations whose callback did not prove an outcome.
//! New state lives under separate prefixes so the deployed Borsh layout is unchanged.
use super::*;

/// One same-nonce replacement. `signed` is false when the signer result was uncertain.
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct EvmReplacement { pub priority_fee: u64, pub max_fee: u64, pub cancel: bool, pub signed: bool }

/// A broadcast hash recorded by the reporter. `attempt` 0 is the original transaction;
/// attempt k is the k-th replacement. `None` means an identical-payload signature that
/// the vault did not retain (for example a late signer response).
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct EvmBroadcast { pub tx_hash: String, pub attempt: Option<u32> }

const MAX_BROADCASTS: usize = 16;
const MAX_REPLACEMENTS: usize = 7;
fn broadcasts() -> LookupMap<String, Vec<EvmBroadcast>> { LookupMap::new(&b"evm:broadcasts:v1"[..]) }
fn replacements() -> LookupMap<String, Vec<EvmReplacement>> { LookupMap::new(&b"evm:replacements:v1"[..]) }

pub(super) fn record_broadcast(key: &str, tx_hash: &str, attempt: Option<u32>) {
    let mut rows = broadcasts().get(&key.to_string()).unwrap_or_default();
    if rows.iter().any(|row| row.tx_hash.eq_ignore_ascii_case(tx_hash)) { return }
    require!(rows.len() < MAX_BROADCASTS, "Too many broadcast hashes");
    let replaced = replacements().get(&key.to_string()).map(|r| r.len()).unwrap_or(0) as u32;
    require!(attempt.is_none_or(|a| a <= replaced), "Unknown replacement attempt");
    // Without replacements the only signed candidate is the original transaction.
    let attempt = attempt.or((replaced == 0).then_some(0));
    rows.push(EvmBroadcast { tx_hash: tx_hash.to_ascii_lowercase(), attempt });
    broadcasts().insert(&key.to_string(), &rows);
}
/// Legacy operations recorded a single `tx_hash` before this index existed.
pub(super) fn landed_broadcast(key: &str, legacy: Option<&str>, tx_hash: &str) -> Option<EvmBroadcast> {
    broadcasts().get(&key.to_string()).unwrap_or_default().into_iter()
        .find(|row| row.tx_hash.eq_ignore_ascii_case(tx_hash))
        .or_else(|| legacy.filter(|h| h.eq_ignore_ascii_case(tx_hash))
            .map(|h| EvmBroadcast { tx_hash: h.to_ascii_lowercase(), attempt: Some(0) }))
}
pub(super) fn cancelled_attempt(key: &str, attempt: Option<u32>) -> bool {
    let Some(k) = attempt.filter(|k| *k > 0) else { return false };
    replacements().get(&key.to_string()).and_then(|r| r.get(k as usize - 1).cloned()).is_some_and(|r| r.cancel)
}
fn status_of(bytes: &[u8]) -> Option<serde_json::Value> {
    serde_json::from_slice::<serde_json::Value>(bytes).ok()
        .filter(|s| s["controller"] == env::current_account_id().as_str())
}
fn ceil_bump(x: u64) -> u64 { x.saturating_mul(11).saturating_add(9) / 10 }

#[near]
impl Registry {
    pub fn evm_broadcasts(&self, token_id: TokenId, id: u64) -> Vec<EvmBroadcast> {
        broadcasts().get(&op_key(&token_id, id)).unwrap_or_default()
    }
    pub fn evm_replacements(&self, token_id: TokenId, id: u64) -> Vec<EvmReplacement> {
        replacements().get(&op_key(&token_id, id)).unwrap_or_default()
    }

    /// Permissionless. Resolves an uncertain NEAR transfer only from vault state:
    /// a vault that never began the operation, or a recorded outcome for it.
    pub fn reconcile_near_operation(&mut self, token_id: TokenId, id: u64) -> Promise {
        let a = self.agents.get(&token_id).unwrap_or_else(|| env::panic_str("Unknown agent"));
        require!(self.uncertain_op(&token_id, &a, id, "NEAR_TRANSFER"), "No uncertain NEAR operation");
        self.vault_status(&a.vault_id, "on_reconcile_near", &token_id, id)
    }

    #[private]
    pub fn on_reconcile_near(&mut self, token_id: TokenId, id: u64) -> bool {
        let mut a = self.agents.get(&token_id).unwrap();
        if !self.uncertain_op(&token_id, &a, id, "NEAR_TRANSFER") { return false }
        let Some(status) = env::promise_result_checked(0, 4096).ok().and_then(|b| status_of(&b)) else { return false };
        if !status["pending"].is_null() { return false }
        let outcome = if status["next_operation_id"].as_u64().is_some_and(|next| next <= id) { Some(false) }
            else if status["last_near"] == serde_json::json!([id, true]) { Some(true) }
            else if status["last_near"] == serde_json::json!([id, false]) { Some(false) }
            else { None };
        let Some(success) = outcome else { return false };
        let mut op = self.operations.get(&op_key(&token_id, id)).unwrap();
        op.status = if success { OpStatus::Finalized } else { OpStatus::Failed };
        a.pending_op = None;
        if a.lifecycle == Lifecycle::Draining { a.lifecycle = Lifecycle::Active; }
        if !success { self.restore_grant_on_failure(&op, &a); }
        self.operations.insert(&op_key(&token_id, id), &op);
        self.agents.insert(&token_id, &a);
        event("operation_reconciled", serde_json::json!({"token_id":token_id,"id":id,"kind":"NEAR_TRANSFER","success":success}));
        true
    }

    /// Permissionless. Fails an uncertain EVM request only if the vault never began it,
    /// so no signature can exist for it.
    pub fn recover_evm_operation(&mut self, token_id: TokenId, id: u64) -> Promise {
        let a = self.agents.get(&token_id).unwrap_or_else(|| env::panic_str("Unknown agent"));
        require!(self.uncertain_op(&token_id, &a, id, "EVM_TRANSFER"), "No uncertain EVM operation");
        self.vault_status(&a.vault_id, "on_recover_evm", &token_id, id)
    }

    #[private]
    pub fn on_recover_evm(&mut self, token_id: TokenId, id: u64) -> bool {
        let mut a = self.agents.get(&token_id).unwrap();
        if !self.uncertain_op(&token_id, &a, id, "EVM_TRANSFER") { return false }
        let Some(status) = env::promise_result_checked(0, 4096).ok().and_then(|b| status_of(&b)) else { return false };
        if !status["pending"].is_null() || !status["next_operation_id"].as_u64().is_some_and(|next| next <= id) { return false }
        self.fail_unstarted_evm(&token_id, &mut a, id);
        true
    }

    /// Owner or reporter: ask the signer again for the identical digest after an
    /// uncertain signer result. The nonce, recipient, value and fees are unchanged.
    pub fn retry_evm_signature(&mut self, token_id: TokenId, id: u64) -> Promise {
        let caller = env::predecessor_account_id();
        require!(caller == self.owner(&token_id) || caller == self.reporter, "Owner or reporter only");
        let a = self.agents.get(&token_id).unwrap();
        require!(self.uncertain_op(&token_id, &a, id, "EVM_TRANSFER"), "No uncertain EVM operation");
        Promise::new(a.vault_id).function_call("resign_evm".to_string(),
            serde_json::json!({"id":id}).to_string().into_bytes(), NearToken::from_yoctonear(0), Gas::from_tgas(100))
            .then(Promise::new(env::current_account_id()).function_call("on_evm_resigned".to_string(),
                serde_json::json!({"token_id":token_id,"id":id}).to_string().into_bytes(), NearToken::from_yoctonear(0), Gas::from_tgas(20)))
    }

    #[private]
    pub fn on_evm_resigned(&mut self, token_id: TokenId, id: u64) -> bool {
        let a = self.agents.get(&token_id).unwrap();
        if !self.uncertain_op(&token_id, &a, id, "EVM_TRANSFER") { return false }
        if !matches!(env::promise_result_checked(0, 32), Ok(ref b) if b == b"true") { return false }
        let mut op = self.operations.get(&op_key(&token_id, id)).unwrap();
        op.status = OpStatus::Submitted;
        self.operations.insert(&op_key(&token_id, id), &op);
        event("signature_ready", serde_json::json!({"token_id":token_id,"id":id,"retry":true}));
        true
    }

    /// Owner: sign a same-nonce replacement with at least 10% higher fees, or a
    /// zero-value self-send that cancels the transfer. The NFT stays locked until a
    /// finalized receipt proves the nonce was consumed by one of the signed candidates.
    #[payable]
    pub fn replace_evm_transfer(&mut self, token_id: TokenId, id: u64, priority_fee: u64, max_fee: u64, cancel: bool) -> Promise {
        assert_one_yocto();
        require!(self.owner(&token_id) == env::predecessor_account_id(), "Owner only");
        let a = self.agents.get(&token_id).unwrap();
        let key = op_key(&token_id, id);
        let op = self.operations.get(&key).unwrap_or_else(|| env::panic_str("Unknown operation"));
        require!(a.pending_op == Some(id) && op.kind == "EVM_TRANSFER" && op.status == OpStatus::Submitted, "No signed EVM operation");
        let evm = evm_operations().get(&key).unwrap();
        require!(replacements().get(&key).map(|r| r.len()).unwrap_or(0) < MAX_REPLACEMENTS, "Replacement limit reached");
        require!(priority_fee >= ceil_bump(evm.priority_fee) && max_fee >= ceil_bump(evm.max_fee)
            && priority_fee <= max_fee && max_fee <= 100_000_000_000, "Replacement needs at least 10% higher fees within the cap");
        if !cancel {
            if let Some(p) = self.transaction_policy(token_id.clone()) { require!(max_fee <= p.max_fee, "EVM transaction policy exceeded") }
        }
        let (recipient_hex, value_wei) = if cancel {
            (wallets().get(&token_id).unwrap_or_else(|| env::panic_str("Pinned wallet required")).address, U128(0))
        } else { (evm.recipient_hex.clone(), evm.value_wei) };
        Promise::new(a.vault_id).function_call("replace_evm".to_string(),
            serde_json::json!({"id":id,"recipient_hex":recipient_hex,"value_wei":value_wei,
                "priority_fee":priority_fee,"max_fee":max_fee}).to_string().into_bytes(),
            NearToken::from_yoctonear(0), Gas::from_tgas(100))
            .then(Promise::new(env::current_account_id()).function_call("on_evm_replaced".to_string(),
                serde_json::json!({"token_id":token_id,"id":id,"priority_fee":priority_fee,"max_fee":max_fee,"cancel":cancel})
                    .to_string().into_bytes(), NearToken::from_yoctonear(0), Gas::from_tgas(25)))
    }

    #[private]
    pub fn on_evm_replaced(&mut self, token_id: TokenId, id: u64, priority_fee: u64, max_fee: u64, cancel: bool) -> bool {
        let mut a = self.agents.get(&token_id).unwrap();
        let key = op_key(&token_id, id);
        let mut op = self.operations.get(&key).unwrap();
        if a.pending_op != Some(id) || op.kind != "EVM_TRANSFER" { return false }
        let result = env::promise_result_checked(0, 32);
        if matches!(result, Ok(ref b) if b == b"\"rejected\"") { return false }
        let signed = matches!(result, Ok(ref b) if b == b"true");
        // Any other result means the vault switched to the replacement digest and its
        // signer result is unknown: it needs `retry_evm_signature`.
        let mut evm = evm_operations().get(&key).unwrap();
        evm.priority_fee = priority_fee; evm.max_fee = max_fee;
        evm_operations().insert(&key, &evm);
        let mut rows = replacements().get(&key).unwrap_or_default();
        rows.push(EvmReplacement { priority_fee, max_fee, cancel, signed });
        replacements().insert(&key, &rows);
        if !signed { op.status = OpStatus::Uncertain; a.lifecycle = Lifecycle::Draining; }
        self.operations.insert(&key, &op);
        self.agents.insert(&token_id, &a);
        event("evm_replacement_signed", serde_json::json!({"token_id":token_id,"id":id,"attempt":rows.len(),
            "cancel":cancel,"signed":signed,"priority_fee":priority_fee,"max_fee":max_fee}));
        signed
    }
}

impl Registry {
    fn uncertain_op(&self, token_id: &TokenId, a: &Agent, id: u64, kind: &str) -> bool {
        a.pending_op == Some(id) && self.operations.get(&op_key(token_id, id))
            .is_some_and(|op| op.kind == kind && op.status == OpStatus::Uncertain)
    }
    fn vault_status(&self, vault: &AccountId, callback: &str, token_id: &TokenId, id: u64) -> Promise {
        Promise::new(vault.clone()).function_call("status".to_string(), b"{}".to_vec(),
            NearToken::from_yoctonear(0), Gas::from_tgas(10)).then(
                Promise::new(env::current_account_id()).function_call(callback.to_string(),
                    serde_json::json!({"token_id":token_id,"id":id}).to_string().into_bytes(),
                    NearToken::from_yoctonear(0), Gas::from_tgas(30)))
    }
    pub(super) fn fail_unstarted_evm(&mut self, token_id: &TokenId, a: &mut Agent, id: u64) {
        let mut op = self.operations.get(&op_key(token_id, id)).unwrap();
        op.status = OpStatus::Failed;
        a.pending_op = None;
        if a.lifecycle == Lifecycle::Draining { a.lifecycle = Lifecycle::Active; }
        self.operations.insert(&op_key(token_id, id), &op);
        self.agents.insert(token_id, a);
        event("operation_failed", serde_json::json!({"token_id":token_id,"id":id,"kind":"EVM_TRANSFER","signature_requested":false}));
    }
}
