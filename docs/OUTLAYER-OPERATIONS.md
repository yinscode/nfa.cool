# OutLayer Scout: local implementation and live gates

The two-service testnet release passed. See
[testnet evidence](OUTLAYER-TESTNET-EVIDENCE.md) and the current
[Studio runbook](STUDIO-RUNBOOK.md). This checklist describes recovery and replay;
it does not imply that public API hosting is configured.

## Local loop

1. `sh scripts/dev.sh registry` builds the vault first and runs the native
   contract tests. `npm run dev:bundle` runs the full code and web bundle.
2. `cargo test --offline --manifest-path skills/scout-wasi/Cargo.toml` and
   `cargo build --offline --manifest-path skills/scout-wasi/Cargo.toml` check
   the deterministic native Scout. `node skills/scout-wasi/compare-fixture.mjs`
   compares its output commitment with the current JavaScript worker.
3. Install a Rust toolchain with `wasm32-wasip2`, then run
   `cargo build --target wasm32-wasip2 --release --manifest-path skills/scout-wasi/Cargo.toml`.
   Inspect the WASM `outlayer.manifest` custom section. It must contain
   `{"storage_account":"predecessor"}` and the component must import
   `near:storage/api@0.2.0`. Hash the final bytes with SHA-256, publish those
   **same bytes** at an immutable HTTPS URL, and reject a changed hash.
4. Set `NEAR_SANDBOX_BIN_PATH` to the official NEAR sandbox binary. Build the
   isolated mock artifacts with `sh scripts/build-outlayer-sandbox.sh`, then
   run `NFA_SANDBOX_OUTLAYER=1 NFA_SANDBOX_REGISTRY_WASM=output/sandbox-nfa-registry.wasm npm run sandbox:check`.
   Hosted workers cannot execute inside sandbox. This mock receipt path passed,
   followed separately by real hosted testnet execution.

## Testnet sequence

1. On a **disposable** account, verify `create_project`, `get_project`,
   `get_version`, `estimate_execution_cost`, `request_execution`, callback
   JSON and refunds. Record project UUID, two signer IDs, the unchanged
   predecessor vault, storage read after signer rotation, resource metrics,
   fees and receipt IDs. The project response parser in `vault-v2` accepts
   `project_uuid` or `uuid`; check the real return shape before deploying.
   `npm run outlayer:preflight` provides a read-only price/availability probe;
   set `OUTLAYER_PROJECT_ID` and `OUTLAYER_WASM_PATH` to inspect those values.
   If the default RPC endpoint is unreachable, use
   `NEAR_RPC_URL=https://test.rpc.fastnear.com npm run outlayer:preflight`.
2. Pass sandbox and upgrade gates, fund a new vault with at least 6 NEAR,
   and verify `treasury.available` exceeds deposit cap plus operating reserve.
   Measure actual storage usage, runtime gas and any changed network price.
3. From the NFT owner, call `provision_outlayer` with the published URL,
   64-character lowercase WASM SHA-256 and bounded storage deposit. Confirm
   `outlayer_project` and vault `outlayer_status` agree on UUID and version.
4. Estimate the exact requested limits and input bytes at OutLayer. Choose
   `D` at least the quoted worst-case execution deposit; set `B >= D` and
   customer fee `F >= B + 0.01 NEAR`. The customer calls
   `request_reviewed_service_job` with runtime/policy versions and `sha256:` of the exact JSON input. A keeper or
   customer calls `start_service_job` with those bytes. The vault is the
   OutLayer caller and refund recipient.
5. Confirm the output commitment and the on-chain `FINALIZED` job, ledger
   decrease of escrow, `B` transfer into the vault, and `F-B` claimable
   income. Reconcile vault deposit `D`, actual charge `C`, refund `D-C`, and
   gas separately. A job in `UNCERTAIN` stays locked; do not force a refund.
6. Alice lists the NFT; Bob buys it. Verify the same vault, project UUID and
   pinned version, then call owner-authorized `recall_owner_memory` as Bob.
   A signed Alice recall must fail. Scout excerpts and on-chain outputs are
   **public**; never place OAuth tokens or private notes in them.

