# NFA independent review — 2026-11-12

Baseline `dbba27f` (code `a4ba743`). Review only: nothing deployed, signed or funded; no keys,
`.env.research` or signed journals were opened. Contracts and WASI guest reviewed line by line.
Off-chain services were reviewed by a second pass, and its key claims were spot-checked.

Re-run locally: `npm test` passes 70/70. Registry native tests pass 42/42. Vault native tests
pass 15/15 (with `--features near-sdk/unit-testing`). The six guest tests pass with the project's
pinned cargo home (`CARGO_HOME=.deps/research-cargo rustup run 1.88.0 cargo test --offline`). My
first attempt used the default cargo home, which is why C2 originally said they did not run.

**Bottom line.** Authority handover is sound: epoch-scoped grants and sessions, listing freezes,
the `nft_transfer_call` guard, exact-byte EVM replay and finalized-only unlock. Nothing found
lets a former owner or a customer steal funds. The real problem is **liveness**. Several paths
put an NFA into a lock that only the guardian's `emergency_upgrade` can clear, and two of them
can be triggered by an arbitrary customer or a delegate. For a product whose thesis is "sell
the agent", a permanently unsellable agent is the worst failure. Fix B1–B3 before submission,
or at least disclose them.

---

## Fix status (same day, uncommitted, not deployed)

B1–B3 are fixed in the working tree. Nothing has been deployed or committed.

| Check | Result |
| --- | --- |
| Registry native tests | 58 (was 42) |
| Vault native tests | 20 (was 15) |
| JS tests | 73 (was 70) |
| `sandbox-check` (OutLayer mock) | Passes |
| `research-sandbox-check` | Passes |
| Upgrade rehearsal from the deployed-era registry and vault | Passes; state and status fields preserved |
| New `scripts/recovery-sandbox-check.mjs` | Passes on the new build. On the **old** build it fails at the first check, because the old code accepts the 1-yocto / 1-instruction job |

### B1 (outlayer.rs)

- Paid jobs require an owner policy, limits that exactly equal it, and `deposit_cap ≥ 0.001 NEAR`.
- New permissionless `release_service_job` and vault `release_skill`. Release ends an
  `UNCERTAIN` job, or an `EXECUTING` job 15 minutes after start, but only when the vault
  confirms its OutLayer callback has returned. The customer is refunded and the job never
  becomes memory. `retry_job_ack` clears a stale vault pending.
- The API now quotes the on-chain policy limits and refuses Scout without an on-chain policy.

### B2

- The vault `send_near`/`request_evm_transfer` now return `false` or `"rejected"` instead of
  panicking, and record `last_near`.
- Permissionless `reconcile_near_operation` resolves from vault status. It also works with old
  vaults for the never-began case. A delegate over-balance request now restores the grant budget.

### B3

- Vault: `resign_evm` re-signs the same digest; `replace_evm` signs at the same nonce and
  retains prior candidates (`evm_candidates`). A receipt for any candidate is accepted.
- Registry:
  - `retry_evm_signature` (owner or reporter);
  - `recover_evm_operation` (permissionless; for a request the vault never began);
  - `replace_evm_transfer` (owner; fees +10% or `cancel`);
  - a multi-hash broadcast index; a landed cancel marks the transfer `Failed`.
- Settler: journals attempt *k* and settles whichever candidate is finalized.

### Before deploying

1. **Upgrade order.** Upgrade the registry first. Then have the guardian upgrade nfa-2's vault:
   release, re-sign and replace need the new vault code.
2. **Registry size.** The optimized registry is 1.41 MB, about 160 KB under the 1.5 MiB
   transaction limit.
3. **Scout policy.** Confirm nfa-2 has an on-chain Scout policy; Scout checkout now requires one.
4. **New ABI.** `mark_evm_broadcast` gained an optional `attempt` argument.

### H1–H3 (fixed later the same day)

**Checks after the H fixes:**

| Check | Result |
| --- | --- |
| Registry native tests | 72 |
| Vault native tests | 20 |
| Guest tests | 6 |
| JS tests | 73 |
| `sandbox-check`, `research-sandbox-check`, upgrade rehearsal | Pass |
| `recovery-sandbox-check` | Covers H1–H3 with real receipts |

