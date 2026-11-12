# OutLayer-hosted, transferable NFA — implementation plan

Status: local candidate implemented for project control, deterministic Scout,
paid jobs, escrow, recall and keeper. **Not deployed or validated on OutLayer.**
The WASI P2 component built locally; immutable publication, real sandbox and
hosted testnet gates remain open. See [operations](OUTLAYER-OPERATIONS.md).
For the current execution order and the one-Project/multiple-service extension,
see [completion tasks](OUTLAYER-COMPLETION.md).
The previous Node Scout path remains available separately.

| Task | Local result | Exit gate |
| --- | --- | --- |
| O001 | Contract interface and preflight script | Blocked: disposable OutLayer testnet receipt and two signer storage check |
| O002 | 6 NEAR funding, code-size and old-state tests | Live storage/gas measurement pending |
| O003 | Vault project/version/execution adapter | Live `get_project` schema pending |
| O004 | Registry project record and sale authority tests | Sandbox receipt pending |
| O005 | Deterministic Rust Scout and matching hash fixture | WASI P2 build, immutable publish and hosted storage run pending |
| O006 | Job transitions and local callback tests | Late hosted callback/cancel scenario pending |
| O007 | Separate escrow, replenishment, income and refund ledger | Actual OutLayer charges pending |
| O008 | Staged vault memory, finalized hash gate and buyer recall | Hosted storage transfer proof pending |
| O009 | Native tests only | Official sandbox mock suite pending |
| O010 | Read-only preflight/runbook | End-to-end testnet demonstration pending |
| O011 | Keeper, monitoring and recovery guide | Hosted operations validation pending |

## Product invariant

The NFT transfers control of a durable agent, not an OutLayer project between
human namespaces. Each NFA's keyless NEAR vault owns one OutLayer project:

| Identity | Example | After Alice sells to Bob |
| --- | --- | --- |
| NFT | `nfa-1` | Bob owns it; epoch increases |
| Vault | `nfa-1.<registry>` | Same account, balance and controller |
| Project | `nfa-1.<registry>/scout` | Same project owner, UUID and versions |
| Storage cell | `(project UUID, predecessor vault)` | Same encrypted memory |
| Project signing key | `(project UUID, predecessor vault, path)` | Same identity |
| Owner authority | Registry NFT owner/epoch | Alice loses; Bob obtains it |

OutLayer's `create_project`, `add_version`, `set_active_version` and
`delete_project` are called by the project owner's NEAR account. The vault
therefore needs methods that relay *only typed, registry-authorized* project
operations. Never give a human or a worker a full-access vault key. Do not
transfer the project on NFT sale: OutLayer's transfer requires acceptance plus
a separate owner transaction, and a priced project cannot transfer until it is
unpriced. Store the immutable project UUID alongside its stable account/name;
read and assert both on provisioning and after every upgrade.

