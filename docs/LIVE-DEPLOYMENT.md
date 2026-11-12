# Current Studio testnet release — 2026-11-12

Registry SHA-256 `99fd106f60d79b4b4fa289fee9c2630b0412fd25ddb849ab04243344c1bb0636`
was deployed to `nfagent-registry-0e9b2a.testnet` in transaction
`HCRLKhogd8DadMV3PVNa83CYEv8h9hr6a8vekS1LPpHk` after exact-byte old-state rehearsal.
The earlier `nfa-1` ownership/vault/manifest state was preserved. New `nfa-2`
passed paid Scout/Compare, sale, buyer edit/recall, version continuity and refund
recovery. See [current evidence](OUTLAYER-TESTNET-EVIDENCE.md),
[Studio status](NFA-STUDIO-STATUS.md) and [runbook](STUDIO-RUNBOOK.md).
Updating registry code does not replace existing vault code; new vaults embed
this release's bytes. Earlier account and recovery history follows below.

---

# NEAR testnet deployment and recovery status (2026-11-11)

## Replacement vault

The v2 vault `96a2220a848bcddf3dfbafe06501691b97106a76a2b2a328fc1eb4d6a3ab6528`
was funded with 3.5 testNEAR (`qi35mBai4v97W6ZbpxLG24CMudZVxzckjqxCWGsm8HL`), deployed
(`FiyWmzs6gFmkxU6zBZrrSFsHG8uqWkE7N3Jv3FTxmngs`), and made two 0.1 NEAR
withdrawals (`CDUeu7D3aUFfG5Tg4G417eSGbZQRJLpzXB2TmEyFu7wp`,
`2R3DXiFsM7Q47E2zM3wEjzg23yy4uAwaybXCaJJNJHo2`). Between them, the guardian
upgraded the vault (`HpnQXfqQ2ZXRsGW84GCNs5TddgkPSpGEqvfewHae7BeH`), its
temporary access key was deleted (`AjjHut2VdjKSiUoatP61aRFrHuYDPFDs1BNibov1joya`),
and the second withdrawal succeeded with zero account keys. The guardian is a
trusted recovery authority and can replace the code. Sepolia repeat signing from
this replacement account has native tests but no live testETH funding or receipt.

## Registry and first agent

Registry `nfagent-registry-0e9b2a.testnet` was created in
`A6P53vvnCt8NSbF7p7a4GWRghkBZvWFQMoN5mjs21p5z` and deployed in
`H6cE1WJBy5y19rnKC1hpNiNEGP4kncYzBbPxsraYPVEM`. Its deployed code hash is
`DV82WjWzwLiGWKmsWGZGf3H9VeBDnf5yYEWxaQovuPw9`. Alice
`nfagent-alice-fe53d8.testnet` was created in
`AEHarAZiFxU7roDbN7kt1SQsD2ztnXwmQ4HhQAPUM6c8`.

Alice's 3.7 testNEAR `create_agent` transaction
`GMad3aXXykpk8oCzVYP1KYpE55fnr5XSmu9J9kvGaRY4` created and initialized
the keyless vault `nfa-1.nfagent-registry-0e9b2a.testnet` with 3.5 testNEAR.
Its controller is the registry; the reporter and guardian are the funded operator
recorded in `deployments/t005-vault-public.json`. The vault status reports no
pending operation. The original mint callback failed because the standards helper
required an attached storage deposit, while the asynchronous callback had zero.
The vault existed without an NFT until the recovery below.

The corrected registry mints with zero callback deposit and provides
`retry_finalize`, which checks the existing vault's controller, reporter,
guardian, pending operation and next operation ID before minting exactly once.
Native tests cover the failure and recovery. Its optimized WASM SHA-256 is
`253e5b15693b624bafc436bd56ab848e561a0368c8e3b9b47a387c71e393af83`.
After explicit user approval, a fresh complete transaction deployed it in
`FS5N89oxpQEQQvyB9GBa6Nrq2Dc85ZbzM5DGQZBpfkqi`; on-chain code hash
`3WPEVTp6CG3tQsrRKc6TujFhY3uwWNdCZPgmhtfqFgs4` matches the WASM.
Earlier partial relay buffers and signed upgrades were not submitted.