- **H1.**
  - Start window (legacy completion window): at most 30 minutes, down from 7 days.
  - An unstarted job that expires returns only the execution deposit. The margin, net of
    storage, goes to the agent, so holding the slot costs the requester.
  - The owner can cancel an unstarted job with a full refund (`cancel_unstarted_job`).
  - An expired legacy job no longer forces the agent into `Draining`.
- **H2.**
  - The guest reports who caused a failure (`fault`). The registry falls back to defaults for
    older guests: Scout/Compare → customer; Research → customer only if the model ran.
  - A customer-caused failure reimburses the vault for compute from the fee and refunds the
    rest net of storage. The agent stays `Active`.
  - An operator-caused failure refunds in full and drains the NFA for owner review.
  - One requester must leave room in the daily Research allowance for one other requester's job.
- **H3.**
  - Job lifecycle events are no longer copied into on-chain audit rows.
  - Audit keeps at most 64 recent rows per token.
  - Each job pays a 0.008 NEAR storage fee (800 bytes; measured 571 completed / 495 expired,
    down from about 1.9 KB unpaid).
  - A liabilities counter blocks payouts that the balance cannot cover.
  - A failed provisioning credits the creator, and that provisioning can no longer be minted
    later.

**Residual:**
- A released job still refunds in full even if OutLayer charged the vault.
- The liabilities counter starts at zero when deployed on the live registry, so earlier credits
  are not counted.
- The legacy worker path can still hold the slot for 30 minutes per job, now at a cost of
  0.008 NEAR to the requester.
- The changed guest source is not yet built, pinned or uploaded. Until it is, the registry's
  fallback rules apply.
- The registry is 1.44 MB, about 133 KB under the 1.5 MiB transaction limit.

### M1–M7 (fixed after H1–H3)

**Checks:**

| Check | Result |
| --- | --- |
| Registry native tests | 78 |
| Vault native tests | 23 |
| Guest tests | 7 |
| JS tests | 80 |
| Main, recovery and research sandbox suites, upgrade rehearsal | Pass |

**M1 — Research memory.**
- Earlier jobs reach the model only as verified source quotations. Free-text claims (and
  anything planted in them) are never forwarded.
- Quotes disclose this memory. `useMemory: false` beside `input` opts a job out; the flag is
  part of the paid commitment.
- The input schema hash is unchanged, so the deployed Research policy still matches.

**M2 — No panics in result callbacks.**
- A reported cost above the reservation is recorded as `UNKNOWN` instead of panicking.
- Ledger arithmetic in callbacks saturates.

**M3 — Receipts and finality.**
- The vault accepts a receipt only for a transaction hash it can rebuild from a signature it
  holds. A cross-language test vector ties the vault's encoding to the settler's.
- The settler requires every provider in `EVM_RPC_URLS` to agree, and the sender's finalized
  nonce to have advanced.
- The inventory flags full-access reporter keys.

**M4 — Upgrade powers.**
- Vault upgrades need a guardian proposal plus either the owner's approval (relayed by the
  registry; valid one day; not while listed) or a public seven-day delay.
- The registry gains a two-day timelocked self-upgrade path and an `authorities` view.
- `scripts/authority-inventory.mjs` lists keys, roles and pending proposals. Read-only run
  against testnet:
  - The registry, reporter and guardian each hold a full-access key.
  - The nfa-2 vault has no keys, but its current code allows an immediate guardian upgrade.

**M5 — Stuck recalls.** Permissionless `release_recall`, confirmed by the vault, refunds the
deposit.

**M6 — Unbound entry points.** `request_paid_scout` and `request_service_job` are gone from the
contract ABI and the SDK. `request_reviewed_service_job` is the only paid entry point.

**M7 — Off-chain fixes.**
- The request body is decoded once (UTF-8 safe).
- A pid-stamped lock reclaims a crashed writer's lock.
- Reporter signing is serialized per account.
- Intents that never landed are retired and re-signed after 48 hours.
- `/studio/owned` reads one identity per token (at most 100).
- Studio page and audit reads are bounded.
- `NFA_TRUST_PROXY=1` keys rate limits on the first forwarded hop.
- Studio recovery actions now offer each new recovery call when it applies.