## Keeper and recovery

`triggerPaidScout` in `services/worker/outlayer-keeper.mjs` accepts a typed
committed input and only triggers `REQUESTED` jobs. It cannot create a project,
change a version, choose a key, or spend the treasury. `inspectOutlayer`
reports low runway, unavailable project and unresolved jobs; a hosted process
may poll it, including OutLayer pause state, callback delay and failure rate.
Set `NFA_KEEPER_JOURNAL_DIR` to a persistent private directory for the keeper.
For a read-only recovery snapshot run
`NEAR_RPC_URL=https://test.rpc.fastnear.com NFA_KEEPER_JOURNAL_DIR=<directory> node scripts/inspect-outlayer-job.mjs nfa-1 3`.
The command checks the journal's service/input hash against the finalized
on-chain job and records `OBSERVED` only after chain progress. A still
`REQUESTED` job needs transaction and deadline inspection; an `UNCERTAIN` job
needs the OutLayer callback/charge inspected. Neither condition authorizes an
automatic second start or customer refund.
Checkpoint compaction is not implemented; pending job records remain keyed by
job ID. No process runs continuously inside the NFT.

| State | Allowed response |
| --- | --- |
| `REQUESTED` past deadline (at most 30 minutes) | Permissionless `expire_unstarted_paid_scout` returns the execution deposit; the margin, net of storage, compensates the agent for the held slot. The owner can `cancel_unstarted_job` earlier with a full refund. |
| Project `UNCERTAIN` | Inspect OutLayer `get_project`/`get_version`, then use `reconcile_outlayer_project`; retain NFT lock until identity matches. |
| Job `UNCERTAIN`, or `EXECUTING` 15 minutes after start | Permissionless `release_service_job`. It succeeds only if the vault confirms its OutLayer callback has returned (or it never began). The quoted execution reserve is reimbursed to the vault and registry storage is charged from the customer fee; only the remainder becomes refund credit. The slot stays locked until reimbursement settles. The job never becomes memory, and the NFA then unlocks. A job is never re-executed. Requires vault code with `release_skill`. |
| Settled job but vault still pending | Permissionless `retry_job_ack` re-sends the vault acknowledgement. |
| NEAR transfer `Uncertain` | Permissionless `reconcile_near_operation` resolves from vault status: never began → Failed; recorded `last_near` outcome → applied. Works with old vaults for the never-began case. |
| EVM request `Uncertain` | Signer timeout: owner or reporter `retry_evm_signature` (same digest). Vault never began: permissionless `recover_evm_operation`. Stuck in the mempool: owner `replace_evm_transfer` (same nonce, fees +10%, or `cancel`). |
| `RECONCILING` with definite failed reimbursement | Permissionless `retry_outlayer_replenishment`; check registry balance first. |
| Recall reimbursement failed | `retry_recall_replenishment`; result remains locked until paid. |
| Recall `UNCERTAIN`, or `EXECUTING` 15 minutes after start | Permissionless `release_recall` once the vault confirms its callback returned; the deposit is credited to the owner who paid. Recall is read-only, so nothing else changes. |
| Definite guest failure, customer fault | Vault reimbursed for compute from the fee; the rest, net of storage, is credited to the customer. The NFA stays Active. |
| Definite guest failure, operator fault | Full fee becomes customer credit; storage is charged to agent income. Owner resumes with `resume_failed_service` only after a callback proves the vault is clear. |
| Low vault runway | Pause new quotes at API/keeper and fund the same vault; project storage identity remains unchanged. |

No automatic timeout resolves a submitted OutLayer execution. Release is explicit
and only proves that no result can still reach the registry. OutLayer may still
have charged the vault deposit or written storage for that job ID. Release therefore
charges the quoted reserve rather than assuming zero compute cost; it is not a
full-refund guarantee. A failed reimbursement retains escrow and can be retried. That storage
is unreachable, because recall and prior-work context require `FINALIZED` jobs.
OutLayer attestation binds an execution to code/input/output. Scout's cited
source claims still require separate evaluation; execution does not prove an
LLM or source is factually correct.
