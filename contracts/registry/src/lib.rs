use std::collections::HashMap;
use near_sdk::{assert_one_yocto, env, json_types::U128, near, require, AccountId, Gas, NearToken, Promise, PromiseOrValue, PromiseError};
use near_sdk::collections::LookupMap;
use near_contract_standards::non_fungible_token::{NonFungibleToken, Token, TokenId};
use near_contract_standards::non_fungible_token::core::{NonFungibleTokenCore, NonFungibleTokenResolver};
use near_contract_standards::non_fungible_token::approval::NonFungibleTokenApproval;
use near_contract_standards::non_fungible_token::enumeration::NonFungibleTokenEnumeration;
use near_contract_standards::non_fungible_token::metadata::{NFTContractMetadata, NonFungibleTokenMetadataProvider, TokenMetadata, NFT_METADATA_SPEC};
use near_contract_standards::non_fungible_token::events::NftMint;
use sha3::{Digest, Keccak256};

const MIN_PROVISION: u128 = 6_000_000_000_000_000_000_000_000;
const REGISTRY_STORAGE: u128 = 200_000_000_000_000_000_000_000;
const VAULT_CODE: &[u8] = include_bytes!(env!("NFA_EMBEDDED_VAULT_WASM"));
/// SHA-256 of `VAULT_CODE`, computed by build.rs. Hashing ~0.5 MB on chain costs about
/// 12 TGas, enough to exhaust the provisioning callback's gas.
pub(crate) const VAULT_CODE_SHA256: &str = env!("NFA_EMBEDDED_VAULT_SHA256");
pub(crate) fn vault_code_hash() -> Vec<u8> {
    (0..VAULT_CODE_SHA256.len()).step_by(2).map(|i| u8::from_str_radix(&VAULT_CODE_SHA256[i..i + 2], 16).unwrap()).collect()
}
/// A job must be started (or, for legacy jobs, completed) within this window. Holding the
/// single operation slot longer is not possible, and an unused slot costs its requester.
pub(crate) const START_WINDOW_NS: u64 = 1_800_000_000_000;
/// Measured upper bound of the registry storage one job leaves behind (job record, service
/// binding, payout row). Charged to the job at settlement so customers and owners, not the
/// pooled liabilities, pay for it. `job_storage_is_covered_by_fee` checks this bound.
pub(crate) const JOB_STORAGE_BYTES: u128 = 800;
pub(crate) fn job_storage_fee() -> u128 { JOB_STORAGE_BYTES * env::storage_byte_cost().as_yoctonear() }
mod outlayer;
mod studio;
mod research;
mod recovery;
mod governance;

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Lifecycle { Active, Draining, Listed, TransferCallPending }

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OpStatus { Requested, Submitted, Finalized, Failed, Uncertain }

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Agent {
    pub vault_id: AccountId,
    pub epoch: u64,
    pub lifecycle: Lifecycle,
    pub next_op_id: u64,
    pub pending_op: Option<u64>,
    pub manifest_hash: String,
    pub manifest_uri: String,
    pub listing_price: Option<u128>,
    pub transfer_from: Option<AccountId>,
    pub transfer_to: Option<AccountId>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Operation {
    pub token_id: TokenId,
    pub id: u64,
    pub epoch: u64,
    pub status: OpStatus,
    pub kind: String,
    pub requested_by: AccountId,
    pub recipient: AccountId,
    pub amount: String,
}

#[near(serializers = [borsh, json])]
pub struct Provision {
    pub owner: AccountId,
    pub vault_id: AccountId,
    pub manifest_hash: String,
    pub manifest_uri: String,
    pub code_hash: Vec<u8>,
    pub failed: bool,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Grant {
    pub epoch: u64,
    pub delegate: AccountId,
    pub method: String,
    pub recipient: Option<AccountId>,
    pub remaining: U128,
    pub expires_at_ns: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Listing {
    pub seller: AccountId,
    pub epoch: u64,
    pub nonce: u64,
    pub price: U128,
    pub expires_at_ns: u64,
    pub manifest_hash: String,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Default)]
pub struct Payout {
    pub available: U128,
    pub pending: Option<(u64, U128)>,
    pub next_id: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct EvmOperation {
    pub nonce: u64,
    pub recipient_hex: String,
    pub value_wei: U128,
    pub priority_fee: u64,
    pub max_fee: u64,
    pub tx_hash: Option<String>,
    pub observed_block: Option<u64>,
    pub success: Option<bool>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct ScoutJob {
    pub id: u64,
    pub epoch: u64,
    pub requester: AccountId,
    pub brief_hash: String,
    pub source_hash: String,
    pub fee: U128,
    pub deadline_ns: u64,
    pub status: String,
    pub output_hash: Option<String>,
    pub output_uri: Option<String>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct DerivedWallet {
    pub chain_id: u64,
    pub signer_id: AccountId,
    pub path: String,
    pub domain_id: u64,
    pub public_key: String,
    pub address: String,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct ChainKeyRecord {
    pub chain: String,
    pub chain_id: u64,
    pub path: String,
    pub signer_id: AccountId,
    pub signer_version: String,
    pub domain_id: u64,
    pub address: String,
}

#[near(contract_state)]
pub struct Registry {
    pub admin: AccountId,
    pub reporter: AccountId,
    pub guardian: AccountId,
    pub nft: NonFungibleToken,
    pub metadata: NFTContractMetadata,
    pub agents: LookupMap<TokenId, Agent>,
    pub provisions: LookupMap<TokenId, Provision>,
    pub operations: LookupMap<String, Operation>,
    pub client_requests: LookupMap<String, TokenId>,
    pub next_token_number: u64,
}

impl Default for Registry { fn default() -> Self { env::panic_str("Registry uninitialized") } }

#[near]
impl Registry {
    #[init]
    pub fn new(admin: AccountId, reporter: AccountId, guardian: AccountId) -> Self {
        require!(!env::state_exists(), "Already initialized");
        // Existing deployments have no key here and must run migrate_liabilities once.
        ledger_totals().insert(&"liabilities".to_string(), &0);
        Self { nft: NonFungibleToken::new(b"o", env::current_account_id(), Some(b"m"), Some(b"e"), Some(b"a")),
            metadata: NFTContractMetadata { spec: NFT_METADATA_SPEC.to_owned(), name: "nfa.gent".into(),
                symbol: "NFA".into(), icon: None, base_uri: None, reference: None, reference_hash: None },
            admin, reporter, guardian, agents: LookupMap::new(b"g"), provisions: LookupMap::new(b"p"),
            operations: LookupMap::new(b"x"), client_requests: LookupMap::new(b"r"), next_token_number: 1 }
    }

    #[payable]
    pub fn create_agent(&mut self, request_id: String, manifest_hash: String, manifest_uri: String) -> String {
        require!(env::attached_deposit().as_yoctonear() >= MIN_PROVISION, "At least 6 NEAR needed for vault storage and operating balance");
        require!(!request_id.is_empty() && request_id.len() <= 64 && manifest_hash.len() <= 100 && manifest_uri.len() <= 256, "Invalid manifest/request");
        let owner = env::predecessor_account_id();
        let key = format!("{}:{}", owner, request_id);
        require!(self.client_requests.get(&key).is_none(), "Request ID already used");
        let token_id = format!("nfa-{}", self.next_token_number);
        self.next_token_number += 1;
        let vault_id: AccountId = format!("{}.{}", token_id, env::current_account_id()).parse().unwrap();
        let deposit = env::attached_deposit().as_yoctonear() - REGISTRY_STORAGE;
        self.client_requests.insert(&key, &token_id);
        provision_deposits().insert(&token_id, &deposit);
        self.provisions.insert(&token_id, &Provision { owner: owner.clone(), vault_id: vault_id.clone(),
            manifest_hash, manifest_uri, code_hash: vault_code_hash(), failed: false });
        event("provision_requested", serde_json::json!({"token_id":token_id,"vault_id":vault_id,"owner_id":owner}));
        let init = serde_json::json!({"controller":env::current_account_id(),"reporter":self.reporter,"guardian":self.guardian});
        Promise::new(vault_id).create_account().transfer(NearToken::from_yoctonear(deposit))
            .deploy_contract(VAULT_CODE.to_vec())
            .function_call("new".to_string(), init.to_string().into_bytes(), NearToken::from_yoctonear(0), Gas::from_tgas(60))
            .then(Promise::new(env::current_account_id()).function_call("on_provision".to_string(),
                serde_json::json!({"token_id":token_id}).to_string().into_bytes(), NearToken::from_yoctonear(0), Gas::from_tgas(35))).detach();
        token_id
    }

    #[private]
    pub fn on_provision(&mut self, token_id: TokenId) -> bool {
        let mut provision = self.provisions.get(&token_id).unwrap_or_else(|| env::panic_str("Unknown provision"));
        require!(!provision.failed, "Provision already failed");
        if env::promise_result_checked(0, 1024).is_err() {
            provision.failed = true;
            self.provisions.insert(&token_id, &provision);
            // The create/deploy/init batch is atomic: no vault exists and its funding was
            // refunded to this registry. Credit it to the creator instead of pooling it.
            let refund = provision_deposits().remove(&token_id).unwrap_or(0);
            if refund > 0 {
                let mut credit = payouts().get(&provision.owner).unwrap_or_default();
                credit.available.0 = credit.available.0.checked_add(refund).unwrap();
                payouts().insert(&provision.owner, &credit);
                add_liability(refund);
            }
            event("provision_failed", serde_json::json!({"token_id":token_id,"vault_id":provision.vault_id,"refund_credit":U128(refund)}));
            return false;
        }
        self.finalize_provision(token_id, provision);
        true
    }

    // Recovery for a vault that deployed successfully while the mint callback failed.
    pub fn retry_finalize(&self, token_id: TokenId) -> Promise {
        require!(env::predecessor_account_id() == self.admin, "Admin only");
        let provision = self.provisions.get(&token_id).unwrap_or_else(|| env::panic_str("No reserved provision"));
        require!(self.agents.get(&token_id).is_none(), "Already minted");
        Promise::new(provision.vault_id).function_call("status".to_string(), b"{}".to_vec(),
            NearToken::from_yoctonear(0), Gas::from_tgas(10)).then(
                Promise::new(env::current_account_id()).function_call("on_recover_provision".to_string(),
                    serde_json::json!({"token_id":token_id}).to_string().into_bytes(),
                    NearToken::from_yoctonear(0), Gas::from_tgas(35)))
    }

    #[private]
    pub fn on_recover_provision(&mut self, token_id: TokenId) -> bool {
        let provision = self.provisions.get(&token_id).unwrap_or_else(|| env::panic_str("No reserved provision"));
        require!(self.agents.get(&token_id).is_none() && !provision.failed, "Already minted or refunded");
        let Ok(bytes) = env::promise_result_checked(0, 4096) else { return false };
        let Ok(status) = serde_json::from_slice::<serde_json::Value>(&bytes) else { return false };
        require!(status["controller"] == env::current_account_id().as_str()
            && status["reporter"] == self.reporter.as_str()
            && status["guardian"] == self.guardian.as_str()
            && status["pending"].is_null()
            && status["next_operation_id"] == 1, "Vault identity/state mismatch");
        self.finalize_provision(token_id, provision);
        true
    }

    fn finalize_provision(&mut self, token_id: TokenId, provision: Provision) {
        require!(self.agents.get(&token_id).is_none(), "Already minted");
        if provision.code_hash==vault_code_hash(){research::mark_capable(&token_id)}
        self.agents.insert(&token_id, &Agent { vault_id: provision.vault_id.clone(), epoch: 0,
            lifecycle: Lifecycle::Active, next_op_id: 1, pending_op: None,
            manifest_hash: provision.manifest_hash.clone(), manifest_uri: provision.manifest_uri.clone(),
            listing_price: None, transfer_from: None, transfer_to: None });
        let extra = serde_json::json!({"schema_version":1,"vault_id":provision.vault_id,
            "manifest_hash":provision.manifest_hash,"code_hash":hex(&provision.code_hash)}).to_string();
        let minted = self.nft.internal_mint_with_refund(token_id.clone(), provision.owner, Some(TokenMetadata {
            title: Some(format!("nfa.gent {}", token_id)), description: Some("Transferable agent account".into()),
            extra: Some(extra), reference: None,
            reference_hash: None, ..Default::default()
        }), None);
        NftMint { owner_id: &minted.owner_id, token_ids: &[&minted.token_id], memo: None }.emit();
        self.provisions.remove(&token_id);
        provision_deposits().remove(&token_id);
        event("provision_finalized", serde_json::json!({"token_id":token_id}));
    }

    #[payable]
    pub fn grant_delegate(&mut self, token_id: TokenId, delegate: AccountId, method: String,
        recipient: Option<AccountId>, budget: U128, expires_at_ns: u64) {
        assert_one_yocto(); let agent = self.active_owner(&token_id);
        require!(delegate != env::predecessor_account_id() && budget.0 > 0, "Invalid delegate/budget");
        require!(expires_at_ns > env::block_timestamp() &&
            expires_at_ns.saturating_sub(env::block_timestamp()) <= 31_536_000_000_000_000,
            "Expiry must be within one year");
        require!((method == "NEAR_TRANSFER" && recipient.is_some()) ||
            (method == "NFA_HIRE" && recipient.as_ref().is_some_and(|target|
                target.as_str()!=token_id && self.agents.get(&target.to_string()).is_some())) ||
            (method == "SCOUT_RUN" && recipient.is_none()), "Unsupported grant");
        let key = grant_key(&token_id, &delegate, &method);
        studio::index_grant(&token_id,&delegate,&method);
        grants().insert(&key, &Grant { epoch: agent.epoch, delegate: delegate.clone(), method: method.clone(),
            recipient, remaining: budget, expires_at_ns });
        event("grant_updated", serde_json::json!({"token_id":token_id,"delegate":delegate,"method":method,"epoch":agent.epoch}));
    }

    #[payable]
    pub fn revoke_delegate(&mut self, token_id: TokenId, delegate: AccountId, method: String) {
        assert_one_yocto(); let _ = self.active_owner(&token_id);
        grants().remove(&grant_key(&token_id, &delegate, &method));
        event("grant_revoked", serde_json::json!({"token_id":token_id,"delegate":delegate,"method":method}));
    }

    pub fn grant(&self, token_id: TokenId, delegate: AccountId, method: String) -> Option<Grant> {
        grants().get(&grant_key(&token_id, &delegate, &method))
    }

    #[payable]
    pub fn request_near_transfer(&mut self, token_id: TokenId, recipient: AccountId, amount: U128) -> u64 {
        assert_one_yocto();
        let mut agent = self.transferable(&token_id);
        if let Some(p)=self.transaction_policy(token_id.clone()){
            require!(p.near_enabled&&p.near_recipients.contains(&recipient)&&amount.0<=p.max_near.0,"NEAR transaction policy exceeded");
        }
        require!(agent.pending_op.is_none() && amount.0 > 0, "Operation in flight or zero amount");
        self.authorize(&token_id, &agent, "NEAR_TRANSFER", Some(&recipient), amount.0);
        let id = agent.next_op_id;
        agent.next_op_id += 1;
        agent.pending_op = Some(id);
        self.agents.insert(&token_id, &agent);
        let op = Operation { token_id: token_id.clone(), id, epoch: agent.epoch, status: OpStatus::Requested,
            kind: "NEAR_TRANSFER".into(), requested_by: env::predecessor_account_id(), recipient: recipient.clone(), amount: amount.0.to_string() };
        self.operations.insert(&op_key(&token_id,id), &op);
        event("operation_requested", serde_json::json!({"token_id":token_id,"id":id,"epoch":agent.epoch}));
        Promise::new(agent.vault_id).function_call("send_near".to_string(),
            serde_json::json!({"id":id,"recipient":recipient,"amount":amount}).to_string().into_bytes(),
            NearToken::from_yoctonear(0), Gas::from_tgas(90))
            .then(Promise::new(env::current_account_id()).function_call("on_near_operation".to_string(),
                serde_json::json!({"token_id":token_id,"id":id}).to_string().into_bytes(),
                NearToken::from_yoctonear(0), Gas::from_tgas(20))).detach();
        id
    }

    #[private]
    pub fn on_near_operation(&mut self, token_id: TokenId, id: u64) -> bool {
        let mut agent = self.agents.get(&token_id).unwrap_or_else(|| env::panic_str("Unknown token"));
        require!(agent.pending_op == Some(id), "Wrong operation callback");
        let mut op = self.operations.get(&op_key(&token_id,id)).unwrap();
        let result = env::promise_result_checked(0, 1024);
        match result {
            Ok(ref bytes) if bytes == b"true" => {
                op.status = OpStatus::Finalized; agent.pending_op = None;
                event("operation_finalized", serde_json::json!({"token_id":token_id,"id":id}));
            }
            Ok(ref bytes) if bytes == b"false" => {
                op.status = OpStatus::Failed; agent.pending_op = None;
                self.restore_grant_on_failure(&op, &agent);
                event("operation_failed", serde_json::json!({"token_id":token_id,"id":id}));
            }
            _ => {
                op.status = OpStatus::Uncertain;
                agent.lifecycle = Lifecycle::Draining;
                event("operation_uncertain", serde_json::json!({"token_id":token_id,"id":id}));
            }
        }
        let ok = op.status == OpStatus::Finalized;
        self.agents.insert(&token_id, &agent);
        self.operations.insert(&op_key(&token_id,id), &op);
        ok
    }

    #[payable]
    pub fn request_evm_transfer(&mut self, token_id: TokenId, recipient_hex: String,
        value_wei: U128, priority_fee: u64, max_fee: u64) -> u64 {
        assert_one_yocto(); let mut agent = self.active_owner(&token_id);
        if let Some(p)=self.transaction_policy(token_id.clone()){
            require!(p.evm_enabled&&p.evm_recipients.contains(&recipient_hex.to_ascii_lowercase())&&
                value_wei.0<=p.max_evm.0&&max_fee<=p.max_fee,"EVM transaction policy exceeded");
        }
        require!(wallets().get(&token_id).is_some(), "Pin derived wallet before EVM signing");
        let address = recipient_hex.strip_prefix("0x").unwrap_or(&recipient_hex);
        require!(address.len() == 40 && address.bytes().all(|b| b.is_ascii_hexdigit()), "Invalid EVM recipient");
        require!(value_wei.0 > 0 && value_wei.0 <= 1_000_000_000_000_000_000
            && priority_fee > 0 && priority_fee <= max_fee && max_fee <= 100_000_000_000,
            "Invalid EVM value or fees");
        let id = agent.next_op_id;
        let nonce = evm_nonces().get(&token_id).unwrap_or(0);
        agent.next_op_id = agent.next_op_id.checked_add(1).unwrap();
        agent.pending_op = Some(id);
        self.agents.insert(&token_id, &agent);
        self.operations.insert(&op_key(&token_id, id), &Operation {
            token_id: token_id.clone(), id, epoch: agent.epoch, status: OpStatus::Requested,
            kind: "EVM_TRANSFER".into(), requested_by: env::predecessor_account_id(),
            recipient: agent.vault_id.clone(), amount: value_wei.0.to_string() });
        evm_operations().insert(&op_key(&token_id, id), &EvmOperation {
            nonce, recipient_hex: recipient_hex.clone(), value_wei, priority_fee, max_fee,
            tx_hash: None, observed_block: None, success: None });
        event("operation_requested", serde_json::json!({"token_id":token_id,"id":id,"epoch":agent.epoch,"kind":"EVM_TRANSFER"}));
        Promise::new(agent.vault_id).function_call("request_evm_transfer".to_string(),
            serde_json::json!({"id":id,"nonce":nonce,"recipient_hex":recipient_hex,
                "value_wei":value_wei,"priority_fee":priority_fee,"max_fee":max_fee}).to_string().into_bytes(),
            NearToken::from_yoctonear(0), Gas::from_tgas(120))
            .then(Promise::new(env::current_account_id()).function_call("on_evm_request".to_string(),
                serde_json::json!({"token_id":token_id,"id":id}).to_string().into_bytes(),
                NearToken::from_yoctonear(0), Gas::from_tgas(20))).detach();
        id
    }

    #[private]
    pub fn on_evm_request(&mut self, token_id: TokenId, id: u64) -> bool {
        let mut agent = self.agents.get(&token_id).unwrap_or_else(|| env::panic_str("Unknown agent"));
        require!(agent.pending_op == Some(id), "Wrong EVM callback");
        let mut op = self.operations.get(&op_key(&token_id,id)).unwrap();
        require!(op.kind == "EVM_TRANSFER" && op.status == OpStatus::Requested, "Wrong EVM state");
        let result = env::promise_result_checked(0, 32);
        if matches!(result, Ok(ref data) if data == b"\"rejected\"") {
            // The vault validated nothing into state and requested no signature.
            self.fail_unstarted_evm(&token_id, &mut agent, id);
            return false;
        }
        let ready = matches!(result, Ok(ref data) if data == b"true");
        op.status = if ready { OpStatus::Submitted } else { OpStatus::Uncertain };
        if !ready { agent.lifecycle = Lifecycle::Draining; }
        self.agents.insert(&token_id, &agent);
        self.operations.insert(&op_key(&token_id,id), &op);
        event(if ready { "signature_ready" } else { "operation_uncertain" },
            serde_json::json!({"token_id":token_id,"id":id}));
        ready
    }

    // The configured reporter must verify the Sepolia tx/receipt independently.
    // Recording a broadcast never unlocks the NFT.
    // Every same-nonce candidate the reporter broadcasts is recorded; whichever is
    // finalized first consumes the nonce. `attempt` identifies the signed candidate.
    pub fn mark_evm_broadcast(&mut self, token_id: TokenId, id: u64, tx_hash: String, attempt: Option<u32>) {
        require!(env::predecessor_account_id() == self.reporter, "Reporter only");
        require!(valid_tx_hash(&tx_hash), "Invalid transaction hash");
        let agent = self.agents.get(&token_id).unwrap();
        let op = self.operations.get(&op_key(&token_id,id)).unwrap();
        require!(agent.pending_op == Some(id) && matches!(op.status, OpStatus::Submitted | OpStatus::Uncertain)
            && op.kind == "EVM_TRANSFER", "No signed operation");
        let mut evm = evm_operations().get(&op_key(&token_id,id)).unwrap();
        if let Some(old) = evm.tx_hash.clone() { recovery::record_broadcast(&op_key(&token_id,id), &old, Some(0)); }
        recovery::record_broadcast(&op_key(&token_id,id), &tx_hash, attempt);
        evm.tx_hash = Some(tx_hash.clone());
        evm_operations().insert(&op_key(&token_id,id), &evm);
        event("evm_broadcast", serde_json::json!({"token_id":token_id,"id":id,"tx_hash":tx_hash}));
    }

    pub fn reconcile_evm(&self, token_id: TokenId, id: u64) -> Promise {
        require!(env::predecessor_account_id() == self.reporter, "Reporter only");
        let agent = self.agents.get(&token_id).unwrap();
        let evm = evm_operations().get(&op_key(&token_id,id)).unwrap();
        require!(agent.pending_op == Some(id) && evm.tx_hash.is_some(), "No pending broadcast");
        Promise::new(agent.vault_id).function_call("status".to_string(), b"{}".to_vec(),
            NearToken::from_yoctonear(0), Gas::from_tgas(10)).then(
                Promise::new(env::current_account_id()).function_call("on_reconcile_evm".to_string(),
                    serde_json::json!({"token_id":token_id,"id":id}).to_string().into_bytes(),
                    NearToken::from_yoctonear(0), Gas::from_tgas(30)))
    }

    #[private]
    pub fn on_reconcile_evm(&mut self, token_id: TokenId, id: u64) -> bool {
        let mut agent = self.agents.get(&token_id).unwrap();
        require!(agent.pending_op == Some(id), "Wrong reconciliation callback");
        let mut op = self.operations.get(&op_key(&token_id,id)).unwrap();
        let mut evm = evm_operations().get(&op_key(&token_id,id)).unwrap();
        require!(op.kind == "EVM_TRANSFER" && matches!(op.status, OpStatus::Submitted | OpStatus::Uncertain), "Wrong EVM state");
        let Ok(bytes) = env::promise_result_checked(0, 4096) else { return false };
        let Ok(status) = serde_json::from_slice::<serde_json::Value>(&bytes) else { return false };
        let Some(receipt) = status["last_receipt"].as_array() else { return false };
        if receipt.len() != 4 || status["controller"] != env::current_account_id().as_str()
            || status["chain_id"] != 11_155_111 || status["path"] != "eth-sepolia-v1"
            || !status["pending"].is_null()
            || receipt[0] != evm.nonce || receipt[2].as_u64().unwrap_or(0) == 0 || !receipt[3].is_boolean()
            || status["next_evm_nonce"] != evm.nonce + 1 { return false; }
        let key = op_key(&token_id,id);
        let Some(landed) = receipt[1].as_str().and_then(|h| recovery::landed_broadcast(&key, evm.tx_hash.as_deref(), h))
            else { return false };
        let success = receipt[3].as_bool().unwrap();
        let cancelled = recovery::cancelled_attempt(&key, landed.attempt);
        evm.observed_block = receipt[2].as_u64(); evm.success = Some(success);
        evm.tx_hash = Some(landed.tx_hash.clone());
        // A landed cancellation consumed the nonce without making the requested transfer.
        op.status = if success && !cancelled { OpStatus::Finalized } else { OpStatus::Failed };
        agent.pending_op = None;
        if agent.lifecycle == Lifecycle::Draining { agent.lifecycle = Lifecycle::Active; }
        evm_nonces().insert(&token_id, &(evm.nonce + 1));
        evm_operations().insert(&op_key(&token_id,id), &evm);
        self.operations.insert(&op_key(&token_id,id), &op);
        self.agents.insert(&token_id, &agent);
        event("evm_reconciled", serde_json::json!({"token_id":token_id,"id":id,"success":success,
            "cancelled":cancelled,"attempt":landed.attempt,"tx_hash":evm.tx_hash}));
        true
    }

    pub fn evm_operation(&self, token_id: TokenId, id: u64) -> Option<EvmOperation> {
        evm_operations().get(&op_key(&token_id,id))
    }

    pub fn derive_wallet(&self, token_id: TokenId) -> Promise {
        require!(self.agents.get(&token_id).is_some() && wallets().get(&token_id).is_none(),
            "Unknown agent or wallet already pinned");
        let vault = self.agents.get(&token_id).unwrap().vault_id;
        let signer: AccountId = "v1.signer-prod.testnet".parse().unwrap();
        Promise::new(signer).function_call("derived_public_key".to_string(),
            serde_json::json!({"path":"eth-sepolia-v1","predecessor":vault,"domain_id":0}).to_string().into_bytes(),
            NearToken::from_yoctonear(0), Gas::from_tgas(20)).then(
                Promise::new(env::current_account_id()).function_call("on_derived_wallet".to_string(),
                    serde_json::json!({"token_id":token_id}).to_string().into_bytes(),
                    NearToken::from_yoctonear(0), Gas::from_tgas(25)))
    }

    #[private]
    pub fn on_derived_wallet(&mut self, token_id: TokenId) -> bool {
        require!(self.agents.get(&token_id).is_some() && wallets().get(&token_id).is_none(),
            "Wallet already pinned or agent missing");
        let Ok(result) = env::promise_result_checked(0, 256) else { return false };
        let Ok(key) = serde_json::from_slice::<String>(&result) else { return false };
        let Some(encoded) = key.strip_prefix("secp256k1:") else { return false };
        let Ok(public) = bs58::decode(encoded).into_vec() else { return false };
        if public.len() != 64 { return false; }
        let raw = Keccak256::digest(&public);
        let lower = hex(&raw[12..]);
        let check = Keccak256::digest(lower.as_bytes());
        let mut address = String::from("0x");
        for (i, c) in lower.bytes().enumerate() {
            let nibble = if i % 2 == 0 { check[i/2] >> 4 } else { check[i/2] & 15 };
            address.push(if nibble >= 8 { (c as char).to_ascii_uppercase() } else { c as char });
        }
        let wallet=DerivedWallet { chain_id: 11_155_111,
            signer_id: "v1.signer-prod.testnet".parse().unwrap(), path: "eth-sepolia-v1".into(),
            domain_id: 0, public_key: key, address: address.clone() };
        chain_keys().insert(&chain_key_id(&token_id,"eth-sepolia"), &chain_key_record(&wallet));
        wallets().insert(&token_id, &wallet);
        event("wallet_pinned", serde_json::json!({"token_id":token_id,"chain_id":11155111,"address":address}));
        true
    }

    pub fn derived_wallet(&self, token_id: TokenId) -> Option<DerivedWallet> { wallets().get(&token_id) }

    pub fn chain_key(&self, token_id:TokenId, chain:String)->Option<ChainKeyRecord>{
        // Only the reviewed Sepolia path is supported. Old pinned wallets are
        // projected into the new view without an owner write or a new key.
        if chain!="eth-sepolia" || self.agents.get(&token_id).is_none(){return None}
        chain_keys().get(&chain_key_id(&token_id,&chain))
            .or_else(||wallets().get(&token_id).map(|wallet|chain_key_record(&wallet)))
    }

    #[payable]
    pub fn request_scout_job(&mut self, token_id: TokenId, brief_hash: String,
        source_hash: String, deadline_ns: u64, fee: U128) -> u64 {
        let mut agent = self.transferable(&token_id);
        require!(valid_content_hash(&brief_hash) && valid_content_hash(&source_hash), "Invalid input hashes");
        require!(fee.0 >= 10_000_000_000_000_000_000_000
            && env::attached_deposit().as_yoctonear() == fee.0, "Exact job fee required");
        require!(deadline_ns > env::block_timestamp() &&
            deadline_ns.saturating_sub(env::block_timestamp()) <= START_WINDOW_NS,
            "Job deadline must be within 30 minutes");
        let id = agent.next_op_id;
        agent.next_op_id = agent.next_op_id.checked_add(1).unwrap();
        agent.pending_op = Some(id);
        self.agents.insert(&token_id, &agent);
        add_liability(fee.0);
        scout_jobs().insert(&op_key(&token_id,id), &ScoutJob {
            id, epoch: agent.epoch, requester: env::predecessor_account_id(),
            brief_hash, source_hash, fee, deadline_ns, status: "REQUESTED".into(),
            output_hash: None, output_uri: None });
        self.operations.insert(&op_key(&token_id,id), &Operation {
            token_id: token_id.clone(), id, epoch: agent.epoch, status: OpStatus::Requested,
            kind: "JOB".into(), requested_by: env::predecessor_account_id(),
            recipient: agent.vault_id, amount: fee.0.to_string() });
        event("job_requested", serde_json::json!({"token_id":token_id,"id":id,"epoch":agent.epoch,"fee":fee}));
        id
    }

    pub fn complete_scout_job(&mut self, token_id: TokenId, id: u64, expected_epoch: u64,
        output_hash: String, output_uri: String) {
        require!(valid_content_hash(&output_hash) && !output_uri.is_empty() && output_uri.len() <= 256,
            "Invalid output commitment");
        let mut agent = self.agents.get(&token_id).unwrap_or_else(|| env::panic_str("Unknown agent"));
        let mut job = scout_jobs().get(&op_key(&token_id,id)).unwrap_or_else(|| env::panic_str("Unknown job"));
        require!(agent.lifecycle == Lifecycle::Active && agent.pending_op == Some(id)
            && agent.epoch == expected_epoch && job.epoch == expected_epoch
            && job.status == "REQUESTED" && env::block_timestamp() < job.deadline_ns,
            "Job stale or blocked");
        let caller = env::predecessor_account_id();
        let key = grant_key(&token_id, &caller, "SCOUT_RUN");
        let mut grant = grants().get(&key).unwrap_or_else(|| env::panic_str("Scout worker grant required"));
        require!(grant.epoch == expected_epoch && grant.expires_at_ns > env::block_timestamp()
            && grant.remaining.0 >= 1 && grant.recipient.is_none(), "Scout grant expired or exhausted");
        grant.remaining.0 -= 1; grants().insert(&key, &grant);
        job.status = "FINALIZED".into(); job.output_hash = Some(output_hash.clone());
        job.output_uri = Some(output_uri.clone()); scout_jobs().insert(&op_key(&token_id,id), &job);
        agent.pending_op = None; self.agents.insert(&token_id, &agent);
        let mut op = self.operations.get(&op_key(&token_id,id)).unwrap();
        op.status = OpStatus::Finalized; self.operations.insert(&op_key(&token_id,id), &op);
        let storage = job_storage_fee().min(job.fee.0);
        collect_storage(storage);
        let income = incomes().get(&token_id).unwrap_or(0).checked_add(job.fee.0 - storage).unwrap();
        incomes().insert(&token_id, &income);
        event("job_finalized", serde_json::json!({"token_id":token_id,"id":id,"epoch":agent.epoch,
            "output_hash":output_hash,"output_uri":output_uri,"income":job.fee}));
    }

    pub fn abort_scout_job(&mut self, token_id: TokenId, id: u64) {
        let mut agent = self.agents.get(&token_id).unwrap();
        let mut job = scout_jobs().get(&op_key(&token_id,id)).unwrap();
        require!(agent.pending_op == Some(id) && job.status == "REQUESTED"
            && env::block_timestamp() >= job.deadline_ns, "Job not expired");
        job.status = "FAILED".into(); scout_jobs().insert(&op_key(&token_id,id), &job);
        // The NFA stays usable: an expired legacy job no longer forces an owner resume.
        agent.pending_op = None;
        self.agents.insert(&token_id, &agent);
        let mut op = self.operations.get(&op_key(&token_id,id)).unwrap();
        op.status = OpStatus::Failed; self.operations.insert(&op_key(&token_id,id), &op);
        let storage = job_storage_fee().min(job.fee.0);
        collect_storage(storage);
        let mut credit = payouts().get(&job.requester).unwrap_or_default();
        credit.available.0 = credit.available.0.checked_add(job.fee.0 - storage).unwrap();
        payouts().insert(&job.requester, &credit);
        event("job_refunded", serde_json::json!({"token_id":token_id,"id":id,"requester":job.requester,
            "refund_credit":U128(job.fee.0 - storage),"storage_fee":U128(storage)}));
    }

    #[payable]
    pub fn claim_income(&mut self, token_id: TokenId, amount: U128) {
        assert_one_yocto(); let _ = self.active_owner(&token_id);
        let balance = incomes().get(&token_id).unwrap_or(0);
        require!(amount.0 > 0 && balance >= amount.0, "Insufficient agent income");
        incomes().insert(&token_id, &(balance - amount.0));
        let owner = env::predecessor_account_id();
        let mut credit = payouts().get(&owner).unwrap_or_default();
        credit.available.0 = credit.available.0.checked_add(amount.0).unwrap();
        payouts().insert(&owner, &credit);
        event("income_claimed", serde_json::json!({"token_id":token_id,"owner":owner,"amount":amount}));
    }

    pub fn scout_job(&self, token_id: TokenId, id: u64) -> Option<ScoutJob> {
        scout_jobs().get(&op_key(&token_id,id))
    }
    pub fn agent_income(&self, token_id: TokenId) -> U128 { U128(incomes().get(&token_id).unwrap_or(0)) }
    /// Registry-level accounting: tracked liabilities, collected job storage fees and the
    /// storage fee each job pays.
    pub fn registry_ledger(&self) -> serde_json::Value {
        serde_json::json!({"liabilities":U128(liability()),
            "storage_fees":U128(ledger_totals().get(&"storage_fees".to_string()).unwrap_or(0)),
            "job_storage_fee":U128(job_storage_fee()),"start_window_ns":START_WINDOW_NS.to_string()})
    }

    /// One-time upgrade migration. The sequential token IDs cover every minted agent and
    /// outstanding provision; payout keys are supplied from a complete RPC storage scan.
    /// The expected payout sum is an independent check against that scan.
    pub fn migrate_liabilities(&mut self, payout_accounts: Vec<AccountId>, expected_payouts: U128,
        expected_total: U128) -> serde_json::Value {
        require!(env::predecessor_account_id() == self.admin, "Admin only");
        require!(!liability_initialized(), "Liabilities already initialized");
        require!(self.next_token_number <= 1000, "Migration requires a bounded token set");
        require!(payout_accounts.len() <= 1000, "Too many payout accounts");
        let escrow = outlayer::migration_escrow();
        let mut income = 0u128;
        let mut legacy_escrow = 0u128;
        let mut recall_deposits = 0u128;
        for number in 1..self.next_token_number {
            let token_id = format!("nfa-{number}");
            income = income.checked_add(incomes().get(&token_id).unwrap_or(0)).unwrap();
            if let Some(agent) = self.agents.get(&token_id) {
                if let Some(id) = agent.pending_op {
                    let key = op_key(&token_id, id);
                    if let Some(job) = scout_jobs().get(&key) {
                        if job.status == "REQUESTED" {
                            legacy_escrow = legacy_escrow.checked_add(job.fee.0).unwrap();
                        }
                    }
                    recall_deposits = recall_deposits.checked_add(outlayer::migration_recall(&key)).unwrap();
                }
            }
        }
        let mut seen = std::collections::HashSet::new();
        let mut payout_total = 0u128;
        for account in payout_accounts {
            require!(seen.insert(account.clone()), "Duplicate payout account");
            let payout = payouts().get(&account).unwrap_or_default();
            payout_total = payout_total.checked_add(payout.available.0).unwrap();
            if let Some((_, amount)) = payout.pending {
                payout_total = payout_total.checked_add(amount.0).unwrap();
            }
        }
        require!(payout_total == expected_payouts.0, "Payout scan differs");
        let total = escrow.checked_add(income).unwrap().checked_add(legacy_escrow).unwrap()
            .checked_add(recall_deposits).unwrap().checked_add(payout_total).unwrap();
        require!(total == expected_total.0, "Migration total differs");
        let storage = u128::from(env::storage_usage()).checked_mul(env::storage_byte_cost().as_yoctonear()).unwrap();
        require!(env::account_balance().as_yoctonear() >= storage.saturating_add(total)
            .saturating_add(100_000_000_000_000_000_000_000), "Registry cannot cover migrated liabilities");
        ledger_totals().insert(&"liabilities".to_string(), &total);
        let result = serde_json::json!({"escrow":U128(escrow),"legacy_escrow":U128(legacy_escrow),
            "recall_deposits":U128(recall_deposits),"income":U128(income),
            "payouts":U128(payout_total),"total":U128(total)});
        event("liabilities_migrated", result.clone());
        result
    }

    pub fn liability_migration_required(&self) -> bool { !liability_initialized() }

    #[payable]
    pub fn update_manifest(&mut self, token_id: TokenId, manifest_hash: String, manifest_uri: String) {
        assert_one_yocto(); let mut agent = self.active_owner(&token_id);
        require!(valid_content_hash(&manifest_hash) && !manifest_uri.is_empty() && manifest_uri.len() <= 256,
            "Invalid manifest");
        agent.manifest_hash = manifest_hash.clone(); agent.manifest_uri = manifest_uri.clone();
        self.agents.insert(&token_id, &agent);
        event("manifest_updated", serde_json::json!({"token_id":token_id,"epoch":agent.epoch,
            "manifest_hash":manifest_hash,"manifest_uri":manifest_uri}));
    }

    #[payable]
    pub fn drain(&mut self, token_id: TokenId) {
        assert_one_yocto(); let mut agent = self.active_owner(&token_id);
        agent.lifecycle = Lifecycle::Draining; self.agents.insert(&token_id, &agent);
    }
    #[payable]
    pub fn resume(&mut self, token_id: TokenId) {
        assert_one_yocto(); let mut agent = self.agents.get(&token_id).unwrap();
        require!(self.owner(&token_id) == env::predecessor_account_id(), "Owner only");
        require!(agent.lifecycle == Lifecycle::Draining && agent.pending_op.is_none(), "Unresolved operation");
        agent.lifecycle = Lifecycle::Active; self.agents.insert(&token_id, &agent);
    }
    #[payable]
    pub fn list_agent(&mut self, token_id: TokenId, price: U128) {
        self.create_listing(token_id, price, env::block_timestamp().saturating_add(604_800_000_000_000));
    }
    #[payable]
    pub fn create_listing(&mut self, token_id: TokenId, price: U128, expires_at_ns: u64) {
        assert_one_yocto(); let mut agent = self.active_owner(&token_id);
        require!(price.0 > 0 && expires_at_ns > env::block_timestamp()
            && expires_at_ns.saturating_sub(env::block_timestamp()) <= 2_592_000_000_000_000,
            "Invalid price/expiry");
        let nonce = listing_nonces().get(&token_id).unwrap_or(0).checked_add(1).unwrap();
        listing_nonces().insert(&token_id, &nonce);
        let listing = Listing { seller: env::predecessor_account_id(), epoch: agent.epoch,
            nonce, price, expires_at_ns, manifest_hash: agent.manifest_hash.clone() };
        listings().insert(&token_id, &listing);
        agent.lifecycle = Lifecycle::Listed; agent.listing_price = Some(price.0);
        self.agents.insert(&token_id, &agent);
        event("listed", serde_json::json!({"token_id":token_id,"seller":listing.seller,
            "price":price,"nonce":nonce,"expires_at_ns":expires_at_ns}));
    }
    #[payable]
    pub fn unlist_agent(&mut self, token_id: TokenId) {
        assert_one_yocto(); let mut agent = self.agents.get(&token_id).unwrap();
        require!(self.owner(&token_id) == env::predecessor_account_id(), "Owner only");
        require!(agent.lifecycle == Lifecycle::Listed && agent.pending_op.is_none(), "Not listed");
        agent.lifecycle = Lifecycle::Active; agent.listing_price = None;
        listings().remove(&token_id);
        self.agents.insert(&token_id, &agent);
    }
    pub fn cancel_expired(&mut self, token_id: TokenId) {
        let listing = listings().get(&token_id).unwrap_or_else(|| env::panic_str("No listing"));
        require!(env::block_timestamp() >= listing.expires_at_ns, "Listing not expired");
        let mut agent = self.agents.get(&token_id).unwrap();
        require!(agent.lifecycle == Lifecycle::Listed && agent.pending_op.is_none(), "Invalid listing state");
        listings().remove(&token_id);
        agent.lifecycle = Lifecycle::Draining; agent.listing_price = None;
        self.agents.insert(&token_id, &agent);
        event("listing_expired", serde_json::json!({"token_id":token_id,"nonce":listing.nonce}));
    }

    #[payable]
    pub fn buy(&mut self, token_id: TokenId, expected_nonce: u64) {
        require!(!governance::vault_upgrade_locked(&token_id), "Vault upgrade in flight");
        let buyer = env::predecessor_account_id();
        let listing = listings().get(&token_id).unwrap_or_else(|| env::panic_str("No listing"));
        let mut agent = self.agents.get(&token_id).unwrap();
        require!(agent.lifecycle == Lifecycle::Listed && agent.pending_op.is_none()
            && agent.epoch == listing.epoch && self.owner(&token_id) == listing.seller
            && agent.manifest_hash == listing.manifest_hash, "Listing no longer matches agent");
        require!(env::block_timestamp() < listing.expires_at_ns && expected_nonce == listing.nonce,
            "Expired or stale listing");
        require!(buyer != listing.seller && env::attached_deposit().as_yoctonear() == listing.price.0,
            "Self-buy or incorrect payment");
        let _ = self.nft.internal_transfer(&listing.seller, &buyer, &token_id, None, None);
        listings().remove(&token_id);
        agent.lifecycle = Lifecycle::Active; agent.listing_price = None;
        agent.epoch = agent.epoch.checked_add(1).unwrap();
        self.agents.insert(&token_id, &agent);
        let mut credit = payouts().get(&listing.seller).unwrap_or_default();
        credit.available.0 = credit.available.0.checked_add(listing.price.0).unwrap();
        payouts().insert(&listing.seller, &credit);
        add_liability(listing.price.0);
        event("sold", serde_json::json!({"token_id":token_id,"seller":listing.seller,
            "buyer":buyer,"price":listing.price,"nonce":listing.nonce,"epoch":agent.epoch}));
    }

    pub fn listing(&self, token_id: TokenId) -> Option<Listing> { listings().get(&token_id) }
    pub fn payout(&self, seller: AccountId) -> Payout { payouts().get(&seller).unwrap_or_default() }

    #[payable]
    pub fn withdraw_proceeds(&mut self, amount: U128) -> Promise {
        assert_one_yocto(); let seller = env::predecessor_account_id();
        let mut credit = payouts().get(&seller).unwrap_or_default();
        require!(amount.0 > 0 && amount.0 <= credit.available.0 && credit.pending.is_none(), "No available payout");
        let storage = u128::from(env::storage_usage()) * env::storage_byte_cost().as_yoctonear();
        // Every credited payout, escrowed fee and unclaimed income must stay covered after
        // storage; a shortfall blocks payouts instead of paying early claimants first.
        require!(env::account_balance().as_yoctonear() >= storage.saturating_add(amount.0.max(liability()))
            .saturating_add(100_000_000_000_000_000_000_000), "Registry reserve");
        credit.available.0 -= amount.0;
        credit.next_id = credit.next_id.checked_add(1).unwrap();
        let id = credit.next_id;
        credit.pending = Some((id, amount));
        payouts().insert(&seller, &credit);
        Promise::new(seller.clone()).transfer(NearToken::from_yoctonear(amount.0)).then(
            Promise::new(env::current_account_id()).function_call("on_payout".to_string(),
                serde_json::json!({"seller":seller,"id":id}).to_string().into_bytes(),
                NearToken::from_yoctonear(0), Gas::from_tgas(15)))
    }

    #[private]
    pub fn on_payout(&mut self, seller: AccountId, id: u64) -> bool {
        let mut credit = payouts().get(&seller).unwrap_or_default();
        let Some((pending_id, amount)) = credit.pending else { env::panic_str("No pending payout") };
        require!(pending_id == id, "Wrong payout callback");
        require!(env::promise_results_count() == 1, "Unknown payout result");
        let success = match env::promise_result_checked(0, 32) {
            Ok(_) => true,
            Err(PromiseError::Failed) => false,
            Err(_) => return false, // Unknown result: leave pending and prohibit another payout.
        };
        if !success { credit.available.0 = credit.available.0.checked_add(amount.0).unwrap(); }
        else { release_liability(amount.0); }
        credit.pending = None;
        payouts().insert(&seller, &credit);
        event(if success { "payout_finalized" } else { "payout_failed" },
            serde_json::json!({"seller":seller,"id":id,"amount":amount}));
        success
    }
    pub fn agent(&self, token_id: TokenId) -> Option<Agent> { self.agents.get(&token_id) }
    pub fn operation(&self, token_id: TokenId, id: u64) -> Option<Operation> { self.operations.get(&op_key(&token_id,id)) }
    pub fn pending_provision(&self, token_id: TokenId) -> Option<Provision> { self.provisions.get(&token_id) }
    pub fn request_token(&self, owner: AccountId, request_id: String) -> Option<TokenId> {
        self.client_requests.get(&format!("{}:{}",owner,request_id))
    }

    fn authorize(&self, token_id: &str, agent: &Agent, method: &str,
        recipient: Option<&AccountId>, amount: u128) {
        let caller = env::predecessor_account_id();
        if self.owner(&token_id.to_owned()) == caller { return; }
        let key = grant_key(token_id, &caller, method);
        let mut grant = grants().get(&key).unwrap_or_else(|| env::panic_str("Owner or active delegate only"));
        require!(grant.epoch == agent.epoch && grant.expires_at_ns > env::block_timestamp()
            && grant.recipient.as_ref() == recipient && grant.remaining.0 >= amount,
            "Grant scope, epoch, expiry or budget mismatch");
        grant.remaining.0 -= amount;
        grants().insert(&key, &grant);
    }

    fn restore_grant_on_failure(&self, op: &Operation, agent: &Agent) {
        if self.owner(&op.token_id) == op.requested_by { return; }
        let key = grant_key(&op.token_id, &op.requested_by, &op.kind);
        if let Some(mut grant) = grants().get(&key) {
            if grant.epoch == agent.epoch {
                grant.remaining.0 = grant.remaining.0.saturating_add(op.amount.parse::<u128>().unwrap());
                grants().insert(&key, &grant);
            }
        }
    }

    fn owner(&self, token_id: &TokenId) -> AccountId {
        self.nft.owner_by_id.get(token_id).unwrap_or_else(|| env::panic_str("Token not minted"))
    }
    fn transferable(&self, token_id: &TokenId) -> Agent {
        require!(!governance::vault_upgrade_locked(token_id), "Vault upgrade in flight");
        let a = self.agents.get(token_id).unwrap_or_else(|| env::panic_str("Unknown agent"));
        require!(a.lifecycle == Lifecycle::Active && a.pending_op.is_none(), "Agent not transferable"); a
    }
    fn active_owner(&self, token_id: &TokenId) -> Agent {
        let a = self.transferable(token_id);
        require!(self.owner(token_id) == env::predecessor_account_id(), "Owner only"); a
    }
}

#[near]
impl NonFungibleTokenCore for Registry {
    #[payable]
    fn nft_transfer(&mut self, receiver_id: AccountId, token_id: TokenId, approval_id: Option<u64>, memo: Option<String>) {
        self.transferable(&token_id);
        self.nft.nft_transfer(receiver_id, token_id.clone(), approval_id, memo);
        let mut a = self.agents.get(&token_id).unwrap();
        a.epoch += 1; self.agents.insert(&token_id, &a);
        event("transfer_finalized", serde_json::json!({"token_id":token_id,"epoch":a.epoch}));
    }
    #[payable]
    fn nft_transfer_call(&mut self, receiver_id: AccountId, token_id: TokenId, approval_id: Option<u64>, memo: Option<String>, msg: String) -> PromiseOrValue<bool> {
        let mut a = self.transferable(&token_id);
        assert_one_yocto();
        a.lifecycle = Lifecycle::TransferCallPending;
        a.transfer_from = Some(self.owner(&token_id));
        a.transfer_to = Some(receiver_id.clone());
        self.agents.insert(&token_id, &a);
        let sender_id = env::predecessor_account_id();
        let (previous_owner_id, approvals) = self.nft.internal_transfer(&sender_id, &receiver_id, &token_id, approval_id, memo);
        let receiver_args = serde_json::json!({"sender_id":sender_id,"previous_owner_id":previous_owner_id,
            "token_id":token_id,"msg":msg});
        let resolve_args = serde_json::json!({"previous_owner_id":previous_owner_id,"receiver_id":receiver_id,
            "token_id":token_id,"approved_account_ids":approvals});
        Promise::new(receiver_id).function_call("nft_on_transfer".to_string(), receiver_args.to_string().into_bytes(),
            NearToken::from_yoctonear(0), Gas::from_tgas(80)).then(
                Promise::new(env::current_account_id()).function_call("nft_resolve_transfer".to_string(),
                    resolve_args.to_string().into_bytes(), NearToken::from_yoctonear(0), Gas::from_tgas(30))).into()
    }
    fn nft_token(&self, token_id: TokenId) -> Option<Token> { self.nft.nft_token(token_id) }
}

#[near]
impl NonFungibleTokenResolver for Registry {
    #[private]
    fn nft_resolve_transfer(&mut self, previous_owner_id: AccountId, receiver_id: AccountId,
        token_id: TokenId, approved_account_ids: Option<HashMap<AccountId,u64>>) -> bool {
        let mut a = self.agents.get(&token_id).unwrap_or_else(|| env::panic_str("Unknown transfer"));
        require!(a.lifecycle == Lifecycle::TransferCallPending && a.transfer_from == Some(previous_owner_id.clone())
            && a.transfer_to == Some(receiver_id.clone()), "Wrong transfer resolution");
        let kept = self.nft.nft_resolve_transfer(previous_owner_id, receiver_id, token_id.clone(), approved_account_ids);
        a.lifecycle = Lifecycle::Active; a.transfer_from = None; a.transfer_to = None;
        if kept { a.epoch += 1; }
        self.agents.insert(&token_id, &a);
        event(if kept { "transfer_finalized" } else { "transfer_rolled_back" },
            serde_json::json!({"token_id":token_id,"epoch":a.epoch}));
        kept
    }
}

#[near]
impl NonFungibleTokenApproval for Registry {
    #[payable]
    fn nft_approve(&mut self, token_id: TokenId, account_id: AccountId, msg: Option<String>) -> Option<Promise> {
        self.transferable(&token_id); self.nft.nft_approve(token_id, account_id, msg)
    }
    #[payable]
    fn nft_revoke(&mut self, token_id: TokenId, account_id: AccountId) {
        self.transferable(&token_id); self.nft.nft_revoke(token_id, account_id)
    }
    #[payable]
    fn nft_revoke_all(&mut self, token_id: TokenId) {
        self.transferable(&token_id); self.nft.nft_revoke_all(token_id)
    }
    fn nft_is_approved(&self, token_id: TokenId, approved_account_id: AccountId, approval_id: Option<u64>) -> bool {
        self.nft.nft_is_approved(token_id, approved_account_id, approval_id)
    }
}

#[near]
impl NonFungibleTokenEnumeration for Registry {
    fn nft_total_supply(&self) -> U128 { self.nft.nft_total_supply() }
    fn nft_tokens(&self, from_index: Option<U128>, limit: Option<u64>) -> Vec<Token> { self.nft.nft_tokens(from_index, limit) }
    fn nft_supply_for_owner(&self, account_id: AccountId) -> U128 { self.nft.nft_supply_for_owner(account_id) }
    fn nft_tokens_for_owner(&self, account_id: AccountId, from_index: Option<U128>, limit: Option<u64>) -> Vec<Token> {
        self.nft.nft_tokens_for_owner(account_id, from_index, limit)
    }
}

#[near]
impl NonFungibleTokenMetadataProvider for Registry {
    fn nft_metadata(&self) -> NFTContractMetadata { self.metadata.clone() }
}

fn op_key(token_id: &str, id: u64) -> String { format!("{}:{}",token_id,id) }
fn grant_key(token_id: &str, delegate: &AccountId, method: &str) -> String {
    format!("{}:{}:{}", token_id, delegate, method)
}
// Separate prefixes preserve the v1 Registry Borsh layout for a later explicit upgrade.
fn grants() -> LookupMap<String, Grant> { LookupMap::new(b"D") }
fn listings() -> LookupMap<TokenId, Listing> { LookupMap::new(b"L") }
fn listing_nonces() -> LookupMap<TokenId, u64> { LookupMap::new(b"Q") }
fn payouts() -> LookupMap<AccountId, Payout> { LookupMap::new(b"P") }
fn evm_operations() -> LookupMap<String, EvmOperation> { LookupMap::new(b"V") }
fn evm_nonces() -> LookupMap<TokenId, u64> { LookupMap::new(b"N") }
fn scout_jobs() -> LookupMap<String, ScoutJob> { LookupMap::new(b"J") }
fn incomes() -> LookupMap<TokenId, u128> { LookupMap::new(b"I") }
fn wallets() -> LookupMap<TokenId, DerivedWallet> { LookupMap::new(b"W") }
fn provision_deposits() -> LookupMap<TokenId, u128> { LookupMap::new(&b"provision:deposit:v1"[..]) }
fn ledger_totals() -> LookupMap<String, u128> { LookupMap::new(&b"ledger:totals:v1"[..]) }
/// NEAR this registry holds on behalf of others: escrowed job fees, unclaimed agent
/// income, refund and seller credits, recall deposits and failed-provision refunds.
/// Upgrades must initialize this from the previous contract's balances first.
fn liability_initialized() -> bool { ledger_totals().get(&"liabilities".to_string()).is_some() }
pub(crate) fn liability() -> u128 {
    ledger_totals().get(&"liabilities".to_string()).unwrap_or_else(||env::panic_str("Liability migration required"))
}
pub(crate) fn add_liability(amount: u128) {
    ledger_totals().insert(&"liabilities".to_string(), &liability().saturating_add(amount));
}
pub(crate) fn release_liability(amount: u128) {
    ledger_totals().insert(&"liabilities".to_string(), &liability().saturating_sub(amount));
}
/// Moves a job's storage fee from liabilities to the registry's own storage funds.
pub(crate) fn collect_storage(amount: u128) {
    release_liability(amount);
    let key = "storage_fees".to_string();
    ledger_totals().insert(&key, &ledger_totals().get(&key).unwrap_or(0).saturating_add(amount));
}
/// Charges a job's storage to the agent when the customer is refunded in full.
pub(crate) fn charge_storage_to_agent(token_id: &TokenId) -> u128 {
    let income = incomes().get(token_id).unwrap_or(0);
    let charged = job_storage_fee().min(income);
    incomes().insert(token_id, &(income - charged));
    collect_storage(charged);
    charged
}
fn chain_keys()->LookupMap<String,ChainKeyRecord>{LookupMap::new(&b"chain:key:v1"[..])}
fn chain_key_id(token_id:&str,chain:&str)->String{format!("{token_id}:{chain}")}
fn chain_key_record(wallet:&DerivedWallet)->ChainKeyRecord{
    ChainKeyRecord{chain:"eth-sepolia".into(),chain_id:wallet.chain_id,
        path:wallet.path.clone(),signer_id:wallet.signer_id.clone(),
        signer_version:"v1".into(),domain_id:wallet.domain_id,address:wallet.address.clone()}
}
fn valid_tx_hash(s: &str) -> bool {
    s.len() == 66 && s.starts_with("0x") && s[2..].bytes().all(|b| b.is_ascii_hexdigit())
}
fn valid_content_hash(s: &str) -> bool {
    s.len() == 71 && s.starts_with("sha256:") && s[7..].bytes().all(|b| b.is_ascii_hexdigit())
}
fn event(name: &str, data: serde_json::Value) {
    studio::audit(name,&data);
    env::log_str(&format!("EVENT_JSON:{}", serde_json::json!({"standard":"nfa","version":"1.0.0","event":name,"data":[data]})));
}
fn hex(bytes: &[u8]) -> String {
    const A: &[u8; 16] = b"0123456789abcdef"; let mut s=String::new();
    for b in bytes { s.push(A[(b>>4) as usize] as char); s.push(A[(b&15) as usize] as char); } s
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::{testing_env, test_vm_config, PromiseResult, RuntimeFeesConfig};
    use near_sdk::test_utils::VMContextBuilder;

    fn id(s: &str) -> AccountId { s.parse().unwrap() }
    const MIN_MARGIN_FOR_TESTS: u128 = 10_000_000_000_000_000_000_000;
    fn context(caller: &str, deposit: u128) -> VMContextBuilder {
        let mut b = VMContextBuilder::new();
        b.current_account_id(id("registry.testnet")).predecessor_account_id(id(caller))
            .signer_account_id(id(caller)).attached_deposit(NearToken::from_yoctonear(deposit))
            .account_balance(NearToken::from_near(20)).prepaid_gas(Gas::from_tgas(300)); b
    }
    fn registry() -> Registry {
        testing_env!(context("alice.testnet", 0).build());
        Registry::new(id("admin.testnet"),id("reporter.testnet"),id("guardian.testnet"))
    }
    fn minted() -> Registry {
        let mut r = registry(); let token_id = "nfa-1".to_owned();
        testing_env!(context("alice.testnet", NearToken::from_near(1).as_yoctonear()).build());
        r.nft.internal_mint(token_id.clone(), id("alice.testnet"), Some(TokenMetadata::default()));
        r.agents.insert(&token_id, &Agent { vault_id: id("nfa-1.registry.testnet"), epoch: 0,
            lifecycle: Lifecycle::Active, next_op_id: 1, pending_op: None,
            manifest_hash: "sha256:abc".into(), manifest_uri: "ipfs://a".into(),
            listing_price: None, transfer_from: None, transfer_to: None });
        r
    }
    fn research_setup()->(Registry,String,u128,u128){
        let (mut r,old,_,fee,deposit)=paid_setup();
        testing_env!(context("keeper.testnet",0).block_timestamp(600).build());r.expire_unstarted_paid_scout("nfa-1".into(),old);
        research::mark_capable(&"nfa-1".into());
        testing_env!(context("alice.testnet",1).block_timestamp(600).build());
        r.configure_research("nfa-1".into(),research::ResearchSettings{version_key:"a".repeat(64),
            secrets_ref:research::SecretsReference{account_id:id("operator.testnet"),profile:"inference".into()},
            allowed_sources:vec![research::SourceRule{host:"docs.near.org".into(),path_prefix:"/".into()}],model:"reviewed-model".into(),
            max_input_tokens:24_000,max_output_tokens:512,input_microusd_per_token:1,output_microusd_per_token:2,
            max_cost_microusd:30_000,daily_budget_microusd:60_000});
        r.configure_service("nfa-1".into(),"research".into(),format!("sha256:{}","a".repeat(64)),true,U128(10_000_000_000_000_000_000_000),
            U128(deposit),outlayer::SkillLimits{max_instructions:1_000_000,max_memory_mb:64,max_execution_seconds:10});
        let input=serde_json::json!({"question":"What is a stable vault?","sources":[{"title":"Vault","url":"https://docs.near.org/vault"}]}).to_string();
        (r,input,fee,deposit)
    }
    #[test]
    fn research_quote_pins_config_and_dispatches_only_owner_secret_reference(){
        let (mut r,input,fee,deposit)=research_setup();let cfg=r.research_config("nfa-1".into()).unwrap();
        let next=r.agent("nfa-1".into()).unwrap().next_op_id;
        let limits=outlayer::SkillLimits{max_instructions:1_000_000,max_memory_mb:64,max_execution_seconds:10};
        testing_env!(context("customer.testnet",fee).block_timestamp(600).build());
        let rejected=std::panic::catch_unwind(std::panic::AssertUnwindSafe(||r.request_reviewed_service_job("nfa-1".into(),"research".into(),
            format!("sha256:{}",hex(&env::sha256(input.as_bytes()))),1000,U128(fee),U128(deposit),U128(deposit),limits.clone(),"a".repeat(64),1,Some(format!("sha256:{}","b".repeat(64))))));
        assert!(rejected.is_err());assert_eq!(r.agent("nfa-1".into()).unwrap().next_op_id,next);
        let job=r.request_reviewed_service_job("nfa-1".into(),"research".into(),format!("sha256:{}",hex(&env::sha256(input.as_bytes()))),
            1000,U128(fee),U128(deposit),U128(deposit),limits,"a".repeat(64),1,Some(cfg.configuration_hash.clone()));
        assert_eq!(r.research_usage("nfa-1".into(),job).unwrap().reserved_microusd,25_024);
        testing_env!(context("customer.testnet",0).block_timestamp(600).build());
        let _=r.start_service_job("nfa-1".into(),job,input);
        let receipts=near_sdk::test_utils::get_created_receipts();
        let args=receipts.iter().flat_map(|r|r.actions.iter()).find_map(|a|match a{
            near_sdk::mock::MockAction::FunctionCallWeight{method_name,args,..} if method_name==b"execute_research_skill"=>Some(serde_json::from_slice::<serde_json::Value>(args).unwrap()),_=>None}).unwrap();
        assert_eq!(args["secrets_ref"]["account_id"],"operator.testnet");
        let payload:serde_json::Value=serde_json::from_str(args["input_data"].as_str().unwrap()).unwrap();
        assert_eq!(payload["context"]["vaultAccountId"],"nfa-1.registry.testnet");assert_eq!(payload["research"]["configuration_hash"],cfg.configuration_hash);
        assert_eq!(r.outlayer_project("nfa-1".into()).unwrap().project_uuid,"p0001");
    }
    #[test]
    fn async_research_settles_once_and_buyer_inherits_finalized_context(){
        let (mut r,input,fee,deposit)=research_setup();
        outlayer::tests_support::ready_key("nfa-1",0);
        let cfg=r.research_config("nfa-1".into()).unwrap();
        let limits=outlayer::SkillLimits{max_instructions:1_000_000,max_memory_mb:64,max_execution_seconds:10};
        testing_env!(context("customer.testnet",fee).block_timestamp(600).build());
        let job=r.request_reviewed_service_job("nfa-1".into(),"research".into(),
            format!("sha256:{}",hex(&env::sha256(input.as_bytes()))),1000,U128(fee),U128(deposit),U128(deposit),
            limits.clone(),"a".repeat(64),1,Some(cfg.configuration_hash.clone()));
        testing_env!(context("customer.testnet",0).block_timestamp(601).build());
        let execution=r.prepare_async_research_job("nfa-1".into(),job,input.clone());
        assert_eq!(r.paid_scout_job("nfa-1".into(),job).unwrap().status,"ASYNC_PREPARED");
        assert!(near_sdk::test_utils::get_created_receipts().is_empty(),"Preparing must not dispatch a second run");
        let before=r.paid_scout_ledger();assert_eq!(before.customer_escrow.0,fee);
        testing_env!(context("alice.testnet",1).build());
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(||
            r.nft_transfer(id("bob.testnet"),"nfa-1".into(),None,None))).is_err());
        let hash=format!("sha256:{}",hex(&env::sha256(execution.as_bytes())));
        let call="11111111-2222-3333-4444-555555555555".to_string();
        testing_env!(context("customer.testnet",0).block_timestamp(602).build());
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(||r.bind_async_research_call(
            "nfa-1".into(),job,call.clone(),hash.clone(),"a".repeat(64),0))).is_err());
        testing_env!(context("reporter.testnet",0).block_timestamp(602).build());
        r.bind_async_research_call("nfa-1".into(),job,call.clone(),hash.clone(),"a".repeat(64),0);
        let output_hash=format!("sha256:{}","b".repeat(64));
        let output=serde_json::json!({"schemaVersion":1,"jobId":job,"status":"ok",
            "outputHash":output_hash,"outputUri":format!("nfa://work/{}","b".repeat(64)),
            "inferenceOutcome":"succeeded","pricedUsageMicrousd":2000});
        assert!(r.settle_async_research_job("nfa-1".into(),job,call.clone(),hash,"a".repeat(64),0,Some(output),1000));
        assert_eq!(r.paid_scout_job("nfa-1".into(),job).unwrap().status,"FINALIZED");
        assert_eq!(r.research_usage("nfa-1".into(),job).unwrap().state,"PRICED_USAGE");
        assert_eq!(r.paid_scout_ledger().customer_escrow.0,0);
        assert!(r.payout(id("reporter.testnet")).available.0>0);
        assert!(r.agent_income("nfa-1".into()).0>0);
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(||r.settle_async_research_job(
            "nfa-1".into(),job,call,"sha256:wrong".into(),"a".repeat(64),0,None,1000))).is_err());
        testing_env!(context("alice.testnet",1).block_timestamp(603).build());
        r.nft_transfer(id("bob.testnet"),"nfa-1".into(),None,None);
        testing_env!(context("other-customer.testnet",fee).block_timestamp(604).build());
        let next=r.request_reviewed_service_job("nfa-1".into(),"research".into(),
            format!("sha256:{}",hex(&env::sha256(input.as_bytes()))),1000,U128(fee),U128(deposit),U128(deposit),
            limits,"a".repeat(64),1,Some(cfg.configuration_hash));
        testing_env!(context("other-customer.testnet",0).block_timestamp(605).build());
        let next_execution=r.prepare_async_research_job("nfa-1".into(),next,input);
        let value:serde_json::Value=serde_json::from_str(&next_execution).unwrap();
        assert_eq!(value["context"]["ownerEpoch"],1);
        assert_eq!(value["context"]["priorWork"][0]["jobId"],job);
        assert_eq!(value["context"]["priorWork"][0]["outputHash"],output_hash);
    }
    #[test]
    fn async_research_timeout_refunds_and_rejects_late_result(){
        let (mut r,input,fee,deposit)=research_setup();outlayer::tests_support::ready_key("nfa-1",0);
        let before_refund=r.payout(id("customer.testnet")).available.0;
        let cfg=r.research_config("nfa-1".into()).unwrap();
        testing_env!(context("customer.testnet",fee).block_timestamp(600).build());
        let job=r.request_reviewed_service_job("nfa-1".into(),"research".into(),
            format!("sha256:{}",hex(&env::sha256(input.as_bytes()))),1000,U128(fee),U128(deposit),U128(deposit),
            outlayer::SkillLimits{max_instructions:1_000_000,max_memory_mb:64,max_execution_seconds:10},
            "a".repeat(64),1,Some(cfg.configuration_hash));
        testing_env!(context("customer.testnet",0).block_timestamp(601).build());
        let execution=r.prepare_async_research_job("nfa-1".into(),job,input);
        let hash=format!("sha256:{}",hex(&env::sha256(execution.as_bytes())));
        let call="11111111-2222-3333-4444-555555555555".to_string();
        testing_env!(context("reporter.testnet",0).block_timestamp(602).build());
        r.bind_async_research_call("nfa-1".into(),job,call.clone(),hash.clone(),"a".repeat(64),0);
        testing_env!(context("keeper.testnet",0).block_timestamp(900_000_000_600).build());
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(||
            r.release_async_research_job("nfa-1".into(),job))).is_err());
        testing_env!(context("keeper.testnet",0).block_timestamp(900_000_000_601).build());
        r.release_async_research_job("nfa-1".into(),job);
        assert_eq!(r.paid_scout_job("nfa-1".into(),job).unwrap().status,"FAILED");
        assert_eq!(r.research_usage("nfa-1".into(),job).unwrap().state,"UNKNOWN");
        assert_eq!(r.paid_scout_ledger().customer_escrow.0,0);
        assert_eq!(r.payout(id("customer.testnet")).available.0,before_refund+fee);
        testing_env!(context("reporter.testnet",0).block_timestamp(900_000_000_602).build());
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(||r.settle_async_research_job(
            "nfa-1".into(),job,call,hash,"a".repeat(64),0,None,1000))).is_err());
        testing_env!(context("alice.testnet",1).block_timestamp(900_000_000_603).build());
        let _=r.resume_failed_service("nfa-1".into(),job);
        let resume=r.agent("nfa-1".into()).unwrap().pending_op.unwrap();
        testing_env!(context("registry.testnet",0).build(),test_vm_config(),RuntimeFeesConfig::test(),Default::default(),
            vec![PromiseResult::Successful(serde_json::to_vec(&serde_json::json!({
                "controller":"registry.testnet","pending":{"Evm":{}},"next_operation_id":job})).unwrap())]);
        assert!(!r.on_service_resume("nfa-1".into(),resume));
        testing_env!(context("registry.testnet",0).build(),test_vm_config(),RuntimeFeesConfig::test(),Default::default(),
            vec![PromiseResult::Successful(serde_json::to_vec(&serde_json::json!({
                "controller":"registry.testnet","pending":null,"next_operation_id":job})).unwrap())]);
        assert!(r.on_service_resume("nfa-1".into(),resume),"An idle vault may recover a failed HTTPS job without a vault execution counter");
        assert_eq!(r.agent("nfa-1".into()).unwrap().lifecycle,Lifecycle::Active);
    }
    #[test]
    fn old_vault_requires_explicit_successful_compatibility_probe(){
        let mut r=minted();let token="nfa-1".to_string();
        let status=serde_json::json!({"controller":"registry.testnet","reporter":"reporter.testnet",
            "guardian":"guardian.testnet","pending":null,"path":"eth-sepolia-v1","chain_id":11155111});
        for result in [PromiseResult::Failed,PromiseResult::Successful(status.to_string().into_bytes())]{
            testing_env!(context("alice.testnet",1).build());let _=r.verify_research_vault(token.clone());
            let op=r.agent(token.clone()).unwrap().pending_op.unwrap();
            testing_env!(context("registry.testnet",0).build(),test_vm_config(),RuntimeFeesConfig::test(),Default::default(),vec![result]);
            assert!(!r.on_research_vault_verified(token.clone(),op));
            assert!(r.agent(token.clone()).unwrap().pending_op.is_none());assert!(!r.research_vault_capable(token.clone()));
        }
        testing_env!(context("alice.testnet",1).build());let _=r.verify_research_vault(token.clone());
        let op=r.agent(token.clone()).unwrap().pending_op.unwrap();let mut upgraded=status;upgraded["research_interface"]=serde_json::json!(1);
        testing_env!(context("registry.testnet",0).build(),test_vm_config(),RuntimeFeesConfig::test(),Default::default(),
            vec![PromiseResult::Successful(upgraded.to_string().into_bytes())]);
        assert!(r.on_research_vault_verified(token.clone(),op));assert!(r.research_vault_capable(token));
    }
    #[test]
    fn research_daily_allowance_is_conservative_and_rolls_over(){
        let (r,_,_,_)=research_setup();let token="nfa-1".to_string();
        let (c1,c2,c3)=(id("c1.testnet"),id("c2.testnet"),id("c3.testnet"));
        r.reserve_research(&token,100,&"a".repeat(64),&c1);r.reserve_research(&token,101,&"a".repeat(64),&c2);
        assert_eq!(r.research_budget(token.clone()).reserved_microusd,50_048);
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(||r.reserve_research(&token,102,&"a".repeat(64),&c3))).is_err());
        assert!(r.research_usage(token.clone(),102).is_none());
        testing_env!(context("keeper.testnet",0).block_timestamp(86_400_000_000_001).build());
        r.reserve_research(&token,102,&"a".repeat(64),&c3);assert_eq!(r.research_budget(token).reserved_microusd,25_024);
    }
    #[test]
    fn research_unknown_cost_is_reserved_once_and_does_not_enter_finalized_memory(){
        let (mut r,input,fee,deposit)=research_setup();let cfg=r.research_config("nfa-1".into()).unwrap();
        let previous_refunds=r.payout("customer.testnet".parse().unwrap()).available.0;
        testing_env!(context("customer.testnet",fee).block_timestamp(600).build());
        let id=r.request_reviewed_service_job("nfa-1".into(),"research".into(),format!("sha256:{}",hex(&env::sha256(input.as_bytes()))),1000,U128(fee),U128(deposit),U128(deposit),
            outlayer::SkillLimits{max_instructions:1_000_000,max_memory_mb:64,max_execution_seconds:10},"a".repeat(64),1,Some(cfg.configuration_hash));
        let _=r.start_service_job("nfa-1".into(),id,input);
        testing_env!(context("nfa-1.registry.testnet",0).block_timestamp(600).build());
        let _=r.on_outlayer_job("nfa-1".into(),id,Some(serde_json::json!({"schemaVersion":1,"jobId":id,"status":"failed","inferenceOutcome":"unknown"})));
        assert_eq!(r.research_usage("nfa-1".into(),id).unwrap().state,"UNKNOWN");
        assert_eq!(r.research_budget("nfa-1".into()).reserved_microusd,25_024);
        assert_eq!(r.paid_scout_job("nfa-1".into(),id).unwrap().status,"FAILED");
        assert_eq!(r.payout("customer.testnet".parse().unwrap()).available.0,previous_refunds+fee);
    }
    #[test]
    #[should_panic(expected="Job input/stage mismatch")]
    fn research_job_cannot_start_under_a_stale_owner_epoch(){
        let (mut r,input,fee,deposit)=research_setup();let cfg=r.research_config("nfa-1".into()).unwrap();
        testing_env!(context("customer.testnet",fee).block_timestamp(600).build());
        let id=r.request_reviewed_service_job("nfa-1".into(),"research".into(),format!("sha256:{}",hex(&env::sha256(input.as_bytes()))),
            1000,U128(fee),U128(deposit),U128(deposit),outlayer::SkillLimits{max_instructions:1_000_000,max_memory_mb:64,max_execution_seconds:10},
            "a".repeat(64),1,Some(cfg.configuration_hash));
        // Fault-injection fixture: ordinary NFT transfers are already blocked by this pending job.
        let mut a=r.agent("nfa-1".into()).unwrap();a.epoch+=1;r.agents.insert(&"nfa-1".to_string(),&a);
        let _=r.start_service_job("nfa-1".into(),id,input);
    }
    #[test]
    #[should_panic(expected="Owner only")]
    fn previous_owner_cannot_replace_research_credential_after_sale(){
        let (mut r,_,_,_)=research_setup();let settings=r.research_config("nfa-1".into()).unwrap().settings;
        testing_env!(context("alice.testnet",1).build());r.nft_transfer(id("bob.testnet"),"nfa-1".into(),None,None);
        r.configure_research("nfa-1".into(),settings);
    }
    fn pin_test_wallet() {
        wallets().insert(&"nfa-1".into(), &DerivedWallet { chain_id: 11_155_111,
            signer_id: id("v1.signer-prod.testnet"), path: "eth-sepolia-v1".into(), domain_id: 0,
            public_key: "secp256k1:test".into(), address: "0x1111111111111111111111111111111111111111".into() });
    }
    fn paid_setup() -> (Registry,u64,String,u128,u128) {
        let mut r=minted();
        testing_env!(context("alice.testnet",1).build());
        let _=r.provision_outlayer("nfa-1".into(),"https://test.fastfs.io/scout.wasm".into(),"a".repeat(64),U128(100));
        let record=serde_json::json!({"project_id":"nfa-1.registry.testnet/scout","project_uuid":"p0001"});
        testing_env!(context("registry.testnet",0).build(),test_vm_config(),RuntimeFeesConfig::test(),
            Default::default(),vec![PromiseResult::Successful(record.to_string().into_bytes())]);
        assert!(r.on_outlayer_project("nfa-1".into(),1));
        let deposit=NearToken::from_millinear(100).as_yoctonear();
        let fee=NearToken::from_millinear(150).as_yoctonear();
        let input=serde_json::json!({"question":"Why is the vault stable?",
            "sources":[{"title":"Vault","url":"https://example.org/vault",
            "text":"The vault account stays the same when the NFT owner changes, and the new owner can control its funds."}]}).to_string();
        let input_hash=format!("sha256:{}",hex(&env::sha256(input.as_bytes())));
        testing_env!(context("alice.testnet",1).build());
        r.configure_service("nfa-1".into(),"scout".into(),format!("sha256:{}","a".repeat(64)),true,
            U128(MIN_MARGIN_FOR_TESTS),U128(deposit),
            outlayer::SkillLimits{max_instructions:1_000_000,max_memory_mb:64,max_execution_seconds:10});
        testing_env!(context("customer.testnet",fee).build());
        let id=r.request_paid_scout("nfa-1".into(),input_hash,500,U128(fee),U128(deposit),U128(deposit),
            outlayer::SkillLimits{max_instructions:1_000_000,max_memory_mb:64,max_execution_seconds:10});
        (r,id,input,fee,deposit)
    }

    #[test]
    fn one_project_dispatches_compare_with_pinned_service_policy(){
        let (mut r,first,_,fee,deposit)=paid_setup();
        testing_env!(context("keeper.testnet",0).block_timestamp(600).build());
        r.expire_unstarted_paid_scout("nfa-1".into(),first);
        let schema=format!("sha256:{}","b".repeat(64));
        testing_env!(context("alice.testnet",1).build());
        let policy=r.configure_service("nfa-1".into(),"compare".into(),schema,true,
            U128(NearToken::from_millinear(50).as_yoctonear()),U128(deposit),
            outlayer::SkillLimits{max_instructions:1_000_000,max_memory_mb:64,max_execution_seconds:10});
        assert_eq!(policy.version,1);
        let input=serde_json::json!({"question":"Which choice has cost evidence?","criteria":["cost"],
            "sources":[{"title":"A","url":"https://example.org/a","text":"The cost of option A is five units for a single run."},
                {"title":"B","url":"https://example.org/b","text":"The cost of option B is seven units for a single run."}]}).to_string();
        let input_hash=format!("sha256:{}",hex(&env::sha256(input.as_bytes())));
        testing_env!(context("customer.testnet",fee).build());
        let id=r.request_service_job("nfa-1".into(),"compare".into(),input_hash,500,
            U128(fee),U128(deposit),U128(deposit),policy.limits.clone());
        assert_eq!(r.service_ledger("compare".into()).customer_escrow,U128(fee));
        // The unstarted Scout job returned its execution deposit; its margin paid storage and the agent.
        assert_eq!(r.service_ledger("scout".into()).customer_refunds,U128(deposit));
        assert_eq!(r.service_job("nfa-1".into(),id).unwrap()["service_id"],"compare");
        assert_eq!(r.service_job("nfa-1".into(),id).unwrap()["policy_version"],1);
        assert_eq!(r.outlayer_project("nfa-1".into()).unwrap().project_uuid,"p0001");
        testing_env!(context("keeper.testnet",0).build());
        let _=r.start_service_job("nfa-1".into(),id,input);
        assert_eq!(r.paid_scout_job("nfa-1".into(),id).unwrap().status,"EXECUTING");
        let output=serde_json::json!({"schemaVersion":1,"jobId":id,"status":"ok",
            "outputHash":format!("sha256:{}","f".repeat(64)),
            "outputUri":format!("nfa://work/{}","f".repeat(64))});
        testing_env!(context("nfa-1.registry.testnet",0).build());
        assert!(matches!(r.on_outlayer_job("nfa-1".into(),id,Some(output)),PromiseOrValue::Promise(_)));
        assert_eq!(r.service_ledger("compare".into()).vault_replenishment_pending,U128(deposit));
        testing_env!(context("registry.testnet",0).build(),test_vm_config(),RuntimeFeesConfig::test(),
            Default::default(),vec![PromiseResult::Successful(vec![])]);
        let _=r.on_outlayer_replenished("nfa-1".into(),id);
        assert_eq!(r.service_ledger("compare".into()).gross_finalized_receipts,U128(fee));
        assert_eq!(r.service_ledger("compare".into()).customer_escrow,U128(0));
        testing_env!(context("alice.testnet",1).build());
        r.nft_transfer("bob.testnet".parse().unwrap(),"nfa-1".into(),None,None);
        testing_env!(context("bob.testnet",deposit).build());
        let _=r.recall_owner_memory("nfa-1".into(),id,U128(deposit));
    }

    #[test]
    #[should_panic(expected="Service not configured")]
    fn compare_requires_owner_configured_service(){
        let (mut r,first,_,fee,deposit)=paid_setup();
        testing_env!(context("keeper.testnet",0).block_timestamp(600).build());
        r.expire_unstarted_paid_scout("nfa-1".into(),first);
        testing_env!(context("customer.testnet",fee).build());
        let _=r.request_service_job("nfa-1".into(),"compare".into(),format!("sha256:{}","a".repeat(64)),500,
            U128(fee),U128(deposit),U128(deposit),outlayer::SkillLimits{
                max_instructions:1_000_000,max_memory_mb:64,max_execution_seconds:10});
    }

    #[test]
    #[should_panic(expected="Service policy exceeded")]
    fn legacy_scout_entry_respects_new_owner_fee_floor(){
        let (mut r,first,_,fee,deposit)=paid_setup();
        testing_env!(context("keeper.testnet",0).block_timestamp(600).build());
        r.expire_unstarted_paid_scout("nfa-1".into(),first);
        testing_env!(context("alice.testnet",1).build());
        r.configure_service("nfa-1".into(),"scout".into(),format!("sha256:{}","a".repeat(64)),true,
            U128(NearToken::from_millinear(60).as_yoctonear()),U128(deposit),
            outlayer::SkillLimits{max_instructions:1_000_000,max_memory_mb:64,max_execution_seconds:10});
        testing_env!(context("customer.testnet",fee).build());
        let _=r.request_paid_scout("nfa-1".into(),format!("sha256:{}","a".repeat(64)),500,
            U128(fee),U128(deposit),U128(deposit),outlayer::SkillLimits{
                max_instructions:1_000_000,max_memory_mb:64,max_execution_seconds:10});
    }

    #[test]
    fn paid_outlayer_job_keeps_escrow_until_reimbursement_then_follows_sale() {
        let (mut r,job_id,input,fee,deposit)=paid_setup();
        assert_eq!(r.paid_scout_ledger().customer_escrow,U128(fee));
        testing_env!(context("keeper.testnet",0).build());
        let _=r.start_paid_scout("nfa-1".into(),job_id,input);
        let output=serde_json::json!({"schemaVersion":1,"jobId":job_id,"status":"ok",
            "outputHash":format!("sha256:{}","f".repeat(64)),"outputUri":format!("nfa://work/{}","f".repeat(64))});
        testing_env!(context("nfa-1.registry.testnet",0).build());
        assert!(matches!(r.on_outlayer_job("nfa-1".into(),job_id,Some(output)),PromiseOrValue::Promise(_)));
        assert_eq!(r.agent_income("nfa-1".into()),U128(0));
        assert_eq!(r.paid_scout_ledger().vault_replenishment_pending,U128(deposit));
        testing_env!(context("registry.testnet",0).build(),test_vm_config(),RuntimeFeesConfig::test(),
            Default::default(),vec![PromiseResult::Successful(vec![])]);
        assert!(matches!(r.on_outlayer_replenished("nfa-1".into(),job_id),PromiseOrValue::Promise(_)));
        assert_eq!(r.paid_scout_job("nfa-1".into(),job_id).unwrap().status,"FINALIZED");
        assert_eq!(r.agent_income("nfa-1".into()),U128(fee-deposit-job_storage_fee()));
        assert_eq!(r.paid_scout_ledger().customer_escrow,U128(0));
        testing_env!(context("alice.testnet",1).build());
        r.nft_transfer(id("bob.testnet"),"nfa-1".into(),None,None);
        testing_env!(context("bob.testnet",0).build());
        assert!(r.owner_memory_receipt("nfa-1".into(),job_id).is_some());
    }

    #[test]
    fn hired_job_spends_capped_income_and_refund_follows_hiring_nft() {
        let (mut r,old,_,fee,deposit)=paid_setup();
        testing_env!(context("keeper.testnet",0).block_timestamp(600).build());
        r.expire_unstarted_paid_scout("nfa-1".into(),old);
        let source="nfa-2".to_string();
        testing_env!(context("bob.testnet",NearToken::from_near(1).as_yoctonear()).build());
        r.nft.internal_mint(source.clone(),id("bob.testnet"),Some(TokenMetadata::default()));
        r.agents.insert(&source,&Agent{vault_id:id("nfa-2.registry.testnet"),epoch:0,
            lifecycle:Lifecycle::Active,next_op_id:1,pending_op:None,manifest_hash:"sha256:abc".into(),
            manifest_uri:"ipfs://b".into(),listing_price:None,transfer_from:None,transfer_to:None});
        incomes().insert(&source,&fee);add_liability(fee);
        let input=serde_json::json!({"question":"Why is the vault stable?","sources":[]}).to_string();
        let input_hash=format!("sha256:{}",hex(&env::sha256(input.as_bytes())));
        let limits=outlayer::SkillLimits{max_instructions:1_000_000,max_memory_mb:64,max_execution_seconds:10};
        let before=liability();
        let storage_before=env::storage_usage();
        testing_env!(context("bob.testnet",1).block_timestamp(600).storage_usage(storage_before).build());
        r.grant_delegate(source.clone(),id("worker.testnet"),"NFA_HIRE".into(),Some(id("nfa-1")),U128(fee*2),1000);
        let storage_after_grant=env::storage_usage();
        testing_env!(context("worker.testnet",1).block_timestamp(600).storage_usage(storage_after_grant).build());
        let job_id=r.hire_reviewed_service_job(source.clone(),"nfa-1".into(),"scout".into(),input_hash,
            1000,U128(fee),U128(deposit),U128(deposit),limits,"a".repeat(64),1,None,0,U128(fee));
        assert_eq!(r.agent_income(source.clone()),U128(0));
        assert_eq!(liability(),before);
        assert_eq!(r.grant(source.clone(),id("worker.testnet"),"NFA_HIRE".into()).unwrap().remaining,U128(fee));
        assert_eq!(r.service_job("nfa-1".into(),job_id).unwrap()["hired_by"],source);
        let storage_after_request=env::storage_usage();
        testing_env!(context("alice.testnet",1).block_timestamp(600).storage_usage(storage_after_request).build());
        r.cancel_unstarted_job("nfa-1".into(),job_id);
        assert!(u128::from(env::storage_usage()-storage_after_grant)<=JOB_STORAGE_BYTES,
            "hired job exceeded paid storage bound");
        assert_eq!(r.agent_income(source.clone()),U128(fee));
        assert_eq!(r.payout(id("bob.testnet")).available,U128(0));
        testing_env!(context("bob.testnet",1).build());
        r.nft_transfer(id("carol.testnet"),source.clone(),None,None);
        let attempt=|registry:&mut Registry,epoch,cap|registry.hire_reviewed_service_job(source.clone(),
            "nfa-1".into(),"scout".into(),format!("sha256:{}","a".repeat(64)),1000,
            U128(fee),U128(deposit),U128(deposit),
            outlayer::SkillLimits{max_instructions:1_000_000,max_memory_mb:64,max_execution_seconds:10},
            "a".repeat(64),1,None,epoch,U128(cap));
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(||attempt(&mut r,0,fee))).is_err());
        testing_env!(context("worker.testnet",1).build());
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(||attempt(&mut r,1,fee))).is_err(),
            "old-epoch delegate retained authority after sale");
        testing_env!(context("carol.testnet",1).build());
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(||attempt(&mut r,0,fee))).is_err());
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(||attempt(&mut r,1,fee-1))).is_err());
        assert_eq!(r.agent_income(source.clone()),U128(fee));
        r.claim_income(source.clone(),U128(fee));
        assert_eq!(r.payout(id("carol.testnet")).available,U128(fee));
    }
    #[test]
    fn hired_job_partial_refund_returns_to_source_income() {
        let (mut r,old,input,fee,deposit)=paid_setup();
        testing_env!(context("keeper.testnet",0).block_timestamp(600).build());
        r.expire_unstarted_paid_scout("nfa-1".into(),old);
        let source="nfa-2".to_string();
        testing_env!(context("bob.testnet",NearToken::from_near(1).as_yoctonear()).build());
        r.nft.internal_mint(source.clone(),id("bob.testnet"),Some(TokenMetadata::default()));
        r.agents.insert(&source,&Agent{vault_id:id("nfa-2.registry.testnet"),epoch:0,
            lifecycle:Lifecycle::Active,next_op_id:1,pending_op:None,manifest_hash:"sha256:abc".into(),
            manifest_uri:"ipfs://b".into(),listing_price:None,transfer_from:None,transfer_to:None});
        incomes().insert(&source,&fee);add_liability(fee);
        let initial=liability();
        testing_env!(context("bob.testnet",1).block_timestamp(600).build());
        let job_id=r.hire_reviewed_service_job(source.clone(),"nfa-1".into(),"scout".into(),
            format!("sha256:{}",hex(&env::sha256(input.as_bytes()))),1000,U128(fee),U128(deposit),
            U128(deposit),outlayer::SkillLimits{max_instructions:1_000_000,max_memory_mb:64,max_execution_seconds:10},
            "a".repeat(64),1,None,0,U128(fee));
        testing_env!(context("keeper.testnet",0).block_timestamp(700).build());
        let _=r.start_service_job("nfa-1".into(),job_id,input);
        testing_env!(context("nfa-1.registry.testnet",0).block_timestamp(700).build());
        let _=r.on_outlayer_job("nfa-1".into(),job_id,Some(serde_json::json!({
            "schemaVersion":1,"jobId":job_id,"status":"failed","fault":"customer"})));
        testing_env!(context("registry.testnet",0).build(),test_vm_config(),RuntimeFeesConfig::test(),
            Default::default(),vec![PromiseResult::Successful(vec![])]);
        let _=r.on_outlayer_replenished("nfa-1".into(),job_id);
        let refund=fee-deposit-job_storage_fee();
        assert_eq!(r.agent_income(source),U128(refund));
        assert_eq!(r.payout(id("bob.testnet")).available,U128(0));
        assert_eq!(r.service_job("nfa-1".into(),job_id).unwrap()["refund_credit"],refund.to_string());
        assert_eq!(liability(),initial-deposit-job_storage_fee());
    }

    #[test]
    fn failed_reimbursement_reserves_funds_for_retry() {
        let (mut r,job_id,input,fee,deposit)=paid_setup();
        testing_env!(context("keeper.testnet",0).build());let _=r.start_paid_scout("nfa-1".into(),job_id,input);
        let output=serde_json::json!({"schemaVersion":1,"jobId":job_id,"status":"ok",
            "outputHash":format!("sha256:{}","f".repeat(64)),"outputUri":format!("nfa://work/{}","f".repeat(64))});
        testing_env!(context("nfa-1.registry.testnet",0).build());let _=r.on_outlayer_job("nfa-1".into(),job_id,Some(output));
        testing_env!(context("registry.testnet",0).build(),test_vm_config(),RuntimeFeesConfig::test(),
            Default::default(),vec![PromiseResult::Failed]);
        assert!(matches!(r.on_outlayer_replenished("nfa-1".into(),job_id),PromiseOrValue::Value(false)));
        assert_eq!(r.paid_scout_ledger().customer_escrow,U128(fee));
        assert_eq!(r.paid_scout_ledger().vault_replenishment_pending,U128(deposit));
        testing_env!(context("keeper.testnet",0).build());let _=r.retry_outlayer_replenishment("nfa-1".into(),job_id);
        testing_env!(context("registry.testnet",0).build(),test_vm_config(),RuntimeFeesConfig::test(),
            Default::default(),vec![PromiseResult::Successful(vec![])]);
        let _=r.on_outlayer_replenished("nfa-1".into(),job_id);
        assert_eq!(r.agent_income("nfa-1".into()),U128(fee-deposit-job_storage_fee()));
    }

    #[test]
    fn operator_fault_failure_refunds_customer_in_full_and_drains() {
        let (mut r,job_id,input,fee,_)=paid_setup();
        testing_env!(context("keeper.testnet",0).build());let _=r.start_paid_scout("nfa-1".into(),job_id,input);
        let result=serde_json::json!({"schemaVersion":1,"jobId":job_id,"status":"failed","fault":"operator"});
        testing_env!(context("nfa-1.registry.testnet",0).build());
        assert!(matches!(r.on_outlayer_job("nfa-1".into(),job_id,Some(result)),PromiseOrValue::Promise(_)));
        assert_eq!(r.payout(id("customer.testnet")).available,U128(fee));
        assert_eq!(r.paid_scout_ledger().customer_refunds,U128(fee));
        assert_eq!(r.agent_income("nfa-1".into()),U128(0));
        assert_eq!(r.agent("nfa-1".into()).unwrap().lifecycle,Lifecycle::Draining);
    }

    // ---- H2: a failure caused by the customer's input pays for the compute it used ----
    #[test]
    fn customer_fault_failure_reimburses_vault_and_keeps_agent_available() {
        let (mut r,job_id,input,fee,deposit)=paid_setup();
        testing_env!(context("keeper.testnet",0).build());let _=r.start_paid_scout("nfa-1".into(),job_id,input);
        // Older guests report no fault; a Scout failure comes from typed customer input.
        let result=serde_json::json!({"schemaVersion":1,"jobId":job_id,"status":"failed"});
        testing_env!(context("nfa-1.registry.testnet",0).build());
        assert!(matches!(r.on_outlayer_job("nfa-1".into(),job_id,Some(result)),PromiseOrValue::Promise(_)));
        assert_eq!(r.paid_scout_job("nfa-1".into(),job_id).unwrap().status,"RECONCILING");
        assert_eq!(r.payout(id("customer.testnet")).available,U128(0),"No refund before the vault is reimbursed");
        testing_env!(context("registry.testnet",0).build(),test_vm_config(),RuntimeFeesConfig::test(),
            Default::default(),vec![PromiseResult::Successful(vec![])]);
        let _=r.on_outlayer_replenished("nfa-1".into(),job_id);
        let refund=fee-deposit-job_storage_fee();
        assert_eq!(r.paid_scout_job("nfa-1".into(),job_id).unwrap().status,"FAILED");
        assert_eq!(r.payout(id("customer.testnet")).available,U128(refund));
        assert_eq!(r.paid_scout_ledger().customer_refunds,U128(refund));
        assert_eq!(r.paid_scout_ledger().customer_escrow,U128(0));
        assert_eq!(r.agent_income("nfa-1".into()),U128(0));
        let a=r.agent("nfa-1".into()).unwrap();assert!(a.pending_op.is_none());assert_eq!(a.lifecycle,Lifecycle::Active);
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(||r.owner_memory_receipt("nfa-1".into(),job_id))).is_err());
    }
    #[test]
    fn research_fault_defaults_follow_inference_outcome(){
        use outlayer::tests_support::fault;
        for (service,outcome,expected) in [("research","not_started","operator"),("research","unknown","operator"),
            ("research","succeeded","customer"),("scout","","customer"),("compare","","customer")]{
            assert_eq!(fault(service,&serde_json::json!({"status":"failed","inferenceOutcome":outcome})),expected,"{service}/{outcome}");
        }
        assert_eq!(fault("research",&serde_json::json!({"inferenceOutcome":"succeeded","fault":"operator"})),"operator");
        assert_eq!(fault("scout",&serde_json::json!({"fault":"operator"})),"operator");
    }

    #[test]
    fn buyer_recalls_finalized_vault_memory_after_sale() {
        let (mut r,job_id,input,_,_)=paid_setup();
        testing_env!(context("keeper.testnet",0).build());let _=r.start_paid_scout("nfa-1".into(),job_id,input);
        let hash=format!("sha256:{}","f".repeat(64));
        let output=serde_json::json!({"schemaVersion":1,"jobId":job_id,"status":"ok",
            "outputHash":hash,"outputUri":format!("nfa://work/{}","f".repeat(64))});
        testing_env!(context("nfa-1.registry.testnet",0).build());let _=r.on_outlayer_job("nfa-1".into(),job_id,Some(output));
        testing_env!(context("registry.testnet",0).build(),test_vm_config(),RuntimeFeesConfig::test(),
            Default::default(),vec![PromiseResult::Successful(vec![])]);
        let _=r.on_outlayer_replenished("nfa-1".into(),job_id);
        testing_env!(context("alice.testnet",1).build());r.nft_transfer(id("bob.testnet"),"nfa-1".into(),None,None);
        let recall_deposit=NearToken::from_millinear(100).as_yoctonear();
        testing_env!(context("bob.testnet",recall_deposit).build());
        let _=r.recall_owner_memory("nfa-1".into(),job_id,U128(recall_deposit));
        let recall_id=3;
        let result=serde_json::json!({"schemaVersion":1,"jobId":job_id,"status":"ok",
            "outputHash":hash,"outputUri":"nfa://work/abc","summary":"A vault follows its NFT."});
        testing_env!(context("nfa-1.registry.testnet",0).build());
        assert!(matches!(r.on_outlayer_recall("nfa-1".into(),recall_id,job_id,Some(result)),PromiseOrValue::Promise(_)));
        testing_env!(context("registry.testnet",0).build(),test_vm_config(),RuntimeFeesConfig::test(),
            Default::default(),vec![PromiseResult::Successful(vec![])]);
        let _=r.on_recall_replenished("nfa-1".into(),recall_id);
        testing_env!(context("bob.testnet",0).build());
        assert_eq!(r.owner_recall_result("nfa-1".into(),recall_id).unwrap()["summary"],"A vault follows its NFT.");
    }

    #[test]
    #[should_panic(expected="Owner only")]
    fn seller_cannot_trigger_buyer_memory_recall() {
        let mut r=minted();
        testing_env!(context("alice.testnet",1).build());
        r.nft_transfer(id("bob.testnet"),"nfa-1".into(),None,None);
        testing_env!(context("alice.testnet",NearToken::from_millinear(100).as_yoctonear()).build());
        let _=r.recall_owner_memory("nfa-1".into(),2,U128(NearToken::from_millinear(100).as_yoctonear()));
    }

    #[test]
    fn outlayer_project_remains_under_vault_after_sale_and_old_owner_loses_access() {
        let mut r = minted();
        let hash = "a".repeat(64);
        testing_env!(context("alice.testnet",1).build());
        let _ = r.provision_outlayer("nfa-1".into(),"https://test.fastfs.io/scout.wasm".into(),hash.clone(),U128(100));
        assert_eq!(r.agent("nfa-1".into()).unwrap().pending_op,Some(1));
        let record = serde_json::json!({"project_id":"nfa-1.registry.testnet/scout",
            "project_uuid":"p0001","version_key":hash});
        testing_env!(context("registry.testnet",0).build(),test_vm_config(),RuntimeFeesConfig::test(),
            Default::default(),vec![PromiseResult::Successful(record.to_string().into_bytes())]);
        assert!(r.on_outlayer_project("nfa-1".into(),1));
        testing_env!(context("alice.testnet",1).build());
        r.nft_transfer(id("bob.testnet"),"nfa-1".into(),None,None);
        let p = r.outlayer_project("nfa-1".into()).unwrap();
        assert_eq!(p.project_uuid,"p0001");
        assert_eq!(p.project_id,"nfa-1.registry.testnet/scout");
        testing_env!(context("bob.testnet",1).build());
        let _ = r.add_outlayer_version("nfa-1".into(),"https://test.fastfs.io/v2.wasm".into(),"b".repeat(64),U128(100));
        assert_eq!(r.agent("nfa-1".into()).unwrap().pending_op,Some(2));
    }

    #[test]
    #[should_panic(expected = "Owner only")]
    fn old_owner_cannot_manage_project_after_sale() {
        let mut r = minted();
        testing_env!(context("alice.testnet",1).build());
        r.nft_transfer(id("bob.testnet"),"nfa-1".into(),None,None);
        testing_env!(context("alice.testnet",1).build());
        let _ = r.provision_outlayer("nfa-1".into(),"https://test.fastfs.io/scout.wasm".into(),"a".repeat(64),U128(100));
    }

    #[test]
    fn approved_transfer_increments_epoch_and_clears_approvals() {
        let mut r = minted();
        testing_env!(context("alice.testnet", NearToken::from_near(1).as_yoctonear()).build());
        r.nft_approve("nfa-1".into(), id("bob.testnet"), None);
        assert!(r.nft_is_approved("nfa-1".into(), id("bob.testnet"), None));
        testing_env!(context("bob.testnet", 1).build());
        r.nft_transfer(id("carol.testnet"), "nfa-1".into(), None, None);
        assert_eq!(r.owner(&"nfa-1".into()), id("carol.testnet"));
        assert_eq!(r.agent("nfa-1".into()).unwrap().epoch, 1);
        assert!(!r.nft_is_approved("nfa-1".into(), id("bob.testnet"), None));
    }

    #[test]
    fn rejected_transfer_call_restores_approval_and_epoch() {
        let mut r = minted();
        testing_env!(context("alice.testnet", NearToken::from_near(1).as_yoctonear()).build());
        r.nft_approve("nfa-1".into(), id("delegate.testnet"), None);
        testing_env!(context("alice.testnet", 1).build());
        let _ = r.nft_transfer_call(id("receiver.testnet"), "nfa-1".into(), None, None, "reject".into());
        assert_eq!(r.agent("nfa-1".into()).unwrap().lifecycle, Lifecycle::TransferCallPending);
        testing_env!(context("registry.testnet", 0).build(), test_vm_config(), RuntimeFeesConfig::test(),
            Default::default(), vec![PromiseResult::Successful(b"true".to_vec())]);
        assert!(!r.nft_resolve_transfer(id("alice.testnet"), id("receiver.testnet"), "nfa-1".into(),
            Some(HashMap::from([(id("delegate.testnet"), 1)]))));
        assert_eq!(r.owner(&"nfa-1".into()), id("alice.testnet"));
        assert_eq!(r.agent("nfa-1".into()).unwrap().epoch, 0);
        assert!(r.nft_is_approved("nfa-1".into(), id("delegate.testnet"), None));
    }

    #[test]
    fn accepted_transfer_call_updates_epoch() {
        let mut r = minted();
        testing_env!(context("alice.testnet", 1).build());
        let _ = r.nft_transfer_call(id("receiver.testnet"), "nfa-1".into(), None, None, "accept".into());
        testing_env!(context("registry.testnet", 0).build(), test_vm_config(), RuntimeFeesConfig::test(),
            Default::default(), vec![PromiseResult::Successful(b"false".to_vec())]);
        assert!(r.nft_resolve_transfer(id("alice.testnet"), id("receiver.testnet"), "nfa-1".into(), Some(HashMap::new())));
        assert_eq!(r.agent("nfa-1".into()).unwrap().epoch, 1);
        assert_eq!(r.owner(&"nfa-1".into()), id("receiver.testnet"));
    }

    #[test]
    #[should_panic(expected = "Agent not transferable")]
    fn pending_receiver_cannot_transfer() {
        let mut r = minted();
        testing_env!(context("alice.testnet", 1).build());
        let _ = r.nft_transfer_call(id("receiver.testnet"), "nfa-1".into(), None, None, "x".into());
        testing_env!(context("receiver.testnet", 1).build());
        r.nft_transfer(id("attacker.testnet"), "nfa-1".into(), None, None);
    }

    #[test]
    #[should_panic(expected = "Agent not transferable")]
    fn listed_agent_cannot_transfer_directly() {
        let mut r = minted();
        testing_env!(context("alice.testnet", 1).build());
        r.list_agent("nfa-1".into(), U128(100));
        r.nft_transfer(id("bob.testnet"), "nfa-1".into(), None, None);
    }

    #[test]
    fn failed_provision_never_mints_and_remains_inspectable() {
        let mut r = registry();
        testing_env!(context("alice.testnet", MIN_PROVISION).build());
        let token = r.create_agent("request-1".into(),"sha256:abc".into(),"ipfs://a".into());
        testing_env!(context("registry.testnet", 0).build(), test_vm_config(), RuntimeFeesConfig::test(),
            Default::default(), vec![PromiseResult::Failed]);
        assert!(!r.on_provision(token.clone()));
        assert!(r.nft_token(token.clone()).is_none());
        assert!(r.pending_provision(token).unwrap().failed);
    }

    #[test]
    fn successful_callback_mints_without_attached_deposit() {
        let mut r = registry();
        testing_env!(context("alice.testnet", MIN_PROVISION).build());
        let token = r.create_agent("request-2".into(), "sha256:abc".into(), "ipfs://a".into());
        testing_env!(context("registry.testnet", 0).build(), test_vm_config(), RuntimeFeesConfig::test(),
            Default::default(), vec![PromiseResult::Successful(vec![])]);
        assert!(r.on_provision(token.clone()));
        assert_eq!(r.nft_token(token.clone()).unwrap().owner_id, id("alice.testnet"));
        assert!(r.pending_provision(token).is_none());
    }

    #[test]
    fn recovery_checks_existing_vault_then_mints_exactly_once() {
        let mut r = registry();
        testing_env!(context("alice.testnet", MIN_PROVISION).build());
        let token = r.create_agent("request-recover".into(), "sha256:abc".into(), "ipfs://a".into());
        let status = serde_json::json!({"controller":"registry.testnet","reporter":"reporter.testnet",
            "guardian":"guardian.testnet","pending":null,"next_operation_id":1});
        testing_env!(context("registry.testnet", 0).build(), test_vm_config(), RuntimeFeesConfig::test(),
            Default::default(), vec![PromiseResult::Successful(status.to_string().into_bytes())]);
        assert!(r.on_recover_provision(token.clone()));
        assert_eq!(r.nft_total_supply(), U128(1));
        assert!(r.pending_provision(token).is_none());
    }

    #[test]
    fn unknown_near_callback_keeps_transfer_locked() {
        let mut r = minted();
        testing_env!(context("alice.testnet", 1).build());
        r.request_near_transfer("nfa-1".into(), id("merchant.testnet"), U128(100));
        testing_env!(context("registry.testnet", 0).build(), test_vm_config(), RuntimeFeesConfig::test(),
            Default::default(), vec![PromiseResult::Failed]);
        assert!(!r.on_near_operation("nfa-1".into(), 1));
        assert_eq!(r.operation("nfa-1".into(), 1).unwrap().status, OpStatus::Uncertain);
        assert_eq!(r.agent("nfa-1".into()).unwrap().lifecycle, Lifecycle::Draining);
        assert_eq!(r.agent("nfa-1".into()).unwrap().pending_op, Some(1));
    }

    #[test]
    fn delegate_budget_is_reserved_and_restored_on_definite_failure() {
        let mut r = minted();
        testing_env!(context("alice.testnet", 1).build());
        r.grant_delegate("nfa-1".into(), id("worker.testnet"), "NEAR_TRANSFER".into(),
            Some(id("merchant.testnet")), U128(200), 1_000);
        testing_env!(context("worker.testnet", 1).build());
        assert_eq!(r.request_near_transfer("nfa-1".into(), id("merchant.testnet"), U128(100)), 1);
        assert_eq!(r.grant("nfa-1".into(), id("worker.testnet"), "NEAR_TRANSFER".into()).unwrap().remaining, U128(100));
        testing_env!(context("registry.testnet", 0).build(), test_vm_config(), RuntimeFeesConfig::test(),
            Default::default(), vec![PromiseResult::Successful(b"false".to_vec())]);
        assert!(!r.on_near_operation("nfa-1".into(), 1));
        assert_eq!(r.grant("nfa-1".into(), id("worker.testnet"), "NEAR_TRANSFER".into()).unwrap().remaining, U128(200));
    }

    #[test]
    #[should_panic(expected = "Grant scope, epoch, expiry or budget mismatch")]
    fn old_epoch_delegate_cannot_spend_after_transfer() {
        let mut r = minted();
        testing_env!(context("alice.testnet", 1).build());
        r.grant_delegate("nfa-1".into(), id("worker.testnet"), "NEAR_TRANSFER".into(),
            Some(id("merchant.testnet")), U128(200), 1_000);
        r.nft_transfer(id("bob.testnet"), "nfa-1".into(), None, None);
        testing_env!(context("worker.testnet", 1).build());
        r.request_near_transfer("nfa-1".into(), id("merchant.testnet"), U128(100));
    }

    #[test]
    #[should_panic(expected = "Grant scope, epoch, expiry or budget mismatch")]
    fn expired_delegate_cannot_spend() {
        let mut r = minted();
        testing_env!(context("alice.testnet", 1).build());
        r.grant_delegate("nfa-1".into(), id("worker.testnet"), "NEAR_TRANSFER".into(),
            Some(id("merchant.testnet")), U128(200), 1_000);
        let mut expired = context("worker.testnet", 1); expired.block_timestamp(1_000);
        testing_env!(expired.build());
        r.request_near_transfer("nfa-1".into(), id("merchant.testnet"), U128(100));
    }

    #[test]
    fn fixed_price_sale_is_atomic_and_credits_seller() {
        let mut r = minted();
        testing_env!(context("alice.testnet", 1).build());
        r.create_listing("nfa-1".into(), U128(NearToken::from_near(2).as_yoctonear()), 1_000);
        assert_eq!(r.listing("nfa-1".into()).unwrap().nonce, 1);
        testing_env!(context("bob.testnet", NearToken::from_near(2).as_yoctonear()).build());
        r.buy("nfa-1".into(), 1);
        assert_eq!(r.owner(&"nfa-1".into()), id("bob.testnet"));
        assert_eq!(r.agent("nfa-1".into()).unwrap().epoch, 1);
        assert!(r.listing("nfa-1".into()).is_none());
        assert_eq!(r.payout(id("alice.testnet")).available, U128(NearToken::from_near(2).as_yoctonear()));
    }

    #[test]
    #[should_panic(expected = "No listing")]
    fn a_second_buyer_cannot_buy_sold_token() {
        let mut r = minted();
        testing_env!(context("alice.testnet", 1).build());
        r.list_agent("nfa-1".into(), U128(100));
        testing_env!(context("bob.testnet", 100).build());
        r.buy("nfa-1".into(), 1);
        testing_env!(context("carol.testnet", 100).build());
        r.buy("nfa-1".into(), 1);
    }

    #[test]
    #[should_panic(expected = "Expired or stale listing")]
    fn cancelled_offer_nonce_cannot_be_replayed() {
        let mut r = minted();
        testing_env!(context("alice.testnet", 1).build());
        r.list_agent("nfa-1".into(), U128(100));
        r.unlist_agent("nfa-1".into());
        r.list_agent("nfa-1".into(), U128(100));
        testing_env!(context("bob.testnet", 100).build());
        r.buy("nfa-1".into(), 1);
    }

    #[test]
    fn failed_seller_payout_restores_credit_without_reverting_sale() {
        let mut r = minted();
        testing_env!(context("alice.testnet", 1).build());
        r.list_agent("nfa-1".into(), U128(100));
        testing_env!(context("bob.testnet", 100).build());
        r.buy("nfa-1".into(), 1);
        testing_env!(context("alice.testnet", 1).build());
        let _ = r.withdraw_proceeds(U128(100));
        assert_eq!(r.payout(id("alice.testnet")).available, U128(0));
        testing_env!(context("registry.testnet", 0).build(), test_vm_config(), RuntimeFeesConfig::test(),
            Default::default(), vec![PromiseResult::Failed]);
        assert!(!r.on_payout(id("alice.testnet"), 1));
        assert_eq!(r.payout(id("alice.testnet")).available, U128(100));
        assert!(r.payout(id("alice.testnet")).pending.is_none());
        assert_eq!(r.owner(&"nfa-1".into()), id("bob.testnet"));
    }

    #[test]
    fn expired_listing_remains_inactive_until_owner_resumes() {
        let mut r = minted();
        testing_env!(context("alice.testnet", 1).build());
        r.create_listing("nfa-1".into(), U128(100), 1_000);
        let mut later = context("keeper.testnet", 0); later.block_timestamp(1_000);
        testing_env!(later.build());
        r.cancel_expired("nfa-1".into());
        assert_eq!(r.agent("nfa-1".into()).unwrap().lifecycle, Lifecycle::Draining);
        assert!(r.listing("nfa-1".into()).is_none());
    }

    #[test]
    fn evm_signature_and_broadcast_keep_sale_locked_until_matching_receipt() {
        let mut r = minted();
        pin_test_wallet();
        testing_env!(context("alice.testnet", 1).build());
        assert_eq!(r.request_evm_transfer("nfa-1".into(),
            "0x1111111111111111111111111111111111111111".into(), U128(100), 1, 2), 1);
        assert_eq!(r.agent("nfa-1".into()).unwrap().pending_op, Some(1));
        testing_env!(context("registry.testnet", 0).build(), test_vm_config(), RuntimeFeesConfig::test(),
            Default::default(), vec![PromiseResult::Successful(b"true".to_vec())]);
        assert!(r.on_evm_request("nfa-1".into(), 1));
        let hash = format!("0x{}", "a".repeat(64));
        testing_env!(context("reporter.testnet", 0).build());
        r.mark_evm_broadcast("nfa-1".into(), 1, hash.clone(), None);
        assert_eq!(r.operation("nfa-1".into(), 1).unwrap().status, OpStatus::Submitted);
        let _ = r.reconcile_evm("nfa-1".into(), 1);
        let mismatch = serde_json::json!({"controller":"registry.testnet","chain_id":11155111,"path":"eth-sepolia-v1",
            "pending":null,"last_receipt":[0,format!("0x{}","b".repeat(64)),123,true],"next_evm_nonce":1});
        testing_env!(context("registry.testnet", 0).build(), test_vm_config(), RuntimeFeesConfig::test(),
            Default::default(), vec![PromiseResult::Successful(mismatch.to_string().into_bytes())]);
        assert!(!r.on_reconcile_evm("nfa-1".into(), 1));
        assert_eq!(r.agent("nfa-1".into()).unwrap().pending_op, Some(1));
        let correct = serde_json::json!({"controller":"registry.testnet","chain_id":11155111,"path":"eth-sepolia-v1",
            "pending":null,"last_receipt":[0,hash,123,true],"next_evm_nonce":1});
        testing_env!(context("registry.testnet", 0).build(), test_vm_config(), RuntimeFeesConfig::test(),
            Default::default(), vec![PromiseResult::Successful(correct.to_string().into_bytes())]);
        assert!(r.on_reconcile_evm("nfa-1".into(), 1));
        assert_eq!(r.operation("nfa-1".into(), 1).unwrap().status, OpStatus::Finalized);
        assert!(r.agent("nfa-1".into()).unwrap().pending_op.is_none());
        testing_env!(context("alice.testnet", 1).build());
        assert_eq!(r.request_evm_transfer("nfa-1".into(),
            "0x2222222222222222222222222222222222222222".into(), U128(200), 1, 2), 2);
        assert_eq!(r.evm_operation("nfa-1".into(), 2).unwrap().nonce, 1);
    }

    #[test]
    #[should_panic(expected = "Agent not transferable")]
    fn issued_evm_signature_blocks_sale_even_before_broadcast() {
        let mut r = minted();
        pin_test_wallet();
        testing_env!(context("alice.testnet", 1).build());
        r.request_evm_transfer("nfa-1".into(),
            "0x1111111111111111111111111111111111111111".into(), U128(100), 1, 2);
        r.list_agent("nfa-1".into(), U128(100));
    }

    #[test]
    fn failed_signer_callback_locks_transfer_indefinitely() {
        let mut r = minted();
        pin_test_wallet();
        testing_env!(context("alice.testnet", 1).build());
        r.request_evm_transfer("nfa-1".into(),
            "0x1111111111111111111111111111111111111111".into(), U128(100), 1, 2);
        testing_env!(context("registry.testnet", 0).build(), test_vm_config(), RuntimeFeesConfig::test(),
            Default::default(), vec![PromiseResult::Failed]);
        assert!(!r.on_evm_request("nfa-1".into(), 1));
        assert_eq!(r.agent("nfa-1".into()).unwrap().lifecycle, Lifecycle::Draining);
        assert_eq!(r.agent("nfa-1".into()).unwrap().pending_op, Some(1));
    }

    #[test]
    fn paid_scout_work_and_unclaimed_income_follow_nft() {
        let mut r = minted();
        let hash = format!("sha256:{}", "a".repeat(64));
        testing_env!(context("alice.testnet", 1).build());
        r.grant_delegate("nfa-1".into(), id("worker.testnet"), "SCOUT_RUN".into(),
            None, U128(1), 1_000);
        let fee = NearToken::from_millinear(10).as_yoctonear();
        testing_env!(context("customer.testnet", fee).build());
        assert_eq!(r.request_scout_job("nfa-1".into(), hash.clone(), hash.clone(), 500, U128(fee)), 1);
        assert_eq!(r.agent_income("nfa-1".into()), U128(0));
        testing_env!(context("worker.testnet", 0).build());
        r.complete_scout_job("nfa-1".into(), 1, 0, hash, "nfa://work/1".into());
        assert_eq!(r.scout_job("nfa-1".into(), 1).unwrap().status, "FINALIZED");
        let net = fee - job_storage_fee();
        assert_eq!(r.agent_income("nfa-1".into()), U128(net));
        testing_env!(context("alice.testnet", 1).build());
        r.nft_transfer(id("bob.testnet"), "nfa-1".into(), None, None);
        testing_env!(context("bob.testnet", 1).build());
        r.claim_income("nfa-1".into(), U128(net));
        assert_eq!(r.agent_income("nfa-1".into()), U128(0));
        assert_eq!(r.payout(id("bob.testnet")).available, U128(net));
        assert_eq!(r.payout(id("alice.testnet")).available, U128(0));
    }

    #[test]
    fn expired_job_refunds_customer_and_stale_worker_cannot_finish() {
        let mut r = minted();
        let hash = format!("sha256:{}", "b".repeat(64));
        testing_env!(context("alice.testnet", 1).build());
        r.grant_delegate("nfa-1".into(), id("worker.testnet"), "SCOUT_RUN".into(),
            None, U128(1), 2_000);
        let fee = NearToken::from_millinear(10).as_yoctonear();
        testing_env!(context("customer.testnet", fee).build());
        r.request_scout_job("nfa-1".into(), hash.clone(), hash.clone(), 500, U128(fee));
        let mut later = context("keeper.testnet", 0); later.block_timestamp(500);
        testing_env!(later.build());
        r.abort_scout_job("nfa-1".into(), 1);
        assert_eq!(r.payout(id("customer.testnet")).available, U128(fee - job_storage_fee()));
        assert_eq!(r.agent_income("nfa-1".into()), U128(0));
        // An expired legacy job no longer forces an owner resume.
        assert_eq!(r.agent("nfa-1".into()).unwrap().lifecycle, Lifecycle::Active);
        assert_eq!(r.scout_job("nfa-1".into(), 1).unwrap().status, "FAILED");
    }

    #[test]
    fn signer_derived_address_is_pinned_across_nft_transfer() {
        let mut r = minted();
        let key = "secp256k1:5LWwfiR7HmJZEsX6WWDfHskNccTRuJW6HRkANT38MRUbj3WXC7fa3bT2Y2j5TtypuLuXre5WBUa58XBdHqk5EDQm";
        testing_env!(context("registry.testnet", 0).build(), test_vm_config(), RuntimeFeesConfig::test(),
            Default::default(), vec![PromiseResult::Successful(serde_json::to_vec(key).unwrap())]);
        assert!(r.on_derived_wallet("nfa-1".into()));
        let address = r.derived_wallet("nfa-1".into()).unwrap().address;
        assert_eq!(address, "0x9E65Be999C4C68d0a58C28C3Bdd8944E3818EA6d");
        assert_eq!(r.chain_key("nfa-1".into(),"eth-sepolia".into()).unwrap().address,address);
        assert!(r.chain_key("nfa-1".into(),"ethereum-mainnet".into()).is_none());
        assert!(r.chain_key("nfa-2".into(),"eth-sepolia".into()).is_none());
        testing_env!(context("alice.testnet", 1).build());
        r.nft_transfer(id("bob.testnet"), "nfa-1".into(), None, None);
        assert_eq!(r.derived_wallet("nfa-1".into()).unwrap().address, address);
        assert_eq!(r.chain_key("nfa-1".into(),"eth-sepolia".into()).unwrap().address,address);
    }

    #[test]
    fn studio_policy_and_grants_follow_current_owner_epoch(){
        let mut r=minted();
        testing_env!(context("alice.testnet",1).build());
        r.configure_transaction_policy("nfa-1".into(),true,false,vec![id("recipient.testnet")],vec![],
            U128(100),U128(0),100);
        r.grant_delegate("nfa-1".into(),id("worker.testnet"),"NEAR_TRANSFER".into(),
            Some(id("recipient.testnet")),U128(100),1000);
        assert_eq!(r.studio_grants("nfa-1".into()).len(),1);
        let rejected=std::panic::catch_unwind(std::panic::AssertUnwindSafe(||
            r.request_near_transfer("nfa-1".into(),id("other.testnet"),U128(1))));
        assert!(rejected.is_err());
        assert!(r.studio_page("nfa-1".into(),1,50)["rows"].as_array().unwrap().is_empty());
        assert!(r.studio_audit("nfa-1".into(),1,50)["count"].as_u64().unwrap()>=2);
        r.nft_transfer(id("bob.testnet"),"nfa-1".into(),None,None);
        assert!(r.transaction_policy("nfa-1".into()).is_none());
        assert!(r.studio_grants("nfa-1".into()).is_empty());
    }
    #[test]
    fn definite_service_failure_resumes_only_after_vault_is_proven_clear(){
        let (mut r,job_id,input,_,_)=paid_setup();
        testing_env!(context("keeper.testnet",0).build());let _=r.start_paid_scout("nfa-1".into(),job_id,input);
        testing_env!(context("nfa-1.registry.testnet",0).build());
        let _=r.on_outlayer_job("nfa-1".into(),job_id,Some(serde_json::json!({"schemaVersion":1,"jobId":job_id,"status":"failed","fault":"operator"})));
        testing_env!(context("alice.testnet",1).build());let _=r.resume_failed_service("nfa-1".into(),job_id);
        let id=r.agent("nfa-1".into()).unwrap().pending_op.unwrap();
        testing_env!(context("registry.testnet",0).build(),test_vm_config(),RuntimeFeesConfig::test(),Default::default(),
            vec![PromiseResult::Successful(serde_json::to_vec(&serde_json::json!({"controller":"registry.testnet","pending":{"Evm":{}},"next_operation_id":job_id+1})).unwrap())]);
        assert!(!r.on_service_resume("nfa-1".into(),id));
        assert_eq!(r.agent("nfa-1".into()).unwrap().lifecycle,Lifecycle::Draining);
        testing_env!(context("registry.testnet",0).build(),test_vm_config(),RuntimeFeesConfig::test(),Default::default(),
            vec![PromiseResult::Successful(serde_json::to_vec(&serde_json::json!({"controller":"registry.testnet","pending":null,"next_operation_id":job_id+1})).unwrap())]);
        assert!(r.on_service_resume("nfa-1".into(),id));
        assert_eq!(r.agent("nfa-1".into()).unwrap().lifecycle,Lifecycle::Active);
    }
    #[test]
    fn reviewed_quote_rejects_runtime_drift_without_reserving_a_job(){
        let (mut r,id,_,fee,deposit)=paid_setup();
        testing_env!(context("keeper.testnet",0).block_timestamp(600).build());r.expire_unstarted_paid_scout("nfa-1".into(),id);
        let version=r.outlayer_project("nfa-1".into()).unwrap().version_key;
        let next=r.agent("nfa-1".into()).unwrap().next_op_id;
        testing_env!(context("customer.testnet",fee).block_timestamp(600).build());
        let limits=outlayer::SkillLimits{max_instructions:1_000_000,max_memory_mb:64,max_execution_seconds:10};
        let rejected=std::panic::catch_unwind(std::panic::AssertUnwindSafe(||r.request_reviewed_service_job(
            "nfa-1".into(),"scout".into(),format!("sha256:{}","b".repeat(64)),1000,U128(fee),U128(deposit),U128(deposit),limits.clone(),"f".repeat(64),1,None)));
        assert!(rejected.is_err());assert_eq!(r.agent("nfa-1".into()).unwrap().next_op_id,next);
        let allocated=r.request_reviewed_service_job("nfa-1".into(),"scout".into(),format!("sha256:{}","b".repeat(64)),
            1000,U128(fee),U128(deposit),U128(deposit),limits,version,1,None);
        assert_eq!(allocated,next);
    }

    // ---- B1: customers cannot choose job resources; uncertain jobs are releasable ----
    fn scout_ready()->(Registry,String,u128,u128){
        let (mut r,first,input,fee,deposit)=paid_setup();
        testing_env!(context("keeper.testnet",0).block_timestamp(600).build());r.expire_unstarted_paid_scout("nfa-1".into(),first);
        (r,input,fee,deposit)
    }
    fn limits(i:u64)->outlayer::SkillLimits{outlayer::SkillLimits{max_instructions:i,max_memory_mb:64,max_execution_seconds:10}}
    #[test]
    fn customer_cannot_choose_tiny_limits_or_deposit(){
        let (mut r,input,fee,deposit)=scout_ready();
        let h=format!("sha256:{}",hex(&env::sha256(input.as_bytes())));
        testing_env!(context("customer.testnet",fee).block_timestamp(600).build());
        let next=r.agent("nfa-1".into()).unwrap().next_op_id;
        for (lim,cap,msg) in [(1,deposit,"limits"),(1_000_000,1,"deposit")]{
            let fee_paid=std::panic::catch_unwind(std::panic::AssertUnwindSafe(||r.request_paid_scout("nfa-1".into(),h.clone(),
                700,U128(fee),U128(cap),U128(cap),limits(lim))));
            assert!(fee_paid.is_err(),"{msg} must be rejected");
        }
        assert_eq!(r.agent("nfa-1".into()).unwrap().next_op_id,next);
        assert!(r.agent("nfa-1".into()).unwrap().pending_op.is_none());
    }
    #[test]
    #[should_panic(expected="Service not configured")]
    fn paid_job_requires_an_owner_policy(){
        let mut r=minted();
        testing_env!(context("alice.testnet",1).build());
        let _=r.provision_outlayer("nfa-1".into(),"https://test.fastfs.io/scout.wasm".into(),"a".repeat(64),U128(100));
        testing_env!(context("registry.testnet",0).build(),test_vm_config(),RuntimeFeesConfig::test(),Default::default(),
            vec![PromiseResult::Successful(serde_json::json!({"project_id":"nfa-1.registry.testnet/scout","project_uuid":"p0001"}).to_string().into_bytes())]);
        r.on_outlayer_project("nfa-1".into(),1);
        let fee=NearToken::from_millinear(150).as_yoctonear();let deposit=NearToken::from_millinear(100).as_yoctonear();
        testing_env!(context("customer.testnet",fee).build());
        r.request_paid_scout("nfa-1".into(),format!("sha256:{}","a".repeat(64)),500,U128(fee),U128(deposit),U128(deposit),limits(1_000_000));
    }
    fn uncertain_job()->(Registry,u64,u128){
        let (mut r,input,fee,deposit)=scout_ready();
        let h=format!("sha256:{}",hex(&env::sha256(input.as_bytes())));
        testing_env!(context("customer.testnet",fee).block_timestamp(600).build());
        let id=r.request_paid_scout("nfa-1".into(),h,1_000_000_000_000,U128(fee),U128(deposit),U128(deposit),limits(1_000_000));
        testing_env!(context("customer.testnet",0).block_timestamp(700).build());
        let _=r.start_paid_scout("nfa-1".into(),id,input);
        // OutLayer rejected or trapped: the vault reports no parseable result.
        testing_env!(context("nfa-1.registry.testnet",0).block_timestamp(800).build());
        let _=r.on_outlayer_job("nfa-1".into(),id,None);
        assert_eq!(r.paid_scout_job("nfa-1".into(),id).unwrap().status,"UNCERTAIN");
        (r,id,fee)
    }
    #[test]
    fn uncertain_job_is_released_only_after_vault_confirms_no_execution_in_flight(){
        let (mut r,id,fee)=uncertain_job();
        let escrow=r.paid_scout_ledger().customer_escrow.0;let refunds=r.payout(id_("customer.testnet")).available.0;
        testing_env!(context("stranger.testnet",0).block_timestamp(900).build());
        let _=r.release_service_job("nfa-1".into(),id);
        // Vault still has the OutLayer callback outstanding.
        testing_env!(context("registry.testnet",0).block_timestamp(900).build(),test_vm_config(),RuntimeFeesConfig::test(),
            Default::default(),vec![PromiseResult::Successful(b"false".to_vec())]);
        assert!(matches!(r.on_service_job_released("nfa-1".into(),id),PromiseOrValue::Value(false)));
        assert_eq!(r.agent("nfa-1".into()).unwrap().pending_op,Some(id));
        testing_env!(context("registry.testnet",0).block_timestamp(900).build(),test_vm_config(),RuntimeFeesConfig::test(),
            Default::default(),vec![PromiseResult::Successful(b"true".to_vec())]);
        assert!(matches!(r.on_service_job_released("nfa-1".into(),id),PromiseOrValue::Promise(_)));
        assert_eq!(r.agent("nfa-1".into()).unwrap().pending_op,Some(id),"retain slot through reimbursement");
        testing_env!(context("registry.testnet",0).block_timestamp(900).build(),test_vm_config(),RuntimeFeesConfig::test(),
            Default::default(),vec![PromiseResult::Successful(vec![])]);
        assert!(matches!(r.on_outlayer_replenished("nfa-1".into(),id),PromiseOrValue::Value(true)));
        assert!(r.agent("nfa-1".into()).unwrap().pending_op.is_none());
        assert_eq!(r.agent("nfa-1".into()).unwrap().lifecycle,Lifecycle::Active);
        assert_eq!(r.paid_scout_job("nfa-1".into(),id).unwrap().status,"FAILED");
        assert_eq!(r.paid_scout_ledger().customer_escrow.0,escrow-fee);
        assert_eq!(r.payout(id_("customer.testnet")).available.0,refunds+fee-r.paid_scout_job("nfa-1".into(),id).unwrap().replenish.0-job_storage_fee());
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(||r.owner_memory_receipt("nfa-1".into(),id))).is_err());
        // Released jobs never become memory and the NFA can be sold again.
        testing_env!(context("alice.testnet",1).block_timestamp(900).build());
        r.nft_transfer(id_("bob.testnet"),"nfa-1".into(),None,None);
    }
    fn id_(s:&str)->AccountId{s.parse().unwrap()}
    #[test]
    #[should_panic(expected="Job is not releasable")]
    fn executing_job_cannot_be_released_before_the_result_window(){
        let (mut r,input,fee,deposit)=scout_ready();
        let h=format!("sha256:{}",hex(&env::sha256(input.as_bytes())));
        testing_env!(context("customer.testnet",fee).block_timestamp(600).build());
        let id=r.request_paid_scout("nfa-1".into(),h,1_000_000_000_000,U128(fee),U128(deposit),U128(deposit),limits(1_000_000));
        testing_env!(context("customer.testnet",0).block_timestamp(700).build());
        let _=r.start_paid_scout("nfa-1".into(),id,input);
        testing_env!(context("customer.testnet",0).block_timestamp(700+899_000_000_000).build());
        let _=r.release_service_job("nfa-1".into(),id);
    }
    #[test]
    fn executing_job_is_releasable_after_the_result_window(){
        let (mut r,input,fee,deposit)=scout_ready();
        let h=format!("sha256:{}",hex(&env::sha256(input.as_bytes())));
        testing_env!(context("customer.testnet",fee).block_timestamp(600).build());
        let id=r.request_paid_scout("nfa-1".into(),h,1_000_000_000_000,U128(fee),U128(deposit),U128(deposit),limits(1_000_000));
        testing_env!(context("customer.testnet",0).block_timestamp(700).build());
        let _=r.start_paid_scout("nfa-1".into(),id,input);
        testing_env!(context("registry.testnet",0).block_timestamp(700+900_000_000_000).build(),test_vm_config(),RuntimeFeesConfig::test(),
            Default::default(),vec![PromiseResult::Successful(b"true".to_vec())]);
        assert!(matches!(r.on_service_job_released("nfa-1".into(),id),PromiseOrValue::Promise(_)));
        assert_eq!(r.agent("nfa-1".into()).unwrap().pending_op,Some(id),"retain slot through reimbursement");
        testing_env!(context("registry.testnet",0).block_timestamp(900).build(),test_vm_config(),RuntimeFeesConfig::test(),
            Default::default(),vec![PromiseResult::Successful(vec![])]);
        assert!(matches!(r.on_outlayer_replenished("nfa-1".into(),id),PromiseOrValue::Value(true)));
        // A result arriving afterwards is rejected and cannot finalize memory.
        testing_env!(context("nfa-1.registry.testnet",0).block_timestamp(800+900_000_000_000).build());
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(||r.on_outlayer_job("nfa-1".into(),id,
            Some(serde_json::json!({"schemaVersion":1,"jobId":id,"status":"ok"}))))).is_err());
    }

    #[test]
    fn repeated_unresolved_jobs_pay_storage_and_compute_without_agent_income(){
        let (mut r,input,_,_)=scout_ready();let token="nfa-1".to_string();
        let deposit=NearToken::from_millinear(1).as_yoctonear();let fee=deposit+MIN_MARGIN_FOR_TESTS;
        // The fixture expired an earlier job. Start this attack with no earnings/credits,
        // as if those balances had already been withdrawn.
        release_liability(incomes().remove(&token).unwrap_or(0));
        release_liability(payouts().remove(&id_("customer.testnet")).unwrap_or_default().available.0);
        let storage_fees_before=ledger_totals().get(&"storage_fees".into()).unwrap_or(0);
        for cycle in 0..3 {
            testing_env!(context("customer.testnet",fee).block_timestamp(600).build());
            let id=r.request_paid_scout(token.clone(),format!("sha256:{}",hex(&env::sha256(input.as_bytes()))),1000,
                U128(fee),U128(deposit),U128(deposit),limits(1_000_000));
            let _=r.start_paid_scout(token.clone(),id,input.clone());
            testing_env!(context("nfa-1.registry.testnet",0).block_timestamp(700).build());
            let _=r.on_outlayer_job(token.clone(),id,None);
            testing_env!(context("registry.testnet",0).block_timestamp(800).build(),test_vm_config(),RuntimeFeesConfig::test(),
                Default::default(),vec![PromiseResult::Successful(b"true".to_vec())]);
            let _=r.on_service_job_released(token.clone(),id);
            // A failed transfer gives no credit and cannot trigger a second release.
            testing_env!(context("registry.testnet",0).block_timestamp(800).build(),test_vm_config(),RuntimeFeesConfig::test(),
                Default::default(),vec![PromiseResult::Failed]);
            let _=r.on_outlayer_replenished(token.clone(),id);
            assert!(matches!(r.on_service_job_released(token.clone(),id),PromiseOrValue::Value(false)));
            let _=r.retry_outlayer_replenishment(token.clone(),id);
            testing_env!(context("registry.testnet",0).block_timestamp(800).build(),test_vm_config(),RuntimeFeesConfig::test(),
                Default::default(),vec![PromiseResult::Successful(vec![])]);
            assert!(matches!(r.on_outlayer_replenished(token.clone(),id),PromiseOrValue::Value(true)));
            assert_eq!(r.payout(id_("customer.testnet")).available.0,(cycle+1)*(fee-deposit-job_storage_fee()));
            assert_eq!(r.agent_income(token.clone()).0,0,"agent earnings do not subsidize releases");
            assert_eq!(r.paid_scout_job(token.clone(),id).unwrap().status,"FAILED");
            assert_eq!(liability(),r.payout(id_("customer.testnet")).available.0);
        }
        assert_eq!(ledger_totals().get(&"storage_fees".into()).unwrap_or(0)-storage_fees_before,3*job_storage_fee());
    }

    // ---- B2: definite vault rejection and reconciliation of NEAR transfers ----
    fn near_requested()->(Registry,u64){
        let mut r=minted();
        testing_env!(context("alice.testnet",1).build());
        let id=r.request_near_transfer("nfa-1".into(),id_("bob.testnet"),U128(NearToken::from_near(100).as_yoctonear()));
        (r,id)
    }
    #[test]
    fn vault_rejection_is_a_definite_failure(){
        let (mut r,id)=near_requested();
        testing_env!(context("registry.testnet",0).build(),test_vm_config(),RuntimeFeesConfig::test(),
            Default::default(),vec![PromiseResult::Successful(b"false".to_vec())]);
        assert!(!r.on_near_operation("nfa-1".into(),id));
        assert!(r.agent("nfa-1".into()).unwrap().pending_op.is_none());
        assert_eq!(r.operation("nfa-1".into(),id).unwrap().status,OpStatus::Failed);
    }
    fn uncertain_near()->(Registry,u64){
        let (mut r,id)=near_requested();
        testing_env!(context("registry.testnet",0).build(),test_vm_config(),RuntimeFeesConfig::test(),
            Default::default(),vec![PromiseResult::Failed]);
        r.on_near_operation("nfa-1".into(),id);
        assert_eq!(r.operation("nfa-1".into(),id).unwrap().status,OpStatus::Uncertain);
        (r,id)
    }
    fn vault_says(r:&mut Registry,f:&str,id:u64,status:serde_json::Value)->bool{
        testing_env!(context("registry.testnet",0).build(),test_vm_config(),RuntimeFeesConfig::test(),
            Default::default(),vec![PromiseResult::Successful(status.to_string().into_bytes())]);
        match f{"near"=>r.on_reconcile_near("nfa-1".into(),id),_=>r.on_recover_evm("nfa-1".into(),id)}
    }
    #[test]
    fn old_vault_panic_is_reconciled_when_vault_never_began(){
        let (mut r,id)=uncertain_near();
        assert!(!vault_says(&mut r,"near",id,serde_json::json!({"controller":"registry.testnet","pending":{"Near":{}},"next_operation_id":id+1})));
        assert!(!vault_says(&mut r,"near",id,serde_json::json!({"controller":"other.testnet","pending":null,"next_operation_id":id})));
        assert!(!vault_says(&mut r,"near",id,serde_json::json!({"controller":"registry.testnet","pending":null,"next_operation_id":id+1})),
            "Began without a recorded outcome stays uncertain");
        assert!(vault_says(&mut r,"near",id,serde_json::json!({"controller":"registry.testnet","pending":null,"next_operation_id":id})));
        let a=r.agent("nfa-1".into()).unwrap();
        assert!(a.pending_op.is_none());assert_eq!(a.lifecycle,Lifecycle::Active);
        assert_eq!(r.operation("nfa-1".into(),id).unwrap().status,OpStatus::Failed);
    }
    #[test]
    fn recorded_vault_outcome_resolves_uncertain_transfer(){
        let (mut r,id)=uncertain_near();
        assert!(vault_says(&mut r,"near",id,serde_json::json!({"controller":"registry.testnet","pending":null,
            "next_operation_id":id+1,"last_near":[id,true]})));
        assert_eq!(r.operation("nfa-1".into(),id).unwrap().status,OpStatus::Finalized);
    }
    #[test]
    fn delegate_over_balance_request_cannot_brick_and_budget_is_restored(){
        let mut r=minted();
        testing_env!(context("alice.testnet",1).block_timestamp(1).build());
        r.grant_delegate("nfa-1".into(),id_("worker.testnet"),"NEAR_TRANSFER".into(),Some(id_("bob.testnet")),U128(1000),1_000_000);
        testing_env!(context("worker.testnet",1).block_timestamp(2).build());
        let id=r.request_near_transfer("nfa-1".into(),id_("bob.testnet"),U128(1000));
        testing_env!(context("registry.testnet",0).build(),test_vm_config(),RuntimeFeesConfig::test(),
            Default::default(),vec![PromiseResult::Failed]);
        r.on_near_operation("nfa-1".into(),id);
        assert!(vault_says(&mut r,"near",id,serde_json::json!({"controller":"registry.testnet","pending":null,"next_operation_id":id})));
        assert_eq!(r.grant("nfa-1".into(),id_("worker.testnet"),"NEAR_TRANSFER".into()).unwrap().remaining,U128(1000));
    }

    // ---- B3: EVM signer retry, rejection and same-nonce replacement ----
    fn evm_requested()->(Registry,u64){
        let mut r=minted();pin_test_wallet();
        testing_env!(context("alice.testnet",1).build());
        let id=r.request_evm_transfer("nfa-1".into(),"0x2222222222222222222222222222222222222222".into(),U128(10),1_000_000_000,2_000_000_000);
        (r,id)
    }
    fn evm_cb(r:&mut Registry,result:PromiseResult,f:&str,id:u64)->bool{
        testing_env!(context("registry.testnet",0).build(),test_vm_config(),RuntimeFeesConfig::test(),Default::default(),vec![result]);
        match f{"request"=>r.on_evm_request("nfa-1".into(),id),"resign"=>r.on_evm_resigned("nfa-1".into(),id),
            "replace"=>r.on_evm_replaced("nfa-1".into(),id,1_100_000_000,2_200_000_000,false),
            _=>r.on_evm_replaced("nfa-1".into(),id,1_100_000_000,2_200_000_000,true)}
    }
    #[test]
    fn rejected_evm_request_fails_without_locking(){
        let (mut r,id)=evm_requested();
        assert!(!evm_cb(&mut r,PromiseResult::Successful(b"\"rejected\"".to_vec()),"request",id));
        assert!(r.agent("nfa-1".into()).unwrap().pending_op.is_none());
        assert_eq!(r.operation("nfa-1".into(),id).unwrap().status,OpStatus::Failed);
    }
    #[test]
    fn uncertain_signer_is_retried_for_same_operation(){
        let (mut r,id)=evm_requested();
        assert!(!evm_cb(&mut r,PromiseResult::Failed,"request",id));
        testing_env!(context("stranger.testnet",0).build());
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(||r.retry_evm_signature("nfa-1".into(),id))).is_err());
        testing_env!(context("reporter.testnet",0).build());let _=r.retry_evm_signature("nfa-1".into(),id);
        assert!(!evm_cb(&mut r,PromiseResult::Successful(b"\"rejected\"".to_vec()),"resign",id));
        assert_eq!(r.operation("nfa-1".into(),id).unwrap().status,OpStatus::Uncertain);
        assert!(evm_cb(&mut r,PromiseResult::Successful(b"true".to_vec()),"resign",id));
        assert_eq!(r.operation("nfa-1".into(),id).unwrap().status,OpStatus::Submitted);
        assert_eq!(r.agent("nfa-1".into()).unwrap().pending_op,Some(id),"Sale stays locked until a receipt");
    }
    #[test]
    fn never_begun_evm_request_is_recovered_from_vault_status(){
        let (mut r,id)=evm_requested();
        evm_cb(&mut r,PromiseResult::Failed,"request",id);
        assert!(!vault_says(&mut r,"evm",id,serde_json::json!({"controller":"registry.testnet","pending":{"Evm":{}},"next_operation_id":id+1})));
        assert!(vault_says(&mut r,"evm",id,serde_json::json!({"controller":"registry.testnet","pending":null,"next_operation_id":id})));
        assert!(r.agent("nfa-1".into()).unwrap().pending_op.is_none());
    }
    fn signed_evm()->(Registry,u64){
        let (mut r,id)=evm_requested();
        assert!(evm_cb(&mut r,PromiseResult::Successful(b"true".to_vec()),"request",id));(r,id)
    }
    #[test]
    fn replacement_requires_owner_and_fee_bump(){
        let (mut r,id)=signed_evm();
        for (caller,p,m) in [("bob.testnet",1_100_000_000,2_200_000_000),("alice.testnet",1_050_000_000,2_200_000_000),("alice.testnet",1_100_000_000,2_100_000_000)]{
            testing_env!(context(caller,1).build());
            assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(||r.replace_evm_transfer("nfa-1".into(),id,p,m,false))).is_err());
        }
        testing_env!(context("alice.testnet",1).build());let _=r.replace_evm_transfer("nfa-1".into(),id,1_100_000_000,2_200_000_000,true);
        let receipts=near_sdk::test_utils::get_created_receipts();
        let args=receipts.iter().flat_map(|r|r.actions.iter()).find_map(|a|match a{
            near_sdk::mock::MockAction::FunctionCallWeight{method_name,args,..} if method_name==b"replace_evm"=>Some(serde_json::from_slice::<serde_json::Value>(args).unwrap()),_=>None}).unwrap();
        assert_eq!(args["recipient_hex"],"0x1111111111111111111111111111111111111111");assert_eq!(args["value_wei"],"0");
    }
    fn reconcile_with(r:&mut Registry,id:u64,hash:&str)->bool{
        testing_env!(context("registry.testnet",0).build(),test_vm_config(),RuntimeFeesConfig::test(),Default::default(),
            vec![PromiseResult::Successful(serde_json::json!({"controller":"registry.testnet","chain_id":11155111,"path":"eth-sepolia-v1",
                "pending":null,"next_evm_nonce":1,"last_receipt":[0,hash,77,true]}).to_string().into_bytes())]);
        r.on_reconcile_evm("nfa-1".into(),id)
    }
    #[test]
    fn original_candidate_landing_after_replacement_is_accepted(){
        let (mut r,id)=signed_evm();
        let a=format!("0x{}","a".repeat(64));let b=format!("0x{}","b".repeat(64));
        testing_env!(context("reporter.testnet",0).build());r.mark_evm_broadcast("nfa-1".into(),id,a.clone(),None);
        assert!(evm_cb(&mut r,PromiseResult::Successful(b"true".to_vec()),"replace",id));
        testing_env!(context("reporter.testnet",0).build());r.mark_evm_broadcast("nfa-1".into(),id,b.clone(),Some(1));
        assert_eq!(r.evm_broadcasts("nfa-1".into(),id).len(),2);
        assert!(!reconcile_with(&mut r,id,&format!("0x{}","c".repeat(64))),"Unrecorded hash is not accepted");
        assert!(reconcile_with(&mut r,id,&a));
        assert_eq!(r.operation("nfa-1".into(),id).unwrap().status,OpStatus::Finalized);
        assert!(r.agent("nfa-1".into()).unwrap().pending_op.is_none());
    }
    #[test]
    fn landed_cancellation_consumes_nonce_but_fails_the_transfer(){
        let (mut r,id)=signed_evm();
        let b=format!("0x{}","b".repeat(64));
        assert!(evm_cb(&mut r,PromiseResult::Successful(b"true".to_vec()),"cancel",id));
        assert_eq!(r.evm_operation("nfa-1".into(),id).unwrap().max_fee,2_200_000_000);
        testing_env!(context("reporter.testnet",0).build());r.mark_evm_broadcast("nfa-1".into(),id,b.clone(),Some(1));
        assert!(reconcile_with(&mut r,id,&b));
        assert_eq!(r.operation("nfa-1".into(),id).unwrap().status,OpStatus::Failed);
        assert_eq!(r.evm_operation("nfa-1".into(),id).unwrap().success,Some(true));
    }
    #[test]
    fn uncertain_replacement_signature_keeps_lock_and_earlier_candidate_reportable(){
        let (mut r,id)=signed_evm();
        let a=format!("0x{}","a".repeat(64));
        testing_env!(context("reporter.testnet",0).build());r.mark_evm_broadcast("nfa-1".into(),id,a.clone(),None);
        assert!(!evm_cb(&mut r,PromiseResult::Failed,"replace",id));
        assert_eq!(r.operation("nfa-1".into(),id).unwrap().status,OpStatus::Uncertain);
        assert_eq!(r.agent("nfa-1".into()).unwrap().lifecycle,Lifecycle::Draining);
        assert!(reconcile_with(&mut r,id,&a));
        assert_eq!(r.agent("nfa-1".into()).unwrap().lifecycle,Lifecycle::Active);
    }

    // ---- H1: the operation slot cannot be held for long or for free ----
    fn requested_scout(deadline_offset:u64)->(Registry,u64,String,u128,u128){
        let (mut r,input,fee,deposit)=scout_ready();
        let h=format!("sha256:{}",hex(&env::sha256(input.as_bytes())));
        testing_env!(context("customer.testnet",fee).block_timestamp(600).build());
        let id=r.request_paid_scout("nfa-1".into(),h,600+deadline_offset,U128(fee),U128(deposit),U128(deposit),limits(1_000_000));
        (r,id,input,fee,deposit)
    }
    #[test]
    #[should_panic(expected="Start deadline must be within 30 minutes")]
    fn paid_job_start_window_is_thirty_minutes(){ requested_scout(START_WINDOW_NS+1); }
    #[test]
    #[should_panic(expected="Job deadline must be within 30 minutes")]
    fn legacy_job_window_is_thirty_minutes(){
        let mut r=minted();let hash=format!("sha256:{}","a".repeat(64));
        let fee=NearToken::from_millinear(10).as_yoctonear();
        testing_env!(context("customer.testnet",fee).block_timestamp(1).build());
        r.request_scout_job("nfa-1".into(),hash.clone(),hash,START_WINDOW_NS+2,U128(fee));
    }
    #[test]
    fn unstarted_expiry_returns_deposit_and_pays_the_agent_for_the_slot(){
        let (mut r,id,_,fee,deposit)=requested_scout(START_WINDOW_NS);
        let before=r.payout(id_("customer.testnet")).available.0;let income=r.agent_income("nfa-1".into()).0;
        testing_env!(context("stranger.testnet",0).block_timestamp(600+START_WINDOW_NS).build());
        r.expire_unstarted_paid_scout("nfa-1".into(),id);
        let forfeit=fee-deposit-job_storage_fee();
        assert_eq!(r.payout(id_("customer.testnet")).available.0-before,deposit);
        assert_eq!(r.agent_income("nfa-1".into()).0-income,forfeit);
        assert!(r.service_forfeits("scout".into()).0>=forfeit);
        assert!(r.agent("nfa-1".into()).unwrap().pending_op.is_none());
    }
    #[test]
    fn owner_can_cancel_an_unstarted_job_with_full_refund(){
        let (mut r,id,input,fee,_)=requested_scout(START_WINDOW_NS);
        let before=r.payout(id_("customer.testnet")).available.0;
        testing_env!(context("customer.testnet",1).block_timestamp(700).build());
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(||r.cancel_unstarted_job("nfa-1".into(),id))).is_err());
        testing_env!(context("alice.testnet",1).block_timestamp(700).build());
        r.cancel_unstarted_job("nfa-1".into(),id);
        assert_eq!(r.payout(id_("customer.testnet")).available.0-before,fee);
        assert!(r.agent("nfa-1".into()).unwrap().pending_op.is_none());
        assert_eq!(r.paid_scout_job("nfa-1".into(),id).unwrap().status,"FAILED");
        // The customer cannot start a cancelled job.
        testing_env!(context("customer.testnet",0).block_timestamp(800).build());
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(||r.start_paid_scout("nfa-1".into(),id,input))).is_err());
    }
    #[test]
    #[should_panic(expected="Job already started")]
    fn owner_cannot_cancel_a_started_job(){
        let (mut r,id,input,_,_)=requested_scout(START_WINDOW_NS);
        testing_env!(context("customer.testnet",0).block_timestamp(700).build());let _=r.start_paid_scout("nfa-1".into(),id,input);
        testing_env!(context("alice.testnet",1).block_timestamp(800).build());r.cancel_unstarted_job("nfa-1".into(),id);
    }

    // ---- H3: storage and liabilities ----
    #[test]
    fn upgraded_registry_migrates_existing_escrow_income_and_credits_once(){
        let mut r=minted();r.next_token_number=2;
        let token="nfa-1".to_owned();
        let mut agent=r.agents.get(&token).unwrap();agent.pending_op=Some(7);r.agents.insert(&token,&agent);
        scout_jobs().insert(&op_key(&token,7),&ScoutJob{id:7,epoch:0,requester:id("customer.testnet"),
            brief_hash:"brief".into(),source_hash:"source".into(),fee:U128(2_000),deadline_ns:999,
            status:"REQUESTED".into(),output_hash:None,output_uri:None});
        let mut ledger=outlayer::PaidLedger::default();ledger.customer_escrow=U128(3_000);
        LookupMap::<u8,outlayer::PaidLedger>::new(&b"OLL"[..]).insert(&0,&ledger);
        incomes().insert(&token,&4_000);
        payouts().insert(&id("customer.testnet"),&Payout{available:U128(5_000),pending:Some((1,U128(6_000))),next_id:1});
        payouts().insert(&id("seller.testnet"),&Payout{available:U128(7_000),pending:None,next_id:0});
        ledger_totals().remove(&"liabilities".to_string());
        assert!(r.liability_migration_required());
        testing_env!(context("admin.testnet",0).build());
        let result=r.migrate_liabilities(vec![id("customer.testnet"),id("seller.testnet")],U128(18_000),U128(27_000));
        assert_eq!(result["total"],"27000");
        assert_eq!(r.registry_ledger()["liabilities"],"27000");
        assert!(!r.liability_migration_required());
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(||
            r.migrate_liabilities(vec![],U128(0),U128(0)))).is_err());
    }
    #[test]
    fn upgrade_blocks_liability_spending_until_migration(){
        let mut r=minted();r.next_token_number=2;
        payouts().insert(&id("alice.testnet"),&Payout{available:U128(1_000),pending:None,next_id:0});
        ledger_totals().remove(&"liabilities".to_string());
        testing_env!(context("alice.testnet",1).build());
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(||
            r.withdraw_proceeds(U128(1)))).is_err());
        testing_env!(context("admin.testnet",0).build());
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(||
            r.migrate_liabilities(vec![],U128(1_000),U128(1_000)))).is_err());
        assert!(r.liability_migration_required());
    }
    // Job storage bound: request growth (new requester) plus the larger of settlement or expiry.
    const REQUEST_BYTES_BOUND:u64=500;
    #[test]
    fn job_storage_is_covered_by_fee(){
        assert!(job_storage_fee()<=MIN_MARGIN_FOR_TESTS,"Minimum margin must cover job storage");
        assert!(u128::from(REQUEST_BYTES_BOUND+300)<=JOB_STORAGE_BYTES);
        let (mut r,input,fee,deposit)=scout_ready();
        let h=format!("sha256:{}",hex(&env::sha256(input.as_bytes())));
        let before=env::storage_usage();
        testing_env!(context("newcustomer.testnet",fee).block_timestamp(600).storage_usage(before).build());
        let id=r.request_paid_scout("nfa-1".into(),h,600+START_WINDOW_NS,U128(fee),U128(deposit),U128(deposit),limits(1_000_000));
        let requested=env::storage_usage()-before;
        assert!(requested<=REQUEST_BYTES_BOUND,"request grew {requested} bytes");
        let start=env::storage_usage();
        testing_env!(context("customer.testnet",0).block_timestamp(700).storage_usage(start).build());
        let _=r.start_paid_scout("nfa-1".into(),id,input);
        let out=serde_json::json!({"schemaVersion":1,"jobId":id,"status":"ok","outputHash":format!("sha256:{}","f".repeat(64)),"outputUri":format!("nfa://work/{}","f".repeat(64))});
        let s=env::storage_usage();testing_env!(context("nfa-1.registry.testnet",0).block_timestamp(800).storage_usage(s).build());
        let _=r.on_outlayer_job("nfa-1".into(),id,Some(out));
        let s=env::storage_usage();testing_env!(context("registry.testnet",0).storage_usage(s).build(),test_vm_config(),RuntimeFeesConfig::test(),Default::default(),vec![PromiseResult::Successful(vec![])]);
        let _=r.on_outlayer_replenished("nfa-1".into(),id);
        let settled=env::storage_usage()-start;
        assert!(u128::from(requested+settled)<=JOB_STORAGE_BYTES,"job storage {} bytes (request {requested}, settle {settled})",requested+settled);
    }
    #[test]
    fn expired_job_storage_is_covered_by_fee(){
        let (mut r,input,fee,deposit)=scout_ready();
        let h=format!("sha256:{}",hex(&env::sha256(input.as_bytes())));
        let before=env::storage_usage();
        testing_env!(context("newcustomer.testnet",fee).block_timestamp(600).storage_usage(before).build());
        let id=r.request_paid_scout("nfa-1".into(),h,600+START_WINDOW_NS,U128(fee),U128(deposit),U128(deposit),limits(1_000_000));
        let s=env::storage_usage();
        testing_env!(context("stranger.testnet",0).block_timestamp(600+START_WINDOW_NS).storage_usage(s).build());
        r.expire_unstarted_paid_scout("nfa-1".into(),id);
        let total=env::storage_usage()-before;
        assert!(u128::from(total)<=JOB_STORAGE_BYTES,"expired job storage {total} bytes");
    }
    #[test]
    #[should_panic(expected="Registry reserve")]
    fn payouts_stop_when_tracked_liabilities_exceed_the_balance(){
        let mut r=minted();
        testing_env!(context("alice.testnet",1).build());r.list_agent("nfa-1".into(),U128(NearToken::from_near(50).as_yoctonear()));
        // The mocked account balance (20 NEAR) cannot cover the 50 NEAR credited to the seller.
        testing_env!(context("bob.testnet",NearToken::from_near(50).as_yoctonear()).build());r.buy("nfa-1".into(),1);
        assert_eq!(r.registry_ledger()["liabilities"],NearToken::from_near(50).as_yoctonear().to_string());
        testing_env!(context("alice.testnet",1).build());let _=r.withdraw_proceeds(U128(NearToken::from_near(1).as_yoctonear()));
    }
    #[test]
    fn failed_provision_credits_the_creator_and_cannot_mint_later(){
        let mut r=registry();
        testing_env!(context("alice.testnet",NearToken::from_near(6).as_yoctonear()).build());
        let token=r.create_agent("req".into(),format!("sha256:{}","a".repeat(64)),"nfa://m".into());
        testing_env!(context("registry.testnet",0).build(),test_vm_config(),RuntimeFeesConfig::test(),Default::default(),vec![PromiseResult::Failed]);
        assert!(!r.on_provision(token.clone()));
        let refund=NearToken::from_near(6).as_yoctonear()-REGISTRY_STORAGE;
        assert_eq!(r.payout(id_("alice.testnet")).available.0,refund);
        assert_eq!(r.registry_ledger()["liabilities"],refund.to_string());
        let status=serde_json::json!({"controller":"registry.testnet","reporter":"reporter.testnet","guardian":"guardian.testnet","pending":null,"next_operation_id":1});
        testing_env!(context("registry.testnet",0).build(),test_vm_config(),RuntimeFeesConfig::test(),Default::default(),vec![PromiseResult::Successful(status.to_string().into_bytes())]);
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(||r.on_recover_provision(token.clone()))).is_err());
        assert!(r.agent(token).is_none());
    }
    #[test]
    fn audit_keeps_bounded_recent_rows(){
        let mut r=minted();
        testing_env!(context("alice.testnet",1).build());
        for i in 0..70u32{r.update_manifest("nfa-1".into(),format!("sha256:{:064x}",i),"nfa://m".into());}
        let audit=r.studio_audit("nfa-1".into(),1,50);
        assert_eq!(audit["count"],70);
        let rows=audit["rows"].as_array().unwrap();
        assert!(!rows.is_empty()&&rows.iter().all(|row|row["id"].as_u64().unwrap()>70-studio::AUDIT_ROWS));
    }
    #[test]
    fn audit_skips_job_events_already_in_job_records(){
        let (r,_,_,_)=scout_ready();
        let rows=r.studio_audit("nfa-1".into(),1,50);
        let events:Vec<_>=rows["rows"].as_array().unwrap().iter().map(|row|row["event"].as_str().unwrap().to_string()).collect();
        assert!(events.iter().any(|e|e=="service_policy_updated"));
        assert!(events.iter().all(|e|!e.starts_with("service_job_")),"{events:?}");
    }
    #[test]
    fn one_requester_cannot_take_the_whole_research_allowance(){
        let (r,_,_,_)=research_setup();let token="nfa-1".to_string();let me=id_("c1.testnet");
        testing_env!(context("keeper.testnet",0).block_timestamp(600).build());
        r.reserve_research(&token,200,&"a".repeat(64),&me);
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(||r.reserve_research(&token,201,&"a".repeat(64),&me))).is_err());
        r.reserve_research(&token,201,&"a".repeat(64),&id_("c2.testnet"));
    }

    // ---- M4: upgrade powers ----
    fn input_ctx(mut c:near_sdk::VMContext,bytes:Vec<u8>)->near_sdk::VMContext{c.input=std::rc::Rc::from(bytes);c}
    #[test]
    fn registry_upgrade_waits_for_the_public_delay(){
        let mut r=minted();let code=vec![0u8,97,115,109,1,0,0,0];let hash=hex(&env::sha256(&code));
        testing_env!(context("alice.testnet",0).build());
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(||r.propose_registry_upgrade(hash.clone()))).is_err());
        testing_env!(context("admin.testnet",0).block_timestamp(10).build());r.propose_registry_upgrade(hash.clone());
        assert_eq!(r.authorities()["registry_upgrade"]["code_hash"],hash);
        testing_env!(input_ctx(context("admin.testnet",0).block_timestamp(10+governance::REGISTRY_UPGRADE_DELAY_NS-1).build(),code.clone()));
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(||r.apply_registry_upgrade())).is_err(),"before delay");
        testing_env!(input_ctx(context("admin.testnet",0).block_timestamp(10+governance::REGISTRY_UPGRADE_DELAY_NS).build(),vec![9,9]));
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(||r.apply_registry_upgrade())).is_err(),"different code");
        testing_env!(input_ctx(context("admin.testnet",0).block_timestamp(10+governance::REGISTRY_UPGRADE_DELAY_NS).build(),code));
        let _=r.apply_registry_upgrade();
        assert!(r.authorities()["registry_upgrade"].is_null());
    }
    #[test]
    fn only_the_current_unlisted_owner_approves_a_vault_upgrade(){
        let mut r=minted();let hash="ab".repeat(32);
        testing_env!(context("bob.testnet",1).build());
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(||r.approve_vault_upgrade("nfa-1".into(),hash.clone()))).is_err());
        testing_env!(context("alice.testnet",1).build());r.list_agent("nfa-1".into(),U128(1));
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(||r.approve_vault_upgrade("nfa-1".into(),hash.clone()))).is_err(),"listed");
        r.unlist_agent("nfa-1".into());
        let _=r.approve_vault_upgrade("nfa-1".into(),hash);
    }

    #[test]
    fn upgrade_approval_cannot_cross_transfer_or_sale_and_deployment_blocks_handover(){
        let mut r=minted();let token="nfa-1".to_string();let code=vec![0,97,115,109,1,0,0,0];let hash=hex(&env::sha256(&code));
        testing_env!(context("alice.testnet",1).build());
        let _=r.approve_vault_upgrade(token.clone(),hash.clone());
        r.nft_transfer(id_("bob.testnet"),token.clone(),None,None);
        testing_env!(context("nfa-1.registry.testnet",0).build());
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(||r.authorize_vault_upgrade(token.clone(),hash.clone(),Some(0),near_sdk::json_types::Base64VecU8(code.clone())))).is_err(),"seller approval is stale");
        // Same bytes are authorized only with the buyer's epoch; a stranger cannot authorize.
        testing_env!(context("stranger.testnet",0).build());
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(||r.authorize_vault_upgrade(token.clone(),hash.clone(),Some(1),near_sdk::json_types::Base64VecU8(code.clone())))).is_err());
        testing_env!(context("nfa-1.registry.testnet",0).build());
        let _=r.authorize_vault_upgrade(token.clone(),hash.clone(),Some(1),near_sdk::json_types::Base64VecU8(code.clone()));
        testing_env!(context("bob.testnet",1).build());
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(||r.nft_transfer(id_("alice.testnet"),token.clone(),None,None))).is_err());
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(||r.nft_transfer_call(id_("alice.testnet"),token.clone(),None,None,"x".into()))).is_err());
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(||r.list_agent(token.clone(),U128(10)))).is_err());
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(||r.approve_vault_upgrade(token.clone(),hash.clone()))).is_err());
        // Even failed deployment releases the barrier, without a timeout that could race it.
        testing_env!(context("registry.testnet",0).build(),test_vm_config(),RuntimeFeesConfig::test(),Default::default(),vec![PromiseResult::Failed]);
        assert!(!r.on_vault_upgrade_applied(token.clone(),hash.clone()));
        testing_env!(context("bob.testnet",1).block_timestamp(10).build());
        r.create_listing(token.clone(),U128(10),1000);
        testing_env!(context("alice.testnet",10).block_timestamp(11).build());r.buy(token.clone(),1);
        testing_env!(context("nfa-1.registry.testnet",0).build());
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(||r.authorize_vault_upgrade(token.clone(),hash.clone(),Some(1),near_sdk::json_types::Base64VecU8(code.clone())))).is_err(),"paid sale invalidates approval too");
        // Public-delay upgrades still serialize with a transfer, but need no owner approval.
        let _=r.authorize_vault_upgrade(token.clone(),hash.clone(),None,near_sdk::json_types::Base64VecU8(code));
        testing_env!(context("registry.testnet",0).build(),test_vm_config(),RuntimeFeesConfig::test(),Default::default(),vec![PromiseResult::Successful(vec![])]);
        assert!(r.on_vault_upgrade_applied(token.clone(),hash));
        testing_env!(context("alice.testnet",1).build());r.nft_transfer(id_("bob.testnet"),token,None,None);
    }

    #[test]
    fn delayed_vault_upgrade_can_recover_busy_or_listed_agents_but_blocks_sales(){
        let mut r=minted();let token="nfa-1".to_string();let code=vec![0,97,115,109,1,0,0,0];let hash=hex(&env::sha256(&code));
        let mut a=r.agents.get(&token).unwrap();a.pending_op=Some(9);a.lifecycle=Lifecycle::Draining;r.agents.insert(&token,&a);
        testing_env!(context("nfa-1.registry.testnet",0).build());
        let _=r.authorize_vault_upgrade(token.clone(),hash.clone(),None,near_sdk::json_types::Base64VecU8(code.clone()));
        testing_env!(context("registry.testnet",0).build(),test_vm_config(),RuntimeFeesConfig::test(),Default::default(),vec![PromiseResult::Failed]);
        assert!(!r.on_vault_upgrade_applied(token.clone(),hash.clone()));
        assert_eq!(r.agents.get(&token).unwrap().pending_op,Some(9));
        a.pending_op=None;a.lifecycle=Lifecycle::Active;r.agents.insert(&token,&a);
        testing_env!(context("alice.testnet",1).block_timestamp(1).build());r.create_listing(token.clone(),U128(10),1000);
        testing_env!(context("nfa-1.registry.testnet",0).build());
        let _=r.authorize_vault_upgrade(token.clone(),hash.clone(),None,near_sdk::json_types::Base64VecU8(code));
        testing_env!(context("bob.testnet",10).block_timestamp(2).build());
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(||r.buy(token.clone(),1))).is_err(),"buyer cannot cross deployment");
        testing_env!(context("registry.testnet",0).build(),test_vm_config(),RuntimeFeesConfig::test(),Default::default(),vec![PromiseResult::Successful(vec![])]);
        assert!(r.on_vault_upgrade_applied(token.clone(),hash));
        testing_env!(context("bob.testnet",10).block_timestamp(2).build());r.buy(token,1);
    }

    // ---- M2/M5 ----
    #[test]
    fn over_reservation_cost_does_not_panic_the_result_callback(){
        let (mut r,input,fee,deposit)=research_setup();let cfg=r.research_config("nfa-1".into()).unwrap();
        testing_env!(context("customer.testnet",fee).block_timestamp(600).build());
        let id=r.request_reviewed_service_job("nfa-1".into(),"research".into(),format!("sha256:{}",hex(&env::sha256(input.as_bytes()))),1000,U128(fee),U128(deposit),U128(deposit),
            outlayer::SkillLimits{max_instructions:1_000_000,max_memory_mb:64,max_execution_seconds:10},"a".repeat(64),1,Some(cfg.configuration_hash));
        let _=r.start_service_job("nfa-1".into(),id,input);
        testing_env!(context("nfa-1.registry.testnet",0).block_timestamp(700).build());
        let out=serde_json::json!({"schemaVersion":1,"jobId":id,"status":"ok","outputHash":format!("sha256:{}","f".repeat(64)),
            "outputUri":format!("nfa://work/{}","f".repeat(64)),"inferenceOutcome":"succeeded","pricedUsageMicrousd":999_999_999u64});
        assert!(matches!(r.on_outlayer_job("nfa-1".into(),id,Some(out)),PromiseOrValue::Promise(_)));
        let usage=r.research_usage("nfa-1".into(),id).unwrap();
        assert_eq!(usage.state,"UNKNOWN");assert!(usage.priced_usage_microusd.is_none());
    }
    fn uncertain_recall()->(Registry,u64,u128){
        let (mut r,job_id,input,_,deposit)=paid_setup();
        testing_env!(context("keeper.testnet",0).build());let _=r.start_paid_scout("nfa-1".into(),job_id,input);
        let out=serde_json::json!({"schemaVersion":1,"jobId":job_id,"status":"ok","outputHash":format!("sha256:{}","f".repeat(64)),"outputUri":format!("nfa://work/{}","f".repeat(64))});
        testing_env!(context("nfa-1.registry.testnet",0).build());let _=r.on_outlayer_job("nfa-1".into(),job_id,Some(out));
        testing_env!(context("registry.testnet",0).build(),test_vm_config(),RuntimeFeesConfig::test(),Default::default(),vec![PromiseResult::Successful(vec![])]);
        let _=r.on_outlayer_replenished("nfa-1".into(),job_id);
        testing_env!(context("alice.testnet",deposit).block_timestamp(1_000).build());
        let _=r.recall_owner_memory("nfa-1".into(),job_id,U128(deposit));
        let id=r.agent("nfa-1".into()).unwrap().pending_op.unwrap();
        testing_env!(context("nfa-1.registry.testnet",0).block_timestamp(2_000).build());
        let _=r.on_outlayer_recall("nfa-1".into(),id,job_id,None);
        (r,id,deposit)
    }
    #[test]
    fn uncertain_recall_is_released_and_refunds_the_paying_owner(){
        let (mut r,id,deposit)=uncertain_recall();
        let before=r.payout(id_("alice.testnet")).available.0;
        testing_env!(context("stranger.testnet",0).block_timestamp(3_000).build());let _=r.release_recall("nfa-1".into(),id);
        testing_env!(context("registry.testnet",0).block_timestamp(3_000).build(),test_vm_config(),RuntimeFeesConfig::test(),Default::default(),vec![PromiseResult::Successful(b"false".to_vec())]);
        assert!(!r.on_recall_released("nfa-1".into(),id));
        testing_env!(context("registry.testnet",0).block_timestamp(3_000).build(),test_vm_config(),RuntimeFeesConfig::test(),Default::default(),vec![PromiseResult::Successful(b"true".to_vec())]);
        assert!(r.on_recall_released("nfa-1".into(),id));
        assert!(r.agent("nfa-1".into()).unwrap().pending_op.is_none());
        assert_eq!(r.payout(id_("alice.testnet")).available.0-before,deposit);
    }

    // ---- M1: customers can keep a Research job out of the shared prior-work context ----
    #[test]
    fn research_memory_opt_out_sends_no_prior_work(){
        let (mut r,_,fee,deposit)=research_setup();let cfg=r.research_config("nfa-1".into()).unwrap();
        research::tests_support::finalize(&"nfa-1".to_string(),7,"sha256:prior");
        for (payer,use_memory,expected) in [("c1.testnet",None,1usize),("c2.testnet",Some(false),0)]{
            let mut value=serde_json::json!({"question":"What is a stable vault?","sources":[{"title":"Vault","url":"https://docs.near.org/vault"}]});
            if let Some(flag)=use_memory{value["useMemory"]=serde_json::json!(flag)}
            let input=value.to_string();
            testing_env!(context(payer,fee).block_timestamp(600).build());
            let id=r.request_reviewed_service_job("nfa-1".into(),"research".into(),format!("sha256:{}",hex(&env::sha256(input.as_bytes()))),1000,U128(fee),U128(deposit),U128(deposit),
                outlayer::SkillLimits{max_instructions:1_000_000,max_memory_mb:64,max_execution_seconds:10},"a".repeat(64),1,Some(cfg.configuration_hash.clone()));
            testing_env!(context(payer,0).block_timestamp(600).build());
            let _=r.start_service_job("nfa-1".into(),id,input);
            let receipts=near_sdk::test_utils::get_created_receipts();
            let args=receipts.iter().flat_map(|r|r.actions.iter()).find_map(|a|match a{
                near_sdk::mock::MockAction::FunctionCallWeight{method_name,args,..} if method_name==b"execute_research_skill"=>Some(serde_json::from_slice::<serde_json::Value>(args).unwrap()),_=>None}).unwrap();
            let payload:serde_json::Value=serde_json::from_str(args["input_data"].as_str().unwrap()).unwrap();
            assert_eq!(payload["context"]["priorWork"].as_array().unwrap().len(),expected);
            assert!(payload.get("useMemory").is_none(),"the flag is consumed by the registry");
            testing_env!(context("alice.testnet",1).block_timestamp(600).build());r.cancel_unstarted_job_for_tests("nfa-1".into(),id);
        }
    }

    #[test]
    fn payment_key_issuance_blocks_sale_until_reconciled_and_approval_expires_on_transfer(){
        let mut r=minted();let token="nfa-1".to_owned();
        LookupMap::<TokenId,outlayer::OutlayerProject>::new(&b"OLP"[..]).insert(&token,&outlayer::OutlayerProject{project_id:"nfa-1.registry.testnet/scout".into(),
            project_uuid:"p1".into(),version_key:"a".repeat(64),candidate_version:None,state:"READY".into(),action:String::new()});
        let ciphertext="A".repeat(120);let hash=hex(&env::sha256(ciphertext.as_bytes()));
        testing_env!(context("alice.testnet",1).block_timestamp(1).build());
        r.approve_payment_key(token.clone(),1,hash);
        testing_env!(context("admin.testnet",0).block_timestamp(2).build());
        let _=r.issue_payment_key(token.clone(),ciphertext.clone());
        testing_env!(context("alice.testnet",1).block_timestamp(3).build());
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(||
            r.nft_transfer(id("bob.testnet"),token.clone(),None,None))).is_err());
        testing_env!(context("registry.testnet",0).build(),test_vm_config(),RuntimeFeesConfig::test(),
            Default::default(),vec![PromiseResult::Failed]);
        assert!(!r.on_payment_key_issued(token.clone(),1));
        assert_eq!(r.payment_key_setup(token.clone()).unwrap().state,"UNCERTAIN");
        testing_env!(context("alice.testnet",1).block_timestamp(4).build());
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(||
            r.nft_transfer(id("bob.testnet"),token.clone(),None,None))).is_err());
        testing_env!(context("registry.testnet",0).build(),test_vm_config(),RuntimeFeesConfig::test(),
            Default::default(),vec![PromiseResult::Successful(b"false".to_vec())]);
        assert!(!r.on_payment_key_issued(token.clone(),1));
        testing_env!(context("alice.testnet",1).block_timestamp(5).build());
        r.nft_transfer(id("bob.testnet"),token.clone(),None,None);
        testing_env!(context("admin.testnet",0).block_timestamp(6).build());
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(||
            r.issue_payment_key(token,ciphertext))).is_err());
    }

    #[test]
    fn build_time_vault_hash_matches_the_embedded_code(){
        let _=registry();assert_eq!(vault_code_hash(),env::sha256(VAULT_CODE));
    }
}