Sources: [OutLayer contract API](https://github.com/out-layer/outlayer/blob/main/contract/README.md),
[NEAR integration](https://app.outlayer.ai/docs/near-integration),
[storage account binding](https://app.outlayer.ai/docs/storage),
[project signing keys](https://app.outlayer.ai/docs/signing-keys).

## Execution architecture

1. Publish a pinned `wasm32-wasip2` Scout component with a manifest declaring
   `storage_account: "predecessor"`. If it needs a project signing key, declare
   `bind: "project", caller: "predecessor"`. These choices are essential: a
   signer-bound cell/key would switch from Alice to Bob at sale.
2. The vault creates project `scout` using an immutable HTTPS WASM URL and
   SHA-256 hash. Keep its UUID, active version hash, approved version hashes,
   policy limits, and provisioning state in the registry. Creation uses an
   idempotent request and a callback that checks `get_project`; a failed or
   uncertain callback leaves an inspectable lock rather than recreating under
   the same name blindly.
3. A customer requests a job at the registry and pays an exact quoted fee.
   Store `job_id`, token, owner epoch, input commitments, skill version,
   deadline, resource limits, quote, budget allocation, and payer. Keep the
   customer fee as an escrow liability until terminal settlement.
4. Registry calls `vault.execute_skill(job_id, version_hash, input, limits,
   deposit_cap)`. The vault checks the registry caller, project identity,
   pending operation, its own storage/gas reserve and per-job/daily caps.
5. Vault calls `outlayer.testnet` / `outlayer.near` `request_execution` with
   `Project {project_id, version_key: approved_hash}`, explicit
   `resource_limits`, JSON `input_data`, `response_format: Json`, and an
   attached NEAR deposit no greater than the cap. Leave `payer_account_id`
   unset so unused deposit returns to the vault. A request without
   `resource_limits` is compile-only and must never be sent for a paid job.
6. OutLayer runs the WASM and returns output via its yield/resume path. The
   vault callback validates the matching pending job, bounded output, version
   and result shape. It reports a typed success/failure to the registry callback.
   Only the registry can mark the job final and release customer escrow.
7. During an unresolved request, block sale, transfer, manifest/version
   changes, conflicting vault spending, and owner income claims against that
   job. Use `(token_id, job_id)` for replay protection. A callback with the
   wrong ID or duplicate settlement cannot alter balances or memory.

The worker's result is evidence that a particular WASM version executed under
OutLayer's trust/attestation model; it does **not** prove that outside source
material or an LLM answer is true. Keep source citations and output hashes.

### Memory commit boundary

OutLayer project storage is encrypted and persists across versions, but
`set/get` is isolated by caller. The vault must be the immediate predecessor
of the OutLayer call. Store small, structured agent-owned memory there under
`pending:<job_id>`; return an output commitment to the registry. Only
registry-finalized job IDs become eligible for future memory reads. An
idempotent follow-up run may compact finalized deltas into a checkpoint.
This handles the non-atomic boundary where WASM writes memory but NEAR's
result callback fails. Pending orphan records are never authoritative and can
be garbage-collected after reconciliation. The registry's job status and
artifact hash are the source of truth. Large artifacts live in durable
content-addressed storage, with an on-chain hash and current-owner access
check. Seller-owned personal context and OAuth credentials are excluded from
agent-owned memory; reconnect them after sale.

Do not let a project owner choose an arbitrary URL or version mid-job. Owner
approval updates a manifest with a permission diff, and the registry pins
the version for each execution. A vault upgrade/guardian can still change
the control logic; disclose that trust boundary.

## Payment and accounting

### Initial route: customer buys an outcome; NFA bears execution risk

Use native NEAR for the first vertical slice. The customer's fee remains in
the registry while the vault **fronts** the OutLayer NEAR deposit from a
separate operating balance. OutLayer charges for actual resources and refunds
the unused deposit to the vault, even if execution fails. Read
`estimate_execution_cost(resource_limits, input_len)` before presenting a
quote; set a signed policy cap and recheck price/available balance before
execution. An on-chain estimate-then-execute callback is preferable once the
simple flow works, since pricing can change between UI quote and execution.

Let `F` be the customer's fee, `D` the maximum execution deposit, `C` the
actual OutLayer charge borne by the vault, and `B` the fixed successful-job
allocation to replenish the vault. Require `F >= B + minimum_margin`,
`D <= per_job_cap`, and `vault_available >= D + storage_reserve + gas_reserve`.
Set `B >= D` initially; tune after real receipts. `D-C` returns to the vault.
Track NEAR gas paid by the transaction signer or operator separately; it is
not included in the vault cash-flow equation unless the vault actually pays it.

| Outcome | Registry | Vault | Customer |
| --- | --- | --- | --- |
| Accepted, running | Holds `F` as customer escrow | Fronts `D`, awaits refund | Has a pending job |
| Success | Credits `F-B` as owner-claimable NFA income; reserves `B` for a transfer to vault | Receives `D-C`, then `B` | Receives committed output |
| Definite failure/cancel | Refunds the full `F` from escrow | Receives `D-C` and bears `C` | Receives full refund |
| Unknown callback | Keeps `F` reserved and transfer locked | Reconciles the OutLayer request/refund | Waits for a definitive outcome |

On success the NFA's *combined* economic gain is `F-C`: `F-B` in the registry
plus `B-C` net change at the vault. `B` is an internal allocation, not a
second payment or additional revenue. Current `agent_income` credits the
whole fee and therefore **must change before OutLayer jobs are enabled**.
Distinguish gross job receipts, claimable income, vault reimbursement pending,
actual execution costs, and sale proceeds in views/UI. Current 0.01 NEAR
minimum job fee is not evidence that a hosted Scout job is profitable.

The reimbursement is asynchronous: reserve `B` as a registry liability,
transfer it to the vault with an ID, and release that reserve only after a
definite callback. On failure restore the reserve for retry; on unknown result
lock and reconcile balances/receipt before retrying. Never make `F-B`
claimable before the job is final and the `B` liability is covered. Keep
OutLayer refunds at the vault (`payer_account_id` default); never direct them
to the previous NFT holder. A failed job consumes vault capital, so rate-limit
failed attempts and require the operating minimum before accepting new work.
The owner may replenish from claimable income through a separate typed
registry-to-vault transfer or top up the vault directly.

OutLayer also has stablecoin `attached_usd` for priced projects; that pays the
project owner and requires a separate deposited stablecoin balance. It is **not**
the NEAR execution deposit and is unnecessary when the vault owns and runs
its own Scout project. Defer project pricing and cross-chain customer payment
until native NEAR settlement reconciles.

## Numbered implementation tasks and acceptance

### Phase O1 — pin the OutLayer interface

1. **O001: Contract/API spike.** On a disposable testnet account against the
   real `outlayer.testnet` service,
   create a project, run a tiny WASI P2 component, query `get_project`,
   `estimate_execution_cost`, version hash and callback shape. Record actual
   gas, NEAR charge, refund timing, project UUID and failure behavior. Test a
   contract caller distinct from the transaction signer. Exit: a repeatable
   receipt proves `predecessor` storage is stable across two signers.
2. **O002: Provisioning economics.** Rebuild the larger vault; measure code
   storage, gas, minimum funding, available operating balance and upgrade size.
   Raise `MIN_PROVISION` if necessary. Existing 3.7 NEAR mint funding and
   0.1 NEAR vault reserve are unverified for this new code. Test an upgrade
   from the deployed vault state and do not fund the retired one-use T004 vault.

### Phase O2 — transferable project control

3. **O003: Vault project adapter.** Add registry-only typed methods for
   `create_project`, `add_version`, `set_active_version` and `execute_skill`,
   with bounded code sources, version hashes, deposits and resource limits.
   Disallow project deletion in normal operation. Record callback state and
   expose `outlayer_status()` including project UUID and pending request.
4. **O004: Registry project record.** Bind `token_id` to the vault-owned
   project, UUID, approved version and skill policy. Mint/provision retries
   must be idempotent. During listing, freeze skill upgrades and spending.
   After transfer, invalidate Alice's grants while Bob can approve a version
   without moving the project.

### Phase O3 — paid Scout and memory

5. **O005: Port Scout to WASI P2.** Match existing input/output hash fixtures;
   bound source length, runtime, instructions and stdout. Publish immutable
   WASM URL/hash and test that a mismatched file is rejected. Start with
   deterministic extraction; add NEAR AI inference as a separate version
   and label its model costs and attestation separately.
6. **O006: Job state machine.** Add `REQUESTED -> ESTIMATING -> EXECUTING ->
   RECONCILING -> FINALIZED/FAILED/UNCERTAIN`; block transfer during
   nonterminal states. Handle callback order, duplicate calls, OutLayer pause,
   cancel after permitted timeout, late resolution, and failed refund.
7. **O007: Accounting.** Quote `F`, `B`, `D`; reserve escrow and reimbursement;
   settle successful results into `F-B` income and `B` vault payment; refund
   `F` on failure. Expose P&L and sufficient registry/vault solvency views.
   Reject jobs if the vault cannot afford `D` plus reserves.
8. **O008: Memory/access.** Use vault-predecessor OutLayer storage, stage
   job-keyed updates, and make only finalized memory readable. Add owner-gated
   retrieval and a transferable memory snapshot. Prove Alice's stale session
   fails and Bob reads the same result after sale. Personal secrets remain
   separate and reconnect-required.

### Phase O4 — integration, sale and operations

9. **O009: Full receipt tests.** In a real NEAR sandbox with a deterministic
   OutLayer-compatible mock (the hosted OutLayer workers do not run inside
   the sandbox), test project creation,
   two signers in one storage cell, pricing change, out-of-gas, timeout,
   concurrent jobs, failure refund, reimbursement retry, upgrade and sale.
   Reconcile balance changes against ledger liabilities. Native mocks alone
   do not satisfy this exit gate.
10. **O010: Testnet demonstration.** Use one newly provisioned NFA: customer
    pays Scout; OutLayer executes; show output hash, cost/refund and earnings;
    Alice lists it; Bob buys it; Bob recalls the same memory and controls the
    same project and vault; Alice cannot run owner methods. Record project
    UUID, version hash, transaction IDs, balances and post-sale access checks.
    The new registry must pass its pending sandbox/upgrade gates before this.
11. **O011: Operations.** Add a permissionless job trigger or a hosted keeper
    for scheduled jobs, with idempotent IDs and bounded reimbursement. Monitor
    OutLayer availability, pending requests, vault runway, project versions,
    callback delays, failed-job rate and memory checkpoint lag. Add explicit
    pause/recovery procedures; no agent is continuously running inside the NFT.

## Verified boundaries and optional extensions

1. **Memory follows the stable caller, not automatically the NFT.** OutLayer's
   default `storage_account: "signer"` creates different encrypted cells for
   Alice and Bob. An on-chain vault-to-OutLayer call with
   `storage_account: "predecessor"` uses the unchanged vault's cell. The
   project UUID persists across code versions and even an explicit OutLayer
   project transfer, but the caller part of the storage/key identity still
   matters. Project `@worker` storage is another shared option, provided the
   WASM enforces token/owner access correctly. Test Alice and Bob against the
   *same* memory key in O001 and O009.
2. **Customer input is data, not spending or upgrade authority.** A customer
   can submit a research question or source text. The registry must build
   typed project-management requests from current-owner approvals only, and
   pin the skill hash, input schema, resource limits and fee. The vault
   exposes no arbitrary `function_call`, code URL, WASM version or signing
   payload to job input. A future project-bound signing key may sign a
   domain-separated result receipt, but it must not be an arbitrary payment
   signer. Audit the WASM and upgrade path because the approved WASM can use
   any signing key it declares.
3. **Attestation proves an execution link, not factual truth.** OutLayer's
   attestation binds the WASM, input, output and worker environment. It does
   not establish that the WASM is honest, that a user-supplied source is true,
   or that an external LLM answered correctly. Label Scout outputs as cited
   claims and show provenance separately from execution attestation.
4. **Other features are prioritized integrations, not forbidden features.**
   The paid NEAR/OutLayer job and transferable project are the first release's
   required proof. Add one optional feature only after its independent ledger
   and authority checks pass:

   | Extension | Earliest sensible scope | Separate check |
   | --- | --- | --- |
   | Creator share of paid jobs | Small, immutable or explicitly versioned share of `F-B` with an exact recipient | Never count the share as both NFA income and creator payout; failure refunds precede splits |
   | Resale royalty | Registry's atomic `buy` payout; NEP-199 view/transfer-payout support if using outside marketplaces | Sale proceeds and recurring job income are separate; outside marketplaces may not honor a suggested payout |
   | 1Click/Intents | Customer payment adapter after native NEAR jobs settle | Quote expiry, origin/destination, refund and final credited asset match the exact job; track app fees separately |
   | Third-party connectors | Revocable agent-owned entitlement or seller-provided lease | NFT sale does not transfer a seller's OAuth account; revoke/reconnect and test stale sessions |
   | More chain addresses | A separate Chain Signatures adapter; keep the existing Sepolia path | Chain-specific transaction encoding, fees, nonce/UTXO and finality, then sale lock reconciliation |

   OutLayer secret access conditions can require NFT balance, which may help
   grant the new holder access on sale, but they do not transfer the underlying
   provider account or undo an old holder's copied credential. OutLayer's
   documented `hos_lease` binding ends when that partner account rotates
   ownership; NFA would need its own compatible binding and lifecycle
   integration to obtain the same behavior. These are useful follow-on
   integrations, not automatic NFA transfer semantics.
