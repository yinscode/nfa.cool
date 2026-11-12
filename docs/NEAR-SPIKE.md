# T004 — NEAR interfaces and live signer spike

Status: **live Chain Signature and Sepolia receipt verified** on 2026-11-11.
The failure-injection/reconciliation gate remains open. The deployed one-use
vault has a funds-stranding flaw documented below.

## Verified in primary source

| Surface | Evidence | Consequence for NFA |
| --- | --- | --- |
| NEP-171 v1.2 | [Specification](https://github.com/near/NEPs/blob/master/neps/nep-0171.md) defines `nft_transfer`, `nft_transfer_call`, receiver callback, approval invalidation and rollback | Registry must suspend authority between transfer-call's temporary transfer and its final resolve; preserve approvals if rollback requires it. |
| Account control | [NEAR contracts](https://docs.near.org/smart-contracts/what-is) can create sub-accounts, deploy code and transfer funds; [full-access keys](https://docs.near.org/protocol/accounts-contracts/access-keys) can bypass code | Test exact keyless sub-account creation before trusting registry-only vault control. |
| MPC signer ID | [near/mpc devnet constants at b5bafa3](https://github.com/near/mpc/blob/b5bafa338f6e352edfabd65b86ae0286886bb9b9/crates/devnet/src/constants.rs) name `v1.signer-prod.testnet` | Configured testnet target; actual code hash/liveness still needs RPC. |
| Sign call | [MPC `sign`](https://github.com/near/mpc/blob/b5bafa338f6e352edfabd65b86ae0286886bb9b9/crates/contract/src/api/sign.rs) uses the immediate predecessor, path and domain. The [current request type](https://github.com/near/mpc/blob/b5bafa338f6e352edfabd65b86ae0286886bb9b9/crates/near-mpc-crypto-types/src/sign.rs) serializes `path`, `payload_v2`, `domain_id` under `request` | Vault must call signer itself. On EVM use ECDSA domain after reading deployed config; never allow owner-supplied arbitrary payload. |
| Deposit and gas | [Interface deposit](https://github.com/near/mpc/blob/b5bafa338f6e352edfabd65b86ae0286886bb9b9/crates/near-mpc-contract-interface/src/deposits.rs) is 1 yoctoNEAR; [typed client](https://github.com/near/mpc/blob/b5bafa338f6e352edfabd65b86ae0286886bb9b9/crates/near-mpc-contract-interface/src/client.rs) sets `SIGN_GAS` to 15 Tgas | Treat 15 Tgas as the client's current call allowance, verify deployed contract's runtime minimum and budget callback gas separately. |
| Derived key view | [MPC `derived_public_key`](https://github.com/near/mpc/blob/b5bafa338f6e352edfabd65b86ae0286886bb9b9/crates/contract/src/api/keys.rs) accepts path, optional predecessor and domain | Compare vault IDs in a read-only view and derive the EVM address from the returned secp256k1 key. Views alone do not demonstrate signing authority. |
| Foreign state | [NEAR Chain Signatures](https://docs.near.org/chain-abstraction/chain-signatures) describes outgoing signing, not foreign-state proof. [MPC code](https://github.com/near/mpc/tree/b5bafa338f6e352edfabd65b86ae0286886bb9b9) has `verify_foreign_transaction`, but deployment support is unverified | For MVP use a named trusted settlement reporter, explicitly disclosed, and keep transfer locked when the reporter cannot reconcile an issued signature. |
| EVM chain | [Geth's Sepolia documentation](https://geth.ethereum.org/docs/getting-started) uses chain ID 11155111 | Pin Sepolia in configuration, verify RPC `eth_chainId` live before funding. |

## Track-linked account-NFT comparison

The [House of Stake account NFT repository](https://github.com/houseofstake/tla-contracts/tree/d85860a8cc2bfcb8b617b28cab558da5d39333fc)
describes deployed, audited rented NEAR names: NEP-171 token + actual sub-account
with wallet logic, registrar, extension and recovery. Its
[wallet](https://github.com/houseofstake/tla-contracts/blob/d85860a8cc2bfcb8b617b28cab558da5d39333fc/contracts/hos-wallet/src/lib.rs)
has bounded spending grants and an authorization version; its
[registry](https://github.com/houseofstake/tla-contracts/blob/d85860a8cc2bfcb8b617b28cab558da5d39333fc/contracts/tla-registry/src/nft.rs)
rotates control through asynchronous promises and has transfer gates.

Its lease expiration/reclaim and transfer rules serve rented names, whereas an
NFA is meant to remain an owned business account that can carry inventory.
Its balance gate can block transfer when allowlisted fungible assets are held;
that behavior conflicts with our desired 'assets transfer with the agent' demo.
Reuse its design patterns and test cases where relevant, not its lease machinery.
GitHub reports no license in repository metadata and root listing has no LICENSE
file at the checked revision; do not copy source code until licensing is verified.

The draft [sharded NFT items proposal](https://github.com/houseofstake/tla-contracts/blob/d85860a8cc2bfcb8b617b28cab558da5d39333fc/docs/sharded-nft-items.md)
explains the consistency question when the NFT is also an account. Our MVP uses
one registry as authority and vaults bound once to it, with an explicit vault ID
per token. The proposal is a draft, not a requirement of NEP-171.

## Read-only probe

`node scripts/probe-near.mjs --dry-run` prints the exact read-only queries.
`node scripts/probe-near.mjs` requests finalized NEAR status, signer account code
hash and `derived_public_key` for two example vault predecessors at the fixed
`eth-sepolia-v1` path. Set `NEAR_RPC_URL` and optionally `EVM_RPC_URL` and
`EVM_CHAIN_ID` to verify Sepolia with `eth_chainId`. The probe makes no writes,
uses no private keys and cannot accidentally spend assets.

**Observed 2026-11-10:** the local command runtime cannot resolve the public
RPC DNS name, but a separate network runtime successfully POSTed JSON-RPC to
`https://rpc.testnet.near.org`. The signer has code hash
`CpGX8ywXJwvWPgZFDDCTCuPJBHF7BATT51gSfc3APERJ`, its `config` reports a
15 Tgas sign call requirement, and `public_key` for domain 0 and
`derived_public_key` succeeded. The vault predecessor and fixed path in
[public deployment data](../deployments/t004-vault-public.json) yielded a
64-byte secp256k1 key and Sepolia address
`0x84e18A402f8a2B5C6c68B76FDFE2c24755A37948`. A second predecessor
returned a different key. `eth_chainId` at
`https://ethereum-sepolia-rpc.publicnode.com` returned `0xaa36a7` (11155111);
the derived address then had zero balance and nonce, and the NEAR vault did
not yet exist. The subsequent live sequence below proves vault-originated
signing.

## Prepared live transaction spike

`contracts/vault/` hashes a typed Sepolia EIP-1559 transfer (one fixed
recipient, 0.000001 test ETH, capped fees) and calls the signer from the
vault's account ID. It saves the unsigned transaction, digest and response.
A failed callback leaves the digest reserved. The separate funded testnet
operator is a temporary phase-0 driver, not the registry authorization planned
for T007–T013.

`cargo check --offline --target wasm32-unknown-unknown` and `cargo build
--offline --release --target wasm32-unknown-unknown` passed with near-sdk
5.30.1 and Rust 1.99.1. Native `cargo test` is blocked by uncached/yanked
SDK dependencies. Deployed WASM SHA-256:
`48ff60912ad362ded3b26329ce88ee3ebfb49b7c6f3f2d7d5a657adb2c46a566`.

Funding targets: vault NEAR implicit account
`fa972bff78d03315596561db15938c9dffd0e3779e57e984f7b2874cd3879f41`
(5 testNEAR), operator NEAR implicit account
`01871de834e09e380684d3cdbdfd4a3d029051ce76957865bbccc19471b35ae8`
(5 testNEAR), and Sepolia address above (0.5 Sepolia ETH actually sent). Private keys are
in ignored mode-0600 files; never include them in archives, commits or logs.
The vault deployment key was removed after initialization, before the
operator-initiated signing request.

`scripts/t004-sign-tx.cjs` constructs `deploy`, `delete-key` and `request`
transactions offline with fresh finalized block hash and access-key nonce.
It writes ignored signed JSON. Relay the base64 transaction through the
working network runtime's `broadcast_tx_commit`; inspect receipts, code and
access keys, then verify the signature against the derived key before Sepolia
broadcast. The live positive-path result is recorded below.

### Live transaction evidence

| Step | Transaction / observation |
| --- | --- |
| Deploy and initialize vault | NEAR `XSzvZkv849EmPnvMwWU5W5Cyu7YWdBEjnyRv1BxiqcT`; code hash `5uxDFHRShhtTgJmvDy5EZN8bBeEFXQDGeUfpD3hEBqN5`; initialized `evidence()` view verified |
| Delete deployment key | NEAR `DLoFffrNZA5MiAamaQohLCDUp2exjnF6fAgxQ2G2VxTZ`; finalized access-key list has zero keys |
| Sign from vault | NEAR `GbnEAyzG4LA2vBvVKDzokFWfhbELxf3WdGJ7zW25pLbX`; MPC signer log identifies the vault as predecessor; callback logged `NFA_T004_SIGNATURE_READY` |
| Verify signature | Digest `0xb33385fc6bc707ca41641787e82f2eaad0a00b0ac564f4204dac5d75a48f736c`; signature verified and recovered the vault's derived public key; repeated derivation returned the same key |
| Broadcast and confirm | Sepolia `0xa4c4ddd3948a1d6dfb443d8193bd0ea13ac6801c5bd1bea0a53fadd659fd7c8a`; receipt status `0x1`, nonce 0, chain ID 11155111, 21,000 gas, 0.000001 ETH to `0x000000000000000000000000000000000000dEaD`; sender matched derived address |

`scripts/t004-evm-tx.cjs` independently checks the digest, signature and
recovered key, then assembles the typed transaction. The clean npm CI run
passed after this addition. This demonstrates the positive integration path.

### Funds-stranding incident — do not fund this vault again

The user sent **0.5 Sepolia test ETH**, above the initially suggested 0.001.
The deployed phase-0 vault permits only one signature, has no upgrade method,
and now has zero NEAR access keys. Its first transfer spent 0.000001 ETH plus
gas, leaving approximately **0.499978 Sepolia ETH** at its derived address.
The vault also retains its testNEAR. Its old Ed25519 key file cannot authorize
anything after the on-chain key deletion. Under the current code and normal
NEAR/MPC rules there is no route to sign another EVM transaction or upgrade
this contract. This was an avoidable deployment error: the 0.5 ETH balance
was known before the key was removed. Do not claim those test assets can be
returned or transferred with an NFT.

The next vault must support repeatable bounded transfers, reporter-confirmed
nonce advancement, and a tested recovery/upgrade procedure. Before deleting
its deployment key, prove it can withdraw a larger unexpected deposit. Any
upgrade authority is a disclosed trust assumption, never unrestricted NFT
owner authority.

## MVP decision and completion gate

**Decision:** Sepolia + one typed native-ETH transfer operation per NFA. A vault
contract remains signer predecessor through owner changes, using a fixed path
and domain. The first version relies on a configured trusted reporter for EVM
receipt/nonce observations. A stale or disagreeing reporter stops ownership
transfer until reconciliation. No generic raw signer endpoint.

Positive-path items 1–3 were verified live. The negative-path item 4 is open:

1. Run the read-only probe against public NEAR and Sepolia RPCs. Record final
   block, signer code hash, signer `config` domains, two derived keys and two
   checksummed EVM addresses. Compare expected and observed chain IDs.
2. Build a tiny vault spike in `contracts/vault/` with no owner-facing signing
   entrypoint. Its only method builds a fixed, typed Sepolia test transfer and
   calls `v1.signer-prod.testnet` as the vault account with 1 yoctoNEAR, measured
   gas and a result callback. Deploy an account with no access keys; inspect
   on-chain keys and code hash after initialization. Record exact commit/wasm.
3. Fund the derived Sepolia address with test ETH, request a signature from
   the vault, broadcast its transaction, confirm a receipt and link both NEAR
   and Sepolia transaction IDs. Re-run derivation for the same vault/path and
   assert unchanged address. Different vault predecessor must give another key.
4. Inject RPC timeout and failed callback in a local sandbox. Document how the
   registry will hold its transfer lock until a positive settlement observation.
   If configured reporter cannot establish one, T004 remains open.

Do not ask a user to approve code deployment or spending until this is a concrete
testnet contract, target and amount with reviewable transaction data.
