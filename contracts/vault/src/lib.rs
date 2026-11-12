use near_sdk::{env, near, require, AccountId, Gas, NearToken, Promise};
use sha3::{Digest, Keccak256};

const SIGNER: &str = "v1.signer-prod.testnet";
const PATH: &str = "eth-sepolia-v1";
const CHAIN_ID: u64 = 11_155_111;
const GAS_LIMIT: u64 = 21_000;
const VALUE_WEI: u64 = 1_000_000_000_000; // 0.000001 Sepolia ETH
const MAX_FEE_WEI: u64 = 10_000_000_000; // 10 gwei

#[near(contract_state)]
pub struct Vault {
    operator: AccountId,
    recipient: [u8; 20],
    pending: bool,
    digest: Option<[u8; 32]>,
    unsigned_tx: Vec<u8>,
    signature: Option<Vec<u8>>,
    nonce: Option<u64>,
}

impl Default for Vault {
    fn default() -> Self { env::panic_str("Vault is not initialized") }
}

#[near]
impl Vault {
    #[init]
    pub fn new(operator: AccountId, recipient_hex: String) -> Self {
        require!(!env::state_exists(), "Already initialized");
        let recipient_bytes = hex_bytes(&recipient_hex);
        require!(recipient_bytes.len() == 20, "Recipient must be 20 bytes");
        let mut recipient = [0u8; 20];
        recipient.copy_from_slice(&recipient_bytes);
        Self { operator, recipient, pending: false, digest: None, unsigned_tx: vec![], signature: None, nonce: None }
    }

    pub fn request_test_transfer(&mut self, nonce: u64, priority_fee: u64, max_fee: u64) -> Promise {
        require!(env::predecessor_account_id() == self.operator, "Operator only");
        require!(!self.pending && self.digest.is_none(), "One signature per spike vault");
        require!(priority_fee > 0 && priority_fee <= max_fee && max_fee <= MAX_FEE_WEI, "Invalid fee");
        let unsigned = unsigned_eip1559(nonce, priority_fee, max_fee, &self.recipient);
        let digest: [u8; 32] = Keccak256::digest(&unsigned).into();
        self.pending = true;
        self.nonce = Some(nonce);
        self.digest = Some(digest);
        self.unsigned_tx = unsigned;
        let payload = hex(&digest);
        let args = serde_json::json!({"request":{"path":PATH,"payload_v2":{"Ecdsa":payload},"domain_id":0}});
        Promise::new(SIGNER.parse().unwrap()).function_call(
            "sign".to_string(), args.to_string().into_bytes(), NearToken::from_yoctonear(1), Gas::from_tgas(30)
        ).then(Promise::new(env::current_account_id()).function_call(
            "on_signature".to_string(), vec![], NearToken::from_yoctonear(0), Gas::from_tgas(20)
        ))
    }

    #[private]
    pub fn on_signature(&mut self) -> bool {
        require!(self.pending, "No request");
        self.pending = false;
        match env::promise_result_checked(0, 2048) {
            Ok(bytes) => {
                self.signature = Some(bytes);
                env::log_str("NFA_T004_SIGNATURE_READY");
                true
            }
            Err(_) => {
                // Keep the digest reserved: a timeout does not establish that no signature exists.
                env::log_str("NFA_T004_SIGNATURE_UNCERTAIN");
                false
            }
        }
    }

    pub fn evidence(&self) -> serde_json::Value {
        serde_json::json!({
            "path":PATH, "domain_id":0, "chain_id":CHAIN_ID,
            "recipient":"0x".to_string()+&hex(&self.recipient), "value_wei":VALUE_WEI.to_string(),
            "pending":self.pending, "nonce":self.nonce,
            "digest":self.digest.map(|d| "0x".to_string()+&hex(&d)),
            "unsigned_tx":"0x".to_string()+&hex(&self.unsigned_tx),
            "signature":self.signature.as_ref().map(|s| String::from_utf8_lossy(s).to_string()),
        })
    }
}

fn hex(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes { out.push(ALPHABET[(b >> 4) as usize] as char); out.push(ALPHABET[(b & 15) as usize] as char); }
    out
}

fn hex_bytes(s: &str) -> Vec<u8> {
    let s = s.strip_prefix("0x").unwrap_or(s);
    require!(s.len() % 2 == 0, "Odd hex length");
    s.as_bytes().chunks_exact(2).map(|c| u8::from_str_radix(std::str::from_utf8(c).unwrap(), 16).expect("Invalid hex")).collect()
}

fn uint(n: u64) -> Vec<u8> {
    if n == 0 { return vec![]; }
    let raw = n.to_be_bytes(); raw[raw.iter().position(|b| *b != 0).unwrap()..].to_vec()
}

fn rlp_bytes(b: &[u8]) -> Vec<u8> {
    if b.len() == 1 && b[0] < 128 { return b.to_vec(); }
    if b.len() <= 55 { let mut v = vec![0x80 + b.len() as u8]; v.extend_from_slice(b); return v; }
    panic!("Oversized field");
}

fn rlp_list(items: &[Vec<u8>]) -> Vec<u8> {
    let body: Vec<u8> = items.iter().flat_map(|i| i.iter().copied()).collect();
    if body.len() <= 55 { let mut v = vec![0xc0 + body.len() as u8]; v.extend(body); return v; }
    require!(body.len() < 256, "Oversized transaction");
    let mut v = vec![0xf8, body.len() as u8]; v.extend(body); v
}

fn unsigned_eip1559(nonce: u64, priority_fee: u64, max_fee: u64, recipient: &[u8; 20]) -> Vec<u8> {
    let fields = [CHAIN_ID, nonce, priority_fee, max_fee, GAS_LIMIT].map(|n| rlp_bytes(&uint(n)));
    let mut items = fields.to_vec();
    items.push(rlp_bytes(recipient));
    items.push(rlp_bytes(&uint(VALUE_WEI)));
    items.push(rlp_bytes(&[])); // calldata
    items.push(vec![0xc0]); // empty access list
    let mut tx = vec![0x02]; tx.extend(rlp_list(&items)); tx
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn typed_transaction_has_expected_shape() {
        let t = unsigned_eip1559(0, 1_000_000_000, 2_000_000_000, &[0x11; 20]);
        assert_eq!(t[0], 2);
        assert!((0xc0..=0xf8).contains(&t[1]));
        assert_eq!(t.last(), Some(&0xc0));
        assert_eq!(t.windows(20).filter(|w| *w == &[0x11; 20]).count(), 1);
        assert_ne!(Keccak256::digest(&t).as_slice(), &[0u8; 32]);
    }
}