Admin recovery in `qxr3RPnaVC1XpEDF1GqfNP8JxpmbfzmncbQC8k7AftJ` returned
`true` and emitted exactly one NEP-171 mint to Alice. Supply became one,
`pending_provision` cleared, and token metadata retained the same vault ID and
deployed vault code hash. Bob's independent implicit account
`3b3960f01e584368c8b317260a484709684b1580bf88da345eabed58df39a18d`
received 1 testNEAR from Alice in
`5ubkZrcoN5h81Z8tB7rPkEmUJo8ujkKLi515hHnpkFVr`.

| Live action | Transaction | Observed result |
| --- | --- | --- |
| Alice transfers NFT to Bob | `Abxh2woHToK1M8V8vXmb4wzHhZCc4CrkfHQ74g72z3j1` | Bob owns `nfa-1`, epoch 1; vault unchanged |
| Alice attempts treasury withdrawal | `CyB9MPxbFmU7X1oQXJqiCCn9PRZWkwpLNKvWjHRijPNF` | Contract call fails; operation ID and vault state unchanged |
| Bob requests 0.1 NEAR from vault | `7oUi4QJu9PyxNfk3jgo7eku2ZD3eK4TX5TimgUPs1QHs` | Operation 1 finalized, Bob received funds, vault op ID advanced |
| Bob approves Alice | `JZgLmBwHvUDjTE19nTvLGmmNkQMpqkiTrZhAh17FiEa` | Approval ID 1 shown in NFT view |
| Alice exercises approval | `DfmqpB4bFgRa8ka9qsavWoezVQBXAjSJm1B773Yy9qAm` | Alice owns NFT, epoch 2, approvals cleared |
| Transfer-call to account without hook | `444s5PHqjYTugdBnANpWDT2WFJSTWJ8BUTuxsJf7VRRG` | Reverted to Alice; epoch stays 2, lifecycle Active |
| Alice returns NFT to Bob | `5YoVENHCKAqxzRvbkzGB71CzereAssmPdKqWvAL995MJ` | Bob owns NFT, epoch 3, supply 1, same vault |

The final vault controller remains the registry, with next operation ID 2 and
no pending work. The guardian can still upgrade vault code independently and
the configured reporter is trusted for foreign-chain settlement. Live accepted
`nft_transfer_call` with a receiver hook and live repeat Sepolia signing remain
untested; the former has native VM tests.

The signer derived a public Sepolia key from the unchanged `nfa-1` vault and
fixed path `eth-sepolia-v1` (domain 0). Its checksummed address is
`0x9E65Be999C4C68d0a58C28C3Bdd8944E3818EA6d` and its public key is in
`deployments/t011-nfa1-sepolia-public.json`. It is a **new address**; the older
T004 one-use address must never receive more funds. The current registry has
no NFT-gated EVM transfer method yet, so do not fund this new address for the
demo until that method and submission/reconciliation path are built and tested.

## Local verification

`sh scripts/check-contracts.sh` passed: seven vault native tests, nine registry
native tests, WASM builds and optimization. `NFA_NPM_OFFLINE=1 npm run ci` passed
the workspace builds, 11 Node tests and generator smoke run. Worker tests cover
RPC timeout, uncertain receipt, sender/chain/nonce checks and positive receipt
reporting. These are native/mocked tests, not a full NEAR sandbox failure run.

Never distribute local `deployments/*.key.json`, `*.signed.json` or raw EVM
transactions. The original T004 vault is permanently one-use; see
`NEAR-SPIKE.md` and do not fund it.
