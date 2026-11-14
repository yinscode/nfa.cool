# OutLayer HTTPS async feasibility probe

This is a **transport and memory continuity probe**, not a paid Research release.
`scripts/probe-outlayer-async.mjs` sends one `async: true` HTTPS call to the
existing testnet Project and polls by `call_id`. Its input recalls finalized
Scout job 26. It pins the currently active WASM hash, compares the returned
output against the registry's finalized hash, and makes no new NFA job or
on-chain settlement claim. The local journal at
`.data/outlayer-https-async-recall.json` is created before the paid POST; an
unknown submission is never automatically resent.

```sh
node scripts/probe-outlayer-async.mjs preflight  # read-only, no Payment Key required
node scripts/probe-outlayer-async.mjs submit     # spends testnet Payment Key USD balance
node scripts/probe-outlayer-async.mjs poll       # safe to repeat after admission
```

The probe reads the ignored private key package prepared by
`scripts/prepare-vault-payment-key.mjs`, or `OUTLAYER_TESTNET_PAYMENT_KEY`
in `.env.research` or the process environment. Its **owner must be**
`nfa-2.nfagent-registry-0e9b2a.testnet`, and the key should be restricted to
that vault's Project with a per-call spending cap. The script never prints the
key; key restrictions must be checked at issuance because the key string does
not encode them. A personal or operator-owned key is rejected because the Project's
`storage_account: "predecessor"` manifest would select that account's storage
cell rather than the NFA vault's cell. [OutLayer storage rules](https://app.outlayer.ai/docs/storage)
and [Payment Key restrictions](https://app.outlayer.ai/docs/payment-keys).

**Current state:** The operator used the registry's existing FullAccess key to
deploy the exact proposed bytes on testnet before the two-day public delay.
This bypass is recorded in [direct deployment evidence](evidence/payment-key-direct-bypass.json).
The owner-approved vault upgrade succeeded after a journaled 300 Tgas gas
retry. The restricted vault-owned Payment Key is issued and funded with 0.50
testnet USDC.e; its private package remains ignored by Git and mode 0600.
The probe requires the on-chain `READY` setup and positive USD balance. Do not
use a personal key.

## Vault-owned key issuance path

OutLayer's [CLI implementation](https://github.com/out-layer/outlayer-cli/blob/main/src/commands/keys.rs)
documents the transaction sequence. The caller first reads
`get_next_payment_key_nonce(vault)`, generates a 32-byte secret, and prepares
encrypted JSON with string-valued `initial_balance: "0"` and
`max_per_call`, plus `project_ids: ["<vault>/scout"]`. The keystore public-key
request uses the `System/PaymentKey` accessor, vault owner and nonce profile.
The plaintext Payment Key must be written to private durable storage **before**
`store_secrets`; OutLayer cannot reveal it again. The vault, as the actual
caller, then invokes `outlayer.testnet.store_secrets` with that ciphertext.
The CLI uses a 0.1 NEAR storage deposit. The registry should require current
NFT-owner authorization and the vault should forward only this fixed method,
accessor and profile shape with a capped deposit. Because restrictions are
inside ciphertext, the contract cannot itself prove that the key names only
this Project; cap the balance and audit the key configuration separately.
The prepared package restricts use to the NFA vault's Scout Project and
$0.10 per call. The operator holds the plaintext key, so a seller cannot
retain it after sale. This gives the operator spending authority within the
funded key balance; any production paid-job backend must check the current
NFT owner before each call. The probe is an operator-only transport test.

The usable balance is a separate NEP-141 `ft_transfer_call` from a funded
testnet payer to OutLayer with
`msg: {"action":"top_up_payment_key","nonce":<n>,"owner":"<vault>"}`.
OutLayer testnet currently names `usdc.fakes.testnet` (USDC.e, six decimals)
as its payment token, distinct from the Circle USDC used for NFA checkout.
Fund only a small test amount after confirming issuance and the key's
Project restriction and per-call cap. Verify the OutLayer balance before
running the HTTPS probe. Unspent deposits should use OutLayer's
close-and-claim flow; deleting a funded key forfeits its remaining balance.

The journaled testnet rollout was:

```sh
node scripts/bypass-payment-key-delay-testnet.mjs
node scripts/complete-payment-key-upgrade.mjs vault
node scripts/complete-payment-key-upgrade.mjs issue
node scripts/complete-payment-key-upgrade.mjs verify
node scripts/fund-vault-payment-key.mjs
node scripts/probe-outlayer-async.mjs preflight
node scripts/probe-outlayer-async.mjs submit
node scripts/probe-outlayer-async.mjs poll
node scripts/probe-research-http-fix.mjs preflight
node scripts/probe-research-http-fix.mjs submit
node scripts/probe-research-http-fix.mjs poll
```

Funding required at least **$0.50 of `usdc.fakes.testnet`** in the testnet
funder account. A second bounded Ref testnet swap brought the funder balance
to 0.593750 USDC.e, enough for the vault-owned key.
The funding script
refuses to use Circle's separate checkout USDC and caps this transfer at $0.50.
An uncertain issuance or transfer must be inspected and reconciled from its
journal before any repeat.

## Temporary operator-owned HTTPS diagnostic, 2026-11-14

The testnet payer swapped a bounded amount of testnet NEAR through Ref pool 54
for 0.656250 `usdc.fakes.testnet`. A separate operator-owned Payment Key was
issued with a $0.10 per-call cap restricted to the NFA-2 Scout Project, then
funded with 0.50 USDC.e. One HTTPS Scout call was admitted under that key;
its call ID and result are in
[operator HTTPS evidence](evidence/operator-https-diagnostic.json). The call
completed with a valid Scout output and 1,001 micro-USD of compute charged.
No duplicate call was submitted.

This key selects the operator's own `storage_account: "predecessor"` cell and
cannot use the vault-bound Research secret or prior vault memory. It tests
HTTPS transport only and cannot settle a paid NFA Research job. The later
vault-owned key addresses the owner/storage requirement, while M06 acceptance
still requires a real paid job and buyer continuation.

The [live vault-key rollout preflight](evidence/vault-key-rollout-preflight.json)
checks the owner, exact deployed and proposed code hashes, staged guest, secret
rule, prepared key nonce and funding balance. It passed on 2026-11-14. The
registry proposal was bypassed via the existing FullAccess key on testnet.

The repaired HTTPS-aware guest is staged as an **inactive candidate** at
WASM hash `f959f859af13e783e35df24c857b8e4a54739f7a6525248cffd4c2fe1d5b26b9`.
The new `research-v6` secret profile is bound to that exact hash, the Scout
Project and the vault's Payment Key owner. The currently active hash remains
`578af9bf7adb3a8d40b749ece673b8a8f25d777f7ed2c881a294628f4e3a7dfe`.
The [staging evidence](evidence/research-http-fix-staged.json) records the live
candidate and access rule. The first paid diagnostic on the previous candidate
failed when `wasi-http-client` sent an HTTP request body exceeding WASI's
4,096-byte single-write limit. The repaired client writes bounded chunks.
The vault-owned HTTPS recall of finalized Scout job 26 succeeded and matched
the on-chain output hash. A fresh Research diagnostic on the repaired candidate
completed with successful near-ai inference and priced usage, but the model's
report failed the guest's output checks ([diagnostic evidence](evidence/vault-https-diagnostics.json)).
Neither diagnostic asserts NFA job settlement.

For a model-backed paid service, more work remains after transport succeeds:

1. Obtain a validated Research report from a real near-ai call. The repaired
   guest reached the model and recorded usage, but rejected its report. The
   guest checks `NEAR_SENDER_ID` only in HTTPS mode and keeps
   `NEAR_PREDECESSOR_ID` for on-chain mode. [OutLayer environment reference](https://skills.outlayer.ai/building-outlayer-apps/references/wasi-env-vars.md).
2. Add a distinct on-chain paid async job state. The existing `start_service_job`
   starts a NEAR `request_execution` immediately, so using it as an HTTPS
   reservation would double-dispatch work.
3. Authenticate a delayed result against the job ID, input commitment, owner
   epoch, pinned build and output hash before moving escrow or finalizing
   memory. The HTTPS attestation URL is useful evidence, but the current
   registry does not verify it or accept HTTPS results. A separate signed
   result protocol or explicitly trusted reporter is needed.
4. Reconcile OutLayer's USD compute charge separately from NFA's NEAR escrow
   and the model provider's usage charge. Polling removes the NEAR yield
   deadline from this route, but does not guarantee OutLayer worker availability.

[OutLayer HTTPS async API](https://app.outlayer.ai/docs/https-api) documents
`call_id`, polling and payment semantics. Live Research acceptance remains
open until the full sale, buyer continuation and seller rejection sequence
finishes with real model usage.