**Found while fixing:**
- **Gas.** Hashing the embedded vault inside `on_provision` (about 12 TGas for 0.5 MB) exhausted
  that callback's gas once the vault grew. The hash is now computed in `build.rs`.
- **Size.** The registry now embeds the `wasm-opt`ed vault: 350 KB vault, 1.35 MB registry
  (about 226 KB under NEAR's 1.5 MiB transaction limit).
- **Unsafe build profile.** A size-optimized LTO profile was tried and rejected: it emits
  bulk-memory WASM (`memory.copy`) that `wasm-opt` refuses.

**Still to do before deploying:**
1. Delete the registry's full-access key after the first timelocked upgrade.
2. Move the reporter to a FunctionCall key.
3. Build and pin the changed guest.

---

## Blockers

### B1. Any customer can permanently freeze an NFA through a paid job

**Where:** `contracts/registry/src/outlayer.rs:211-242` (request_job), `:278`, `:292-300`;
`contracts/vault-v2/src/lib.rs:190-227`.

**Sequence:**
1. The customer calls `request_service_job` / `request_reviewed_service_job` / `request_paid_scout`
   directly. They set `deposit_cap = replenish = 1 yocto` and/or `limits.max_instructions = 1`.
   The policy enforces only upper bounds (`outlayer.rs:216-217`), and `>0` is the only lower bound
   (`:221`, `valid_limits`). Fee ≈ `MIN_MARGIN` (0.01 NEAR).
2. They call `start_service_job` (permissionless, `:251`). The vault forwards the customer's
   deposit and limits to OutLayer `request_execution` (`vault:203-208`).
3. OutLayer rejects the under-funded request, or the guest traps on the instruction limit. The
   local mock already panics at `deposit<=COST` (`outlayer-mock/src/lib.rs:98`).
4. `on_skill_execution` sets `uncertain=true`, `reported=true` (`vault:215-218`). The registry
   gets `result=None` and marks the job `UNCERTAIN` (`outlayer.rs:297`). The same happens for any
   OutLayer error envelope without `schemaVersion` (`:298-300`).
5. Nothing can clear it:
   - `ack_skill` requires `uncertain:false` (`vault:225`).
   - There is no `reconcile_skill`, and the registry has no job reconcile.
   - `on_outlayer_job` can only be called once by the vault.
   - `resume`/`transferable` need `pending_op == None` (`lib.rs:612,753-756`).

**Result:**
- The vault can never act again.
- The NFT can never be listed or transferred.
- The customer's fee sits in `customer_escrow` forever.
- Total cost to the attacker: about 0.01 NEAR.

`OUTLAYER-OPERATIONS.md:83` ("do not refund or retry") treats this as an operator problem, but
the customer controls the trigger.

**Fix:**
1. The customer must not choose resources. Take `limits` and `deposit` from `ServicePolicy`
   (exact values, not maxima), and require `deposit >= estimate_execution_cost` (vault-side view,
   or an owner-set `min_deposit`).
2. Add `reconcile_skill(id)` to the vault. It should query OutLayer for the request outcome and
   let the registry resolve to FAILED (no memory) or FINALIZED.
3. Never panic in result-ingestion callbacks (see M2).
4. As a last resort, add a long, disclosed time-lock. An owner action after N days moves the job
   to `ABANDONED_UNKNOWN`: excluded from memory, refund per policy, possible late charge recorded.

**Tests:**
- Sandbox with the mock: `deposit_cap=1` → today `pending_op` stays set forever (red); after the
  fix, the request is rejected or recoverable.
- Native test: limits below the policy floor are rejected.
- Native test: an error-envelope callback is recoverable.

### B2. A definite vault rejection is recorded as `Uncertain` forever (NEAR transfers)

**Where:** `lib.rs:313-339`, `vault:79-89`.

**Sequence:**
1. The owner, **or a delegate holding a `NEAR_TRANSFER` grant**, requests an amount greater than
   the vault's unreserved balance (balance − storage − 0.1 NEAR). Alternatively, the vault still
   holds a stale `Pending` because `ack_skill`/`ack_recall` failed after the registry already
   cleared `pending_op` (`outlayer.rs:364,466`). Then any later request panics in `begin()`.
2. The vault panics before doing anything. The registry callback sees `Err(Failed)` and takes
   the `_` branch: `Uncertain` + `Draining`, with `pending_op` kept (`lib.rs:329-333`).
3. There is no reconcile, so the lock is permanent. The test
   `unknown_near_callback_keeps_transfer_locked` codifies this.

A delegate is meant to be a *bounded* authority. Today a delegate can brick the NFA.

**Fix:**
- The vault returns `false` (without `begin`) on precondition failures instead of panicking. The
  existing `b"false"` branch then handles it.
- Add a permissionless `reconcile_near(token,id)` that reads the vault `status`. If
  `next_operation_id <= id`, the op never began → Failed. Otherwise use a recorded per-op outcome
  (add `last_near: (id, ok)` to the vault).

**Tests:**
- Vault native test: an over-balance request returns false and leaves no pending.
- Registry test: a Failed callback, followed by a status proving the op was not begun, recovers
  to Active.
- Sandbox test: a delegate over-balance request.

### B3. EVM has no same-nonce replacement, so a signer timeout or an unmined transaction locks forever

**Where:** `lib.rs:378-392` (signer `Err` → `Uncertain`; reconcile only accepts `Submitted`,
`:429`), `vault:331-353`, `services/worker/evm-settler.mjs:19-27`.

**Two triggers:**
- **MPC timeout.** `sign` hits a yield timeout (routine on testnet). The op becomes `Uncertain`
  with no exit (`failed_signer_callback_locks_transfer_indefinitely` codifies this).
- **Fee below base fee.** The transaction is signed with `max_fee` below the Sepolia base fee
  (anything from 1 wei is accepted, `lib.rs:352-353`). The settler rebroadcasts the same bytes
  forever.

`OWNERSHIP.md` names "finalized same-nonce replacement/cancellation" as the safe exit, but it is
not implemented.

**Constraint:** the signature is public in vault `status().pending`. A cancel must therefore
**consume the nonce**, never just clear state.

**Fix:**
- Add `replace_evm_nonce(token,id,priority_fee,max_fee)` (owner or reporter). The vault signs a
  0-value self-send (or the same transfer with higher fees) at the **same nonce**, and keeps every
  digest/signature for that nonce.
- `report_evm_receipt` accepts a hash only if it equals `keccak(signed_i)` for one of them. This
  also narrows M3.
- For a signer timeout, allow re-signing the identical digest.
- The settler/API should reject `maxFee < 2×baseFee + priority` before requesting.

**Tests:**
- Vault: signer Err → re-sign the same digest → report.
- Vault: replacement B at nonce N → report B, then A is rejected, and the nonce advances once.
- Settler: a mock RPC that never mines A.

## High

### H1. The per-NFA job slot can be held for 7 days at zero net cost

**Where:** `outlayer.rs:211-242`, `:225`, `:389-405`; legacy `lib.rs:505-572`;
`services/api/service-runtime.mjs:115`.

There is one `pending_op` per NFA, and any payer can take it:
- The API quotes a 15-minute deadline, but the contract accepts up to 7 days.
- An `input_hash` with no known preimage means nobody can ever start the job.
- Expiry refunds 100% of the fee (`expire_unstarted_paid_scout`).

While the slot is held, the NFA cannot be listed or sold, the owner cannot act, and other
customers cannot hire it. The attacker repeats at the cost of gas.

Legacy `request_scout_job` makes this worse:
- It works on **any** NFA with no service configuration at all.
- After `abort_scout_job` it sets `Draining` (`lib.rs:564`), so the owner must `resume`.
- The SDK still exposes it (`packages/sdk/src/client.ts:132`).

**Fix:**
- Enforce an on-chain start window of 15–30 minutes, separate from the execution deadline. Even
  better, pass `input_data` in the request itself so there is no "unstarted" state.
- Let the owner cancel an unstarted job early (with a refund).
- Make a small anti-spam fee non-refundable on unstarted expiry.
- Remove `request_scout_job`/`complete_scout_job`/`abort_scout_job` and the policy-free
  `request_paid_scout` from the ABI.
- Longer term, allow concurrent job slots and gate sale on "no pending".

**Tests:**
- Deadline beyond the start window is rejected.
- Owner can cancel an unstarted job and the customer is credited.
- Legacy methods are absent.
- Sandbox: an attacker loop cannot prevent `create_listing`.

### H2. A definite failure refunds 100% of the fee, but compute and inference were consumed

**Where:** `outlayer.rs:302-316`; guest `skills/scout-wasi/src/main.rs:97,212-219`,
`research.rs` (`failed(id,"succeeded",Some(cost))`); `research.rs` (reservations stay consumed).

**Sequence:**
1. The customer submits Scout sources unrelated to the question ("No relevant supported
   findings" → definite failure), or a Research question engineered to fail citation checks.
2. The vault paid OutLayer compute (up to `max_deposit`, ≤0.5 NEAR) and is **not** replenished.
   The operator paid the model, and the daily USD allowance is consumed.
3. The customer gets the whole fee back.
4. Every failure also sets `Draining` (`:305`), so the service is offline until the owner calls
   `resume_failed_service`.

Result: free vault drain and a Research DoS for the day.

**Fix:**
- Make the refund depend on who caused the failure:
  - Customer input (no findings, invalid model citations, customer source unreachable) → refund
    `fee − replenish` and reimburse the vault.
  - Runtime/operator fault → full refund.
- Don't drain on customer-caused failures; check that the vault is clear in the same callback
  chain.
- Add a per-requester daily cap.

**Tests:**
- Ledger test: the vault is reimbursed on a customer-caused failure.
- Lifecycle stays Active.
- A single payer cannot exhaust the Research allowance.

### H3. Registry storage is paid from pooled liabilities, risking insolvency

**Where:** `studio.rs:19-26` (an on-chain audit row for **every** event), job/payout rows,
`lib.rs:683-699` (the withdraw reserve ignores liabilities), `lib.rs:184-208` (failed provision).

**Problem:**
- Each job cycle writes about 1.5–2 KB (≈0.015–0.02 NEAR of staked storage). The registry pays
  for it, but the customer is refunded. Combined with H1 that is roughly 10× leverage for an
  attacker.
- Customer escrow, unclaimed incomes and seller proceeds slowly become under-collateralised. The
  last `withdraw_proceeds` fails, or writes start failing.
- When provisioning fails, the user's 5.8 NEAR refund returns to the registry. It is not credited
  back to the user.

**Fix:**
- Charge a non-refundable storage fee per request (or NEP-145 `storage_deposit`).
- Drop on-chain audit rows, since events are already emitted (or use a capped ring buffer).
- Track total liabilities and require `balance − storage ≥ liabilities` before payouts.
- Credit a failed provision's deposit to `payouts[owner]`.

**Test:** a sandbox property test that the invariant `balance − storage ≥ Σ(escrow + incomes +
payouts + replenishment)` holds after random operation sequences.

## Medium

- **M1. Cross-customer memory and persistent prompt injection.**
  - Where: `registry/src/research.rs` (`research_execution` prior work) → guest `research.rs`
    priorWork loop.
  - Earlier customers' findings, including the free-text `claim`, go into later customers'
    prompts. Only `quote` is checked against current sources.
  - An attacker can plant claim text such as "SYSTEM: …" that rides into the next 3 jobs.
    Information can also leak across customers.
  - Fix: add a customer `useMemory` flag disclosed in the quote; pass only verified quotes, or
    owner-curated memory; require claims to be grounded too.
  - Test: guest test that a prior instruction-like claim is not forwarded verbatim.
- **M2. Panics inside callbacks become B1-class locks.**
  - `research_result` `require!(cost<=reserved)` and `require!(state=="RESERVED")`, plus the
    `checked_sub().unwrap()` ledger updates, all run inside `on_outlayer_job`. The vault has
    already set `reported=true`, so it cannot redeliver.
  - Fix: map these cases to recoverable states.
  - Test: an over-reserve cost puts the job into a recoverable state.
- **M3. Reporter and RPC trust can be narrowed cheaply.**
  - Where: `mark_evm_broadcast` (`lib.rs:396-409`) and `report_evm_receipt` (`vault:342-353`)
    accept any hash; `services/worker/settlement.mjs` uses a single RPC.
  - The risk: a lying reporter or RPC clears the lock while the public signed transaction is
    still broadcastable *after a sale*.
  - Fix:
    - Verify the hash against the signed bytes on-chain.
    - Require a quorum of two RPCs, plus `eth_getTransactionCount(sender,'finalized') > nonce`.
    - Give the reporter a FunctionCall-only key (M01 shows a FullAccess key).
- **M4. Upgrade powers are unconstrained.**
  - There is no on-chain registry upgrade gate: whoever holds the registry full-access key can
    rewrite every rule.
  - Vault `emergency_upgrade` (`vault:355-360`) lets the guardian deploy arbitrary code to every
    vault, which can then sign any transaction from every NFA's Sepolia address.
  - Fix:
    - Add a view or script that inventories authority: keys, guardian, reporter, code hashes.
    - Upgrades should need owner consent (relayed by the registry), or a timelock plus an event.
- **M5. Recall `UNCERTAIN` is permanent.**
  - Where: `vault:251-267`; guest `recall` exits 1 on a storage error (`main.rs:220`).
  - Recall is read-only, so after verification it can safely be treated as a definite failure.
- **M6. Unbound entry points.**
  - `request_service_job` and `request_paid_scout` do not pin runtime or policy, so the owner can
    activate a new version between quote and payment.
  - Only `request_reviewed_service_job` binds the quote. Remove the other two.
- **M7. Off-chain services** (spot-checked):
  - UTF-8 corruption: `server.mjs:35-38` appends Buffer chunks to a string, so a multibyte
    character split across chunks becomes U+FFFD. The paid input hash then covers corrupted text.
    Fix with `Buffer.concat`.
  - Stale journal lock: a crash leaves `.lock`, and settlement stops (`evm-journal.mjs:17-25`).
  - Reporter nonce collisions: concurrent per-token reporter processes share one access key
    (`near-intent.mjs`). Run a single serialized reporter and detect provably-dead intents.
  - RPC amplification: `GET /studio/owned` → up to ~250 tokens × (~16 views + 100 pages) RPC calls
    (`studio.mjs`). Rate limiting keys on `remoteAddress`, so behind a proxy all clients share one
    bucket.

## Low / hardening

- `revoke_delegate` requires Active with no pending op (`lib.rs:276-281`). Owners should be able
  to revoke at any time.
- `on_payout` with an unknown result leaves `pending` forever and blocks that seller's payouts
  (`lib.rs:710`).
- Sandbox wallet bridge: it accepts a static header and has no Host allowlist, so DNS rebinding is
  possible (sandbox funds only) (`server.mjs:125-128`).
- `{sdk,...body}` spread order (`server.mjs:144,175`).
- ENOENT errors leak absolute paths.
- Challenge and session maps are never pruned.
- Journal file names lack a registry namespace.
- Path-prefix matching has no trailing slash, so `/docs` matches `/docs-x`.
- The `run-scout.mjs:30` comment says work "remains private"; Scout inputs are public.

## Claims vs evidence

| ID | Claim | Issue | Fix |
| --- | --- | --- | --- |
| C1 | `SUBMISSION.md` and `EVM-SETTLEMENT-RUNBOOK.md:33-36` say there is no new live Sepolia run | Contradicts M02 (passed) | Update both; agent judges will flag the inconsistency |
| C2 | "Six guest tests pass" | Correct. They need `CARGO_HOME=.deps/research-cargo` and rustup 1.88 (`build-outlayer-wasi.sh`); a plain `cargo test --offline` fails | Document the guest test command |
| C3 | Test counts | CI (`check.yml` → `npm run ci`) runs **no Rust**. The 42/15/6 counts are local only | Add a Rust job |
| C4 | `README`: "S001–S022 … acceptance passed" | Research paid inference and research handover remain open (M06) | Lead with the evidence-level table instead |
| C5 | "Maintain reproducible builds" | Release WASMs embed `/Users/user/...` paths, so hashes are machine-dependent and the local username leaks | Use `--remap-path-prefix` or a `cargo near` reproducible Docker build |
| C6 | `OWNERSHIP.md` attack row "seller retains unbroadcast signature" | The signature is public, so *anyone* can broadcast it | Reword |

---

## Making it easy for agent judges

Agent judges reward claims they can **re-derive in one sandboxed shell, with no secrets, in a
few minutes**. Today a fresh checkout needs:
- Rust and the `wasm32` target
- `wasm-opt`
- a pre-fetched cargo cache (`--offline`)
- `rg` (`install-sandbox.sh:20`)
- an arm64 Mac or Linux
- a README `cd /Users/user/...`

Many agents will stop at the first failure. Suggestions, in priority order:

1. **`npm run judge` — one command, no secrets, under 3 minutes, machine-readable result.**
   - Use the committed prebuilt WASMs (add the sandbox builds to `releases/`) so Rust is optional.
   - Run near-sandbox with the OutLayer mock.
   - Script: create → configure Scout → customer job → list → buy → old owner denied → buyer recall
     → same vault, address and Project UUID.
   - Print `judge-report.json` with `{claim_id, statement, evidence_level, passed, tx_hashes}` and
     exit non-zero on failure.
   - Optionally include a negative test per blocker once fixed (e.g. `deposit_cap=1` cannot freeze).
2. **A Docker path.** Extend the `Dockerfile` with a `judge` stage (Linux near-sandbox plus
   prebuilt WASMs), so `docker build --target judge . && docker run --rm nfa-judge` works on any
   host.
3. **`npm run verify:testnet` — read-only, keyless.**
   - Query the registry views (`agent`, `nft_token`, `outlayer_project`, `derived_wallet`,
     `studio_audit`) and Sepolia `eth_getTransactionCount`/balance for `0xADfC…74c9`.
   - Diff the results against `docs/evidence/*.json`.
   - Agents trust facts they re-derive themselves far more than prose.
4. **Root `AGENTS.md`** (symlink to `CLAUDE.md`) of about 60 lines:
   - what NFA is in 5 lines;
   - exact commands with expected output, run time and ports;
   - "needs no secrets to judge";
   - trusted parties;
   - known limitations;
   - links to the claims ledger.

   With 29 status docs (about 2.5k lines), agents spend their budget reconciling contradictions;
   give them one entry point.
5. **`docs/CLAIMS.json` — a machine-readable claims ledger.** For each claim record: id, text,
   level (unit / sandbox / hosted-testnet / live), evidence file, tx hashes **with explorer URLs**
   (testnet nearblocks, sepolia.etherscan), and a reproduce command. Generate the README test
   counts from it so they cannot drift.
6. **An agent-native surface.** A small stdio MCP server over the SDK, with tools such as
   `nfa_discover_services`, `nfa_quote`, `nfa_prepare_payment`, `nfa_job_status`, `nfa_profile`
   and `nfa_listing`. They return unsigned actions in testnet mode and *execute* with pre-funded
   local accounts in sandbox mode. A judging agent can then actually hire an agent in-session,
   which is the "agent economy" story in action. Also serve `/openapi.json` (already present) and
   `/llms.txt` from the API.
7. **Fix the papercuts:**
   - relative paths in the README and runbook;
   - `grep` instead of `rg`;
   - checksum the sandbox download;
   - an Intel-Mac message or a Docker fallback;
   - document `cargo fetch` or drop `--offline` on the judge path;
   - a text transcript of `release-evidence-walkthrough.mp4` (agents cannot watch video).
8. **A calibrated security section.** List the trusted parties (admin key, guardian, reporter, RPC,
   OutLayer) and the open liveness issues above, with status. Agent judges penalise overclaiming
   more than disclosed limits.
