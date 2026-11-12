# OutLayer completion plan — one NFA, one Project, multiple services

Status: **C001–C017 completed on testnet**, 2026-11-12. Current evidence is in
[OUTLAYER-TESTNET-EVIDENCE.md](OUTLAYER-TESTNET-EVIDENCE.md), with per-area results
in [OUTLAYER-STATUS.md](OUTLAYER-STATUS.md). C018 remains a separate optional
product. The numbered acceptance criteria below are preserved as the replay
checklist. An OutLayer guest executes on demand rather than running continuously.

## Target and release boundary

One NFT controls one stable, keyless NEAR vault. The vault owns one OutLayer
Project and is the predecessor of its executions. One pinned WASI P2 runtime
dispatches reviewed service handlers. The registry owns the service catalog,
job state, native NEAR escrow and transfer lock. The API prepares quotes and
typed calls; a customer wallet or limited keeper signs transactions. The
first complete release offers **Scout** and one other small deterministic
service, **Compare** (rank supplied options against supplied criteria with
traceable citations). Both use public supplied text and native NEAR fees.

| Boundary | Current code | Required completion |
| --- | --- | --- |
| Project | Vault/registry hold one `/scout` Project record | Verify live OutLayer response and stable UUID; preserve `/scout` name for existing Projects |
| Runtime | Scout WASI source and native hash fixture | WASI P2 build, publish exact bytes, hosted run; later one router build with Scout + Compare |
| Memory | `pending:<jobId>` in guest; finalized hash before recall | Hosted two-signer read after sale, version-upgrade read, orphan handling and public/private boundary |
| Payment | Native NEAR `F`, `D`, `B` ledger and refund callbacks | Hosted cost/refund measurements, service-specific enforceable margins and solvency checks |
| API | Scout quote, unsigned payment/start actions and status | Quote expiry, availability, both services, recovery/idempotent job lookup |
| Tests | Native Rust/Node pass; old Node Scout sandbox script exists | OutLayer-compatible full receipt sandbox and real hosted testnet demo |

Local progress and current blockers are tracked in
[OUTLAYER-STATUS.md](OUTLAYER-STATUS.md). The current `sandbox-check.mjs` supports both the older Node lane and the
OutLayer-mock receipt gate. Both hosted services have also passed real testnet.

## Phase 1 — prove the host interface before a contract deployment

1. **C001 — Build the component.** Install/pin the Rust WASI P2 target; build
   `skills/scout-wasi` in release mode. Inspect the `outlayer.manifest` custom
   section for `storage_account: "predecessor"` and the imported storage WIT.
   Run the native fixture and a WASI-host smoke test; record SHA-256 and byte
   size. **Pass:** the exact final WASM bytes reproduce the native fixture,
   reject malformed operations and are below OutLayer/contract size limits.
2. **C002 — Disposable hosted probe.** On a disposable funded testnet vault-like
   contract, create one Project, query it and its version, run a tiny storage
   write and recall with two different human signers, and record the
   predecessor, UUID, callbacks, output, deposit, charge and refund. Query
   `estimate_execution_cost` with the real limits and input length. **Pass:**
   both signers use the same vault cell; the project/version/callback schemas
   and refund recipient are documented with transaction IDs. A direct human
   execution is a negative control, not evidence of transferability.
3. **C003 — Align the adapter.** Compare the observed `create_project`,
   `get_project`, `add_version`, `set_active_version` and `request_execution`
   formats against `vault-v2` and the registry. Fix mismatches, including
   unknown callbacks and read-after-write reconciliation. **Pass:** the
   vault will never create a second Project after an ambiguous create, accept
   an unexpected UUID, or silently mark a missing version ready.

## Phase 2 — finish the single-service paid lane locally

4. **C004 — Upgrade and funding rehearsal.** Build optimized vault/registry
   WASM, measure code storage and gas, rehearse upgrade from the deployed
   state on a local snapshot or sandbox, and size the new vault's storage,
   gas and OutLayer reserves. **Pass:** old NFT/vault/owner data survives the
   upgrade; mint and deposit constants cover measured worst cases. Never fund
   the retired one-use T004 vault.
5. **C005 — Real receipt sandbox.** Extend `sandbox-check.mjs` with a deployed
   OutLayer-compatible mock contract and actual cross-contract receipts, not
   only native mocked callbacks. Cover project create/verify, paid request,
   start, success, definite guest failure, expired unstarted job, failed
   reimbursement retry, ambiguous callback lock, late callback and sale.
   **Pass:** registry/vault balances and all escrow liabilities reconcile
   after each scenario; duplicate and stale callbacks cannot settle twice.
   Sandbox tests contract choreography, not hosted storage encryption or TEE.
6. **C006 — Enforce public pricing and capacity.** Pin per-service minimum
   margin, maximum deposit and resource limits in the registry; validate API
   quotes against them. Check vault runway and global pending lock before
   advertising availability. Record `F` (customer NEAR fee), `D` (vault
   deposit), `C` (actual OutLayer cost), and `B` (vault replenishment) as
   separate amounts. **Pass:** direct callers cannot bypass the published
   service floor; successful income is `F-B` only after `B` is covered;
   failures and unknown outcomes preserve solvency and explicit liabilities.
7. **C007 — Make the first service boundary explicit.** Keep the Scout input
   schema and raw-byte hash identical in API, registry, keeper and guest;
   registry inserts the allocated job ID after payment. Restrict this release
   to public supplied text. **Pass:** no customer field can select a project
   method, WASM URL, signer, version, secret or treasury action; quotes do not
   race operation IDs. Document that NEAR transaction arguments and recall
   summaries are public despite encrypted stored memory.

## Phase 3 — hosted Scout, transfer and memory

8. **C008 — Publish and stage.** Publish immutable WASM bytes at HTTPS, verify
   downloaded SHA-256, deploy a staging registry and a newly funded NFA vault,
   provision its one Project, and compare registry/vault/OutLayer UUID and
   version views. **Pass:** one Project exists for that NFA, its caller is the
   stable vault, and every pinned version resolves to the published bytes.
9. **C009 — Run a paid Scout job.** Quote the real limits, pay the registry,
   start the exact committed input, and observe the OutLayer callback through
   `FINALIZED`. Capture transaction IDs, attestation, input/output hashes,
   actual charge/refund, vault balances, ledger liabilities and income.
   Repeat with a definite guest failure; do not infer success from a
   submitted transaction alone. **Pass:** accounting matches observed funds,
   the output is traceable to the pinned guest and a failed job refunds `F`.
10. **C010 — Prove sale continuity.** Alice runs Scout, then sells or transfers
   the NFT to Bob. Bob recalls the same finalized memory using the unchanged
   Project UUID/vault; Alice's owner method and old session fail. Re-run after
   activating a new pinned WASM version to prove storage continuity across
   upgrades. **Pass:** the memory hash matches the finalized job; an orphan
   pending record cannot be recalled as final. Seller-held copies remain
   possible and must not be described as revoked.

## Phase 4 — one Project, multiple reviewed services

11. **C011 — Define the service record.** Add `(token, serviceId)` policy with
    schema/version hash, enabled state, input/output caps, fee floor, limits,
    memory namespace and permitted operations. Keep one Project UUID and one
    vault. Jobs pin service ID, policy version and runtime hash. **Pass:**
    enabling/disabling a service or changing its policy cannot rewrite an
    outstanding job; NFT sale retains the catalog but revokes old owner grants.
12. **C012 — Build the runtime router.** Replace Scout-only dispatch with an
    allowlisted `serviceId + action` router in one WASI P2 binary. Preserve
    reads of existing `pending:<jobId>` data. Add Compare as a separate typed
    handler with bounded input, deterministic fixture and `services/compare/`
    memory keys; keep `core/` memory for explicit shared state. **Pass:**
    Scout and Compare run under the same Project UUID and version, with
    independently testable results and no dynamic customer-selected code.
    Prefixes organize data; they are not security isolation inside one WASM.
13. **C013 — Generalize registry/vault and API.** Add typed generic
    `request_service_job`/`start_service_job` while preserving old Scout job
    reads and state keys. The vault accepts only the registry's approved
    project/version; the API lists callable services and exposes generic
    `/services/:serviceId/quotes` and `/jobs/:jobId` routes. **Pass:** an old
    Scout job still recalls, while an unknown service or disabled version
    fails at API, registry and guest boundaries. Return the assigned job ID
    from confirmed chain state, never a guessed counter.
14. **C014 — Prove a two-service release.** Run full sandbox receipt tests for
    both handlers, failed jobs, version changes, pending transfer locks and
    owner handoff. Upgrade the *same* staging Project to the router build,
    execute one Scout and one Compare job, and recall pre-upgrade Scout memory.
    **Pass:** the Project UUID does not change and ledgers reconcile per
    service and in aggregate.

## Phase 5 — operations and release gate

15. **C015 — Make recovery observable.** Persist keeper intent and submitted
    transaction IDs; make start idempotent. Expose job/project `UNCERTAIN`,
    vault runway, callback delay, failed reimbursement, OutLayer pause and
    quote freshness. Add explicit inspection/retry procedures; never turn a
    timeout into a fabricated failure or refund. **Pass:** a restarted keeper
    can reconcile every nonterminal job without double spending or lost funds.
16. **C016 — Durable artifacts and access.** Replace local-only work storage
    with durable, content-addressed storage, verify hashes on every read, and
    recheck current NFT owner and epoch for owner-only artifacts. Keep public
    receipts separate from sensitive content. **Pass:** API restart does not
    lose finalized work; Alice's old access fails after sale. Public on-chain
    inputs/outputs are still public; true private research is a separate
    encrypted-ingress design, not a flag on this release.
17. **C017 — Release evidence.** Run all local checks plus sandbox and hosted
    two-service demo, record exact build hashes, Project UUID, transactions,
    measured costs, callback status, memory continuity, old-owner rejection,
    limitations and recovery paths. Upgrade the live registry only after the
    new code passes the old-state rehearsal and the release artifact is
    reviewable. **Pass:** another developer can reproduce the testnet demo
    from the runbook with funded disposable accounts and independently inspect
    the resulting NEAR/OutLayer records.

## Phase 6 — separate payment adapters after the core gate

18. **C018 — Optional x402 checkout.** Use the x402 NEAR `exact` NEP-141
    transfer as an HTTP payment adapter, with a durable payment-to-job mapping
    and a native NEAR reserve to fund `request_service_job`. Keep token
    receipts, native escrow, relayer funding, NFA income and token refunds in
    separate ledgers. **Pass:** exactly one job per settled payment; failed
    native submission and ambiguous settlement are reconciled; a definite
    service failure refunds the original x402 payer in the original asset.
    No x402 or other-chain requirement blocks C017.

## Critical path and scope rules

`C001–C003 → C004–C007 → C008–C010 → C011–C014 → C015–C017`.
Native Scout alone is the first hosted milestone; C014 is the requested
one-Project/multiple-service proof. C018 follows independently. The remaining
O001–O011 items in [OUTLAYER-PLAN.md](OUTLAYER-PLAN.md) are covered by these
tasks; that document remains the design and economic rationale.

For the first two-service release, do not add creator royalties, Intents,
additional chain addresses, personal OAuth transfer, unreviewed third-party
WASM, arbitrary project signing, or claims that attestation proves research
accuracy. These require their own policy, billing, isolation and access work.

References: [OutLayer Projects](https://app.outlayer.ai/docs/projects),
[NEAR execution and pricing](https://app.outlayer.ai/docs/near-integration),
[predecessor storage binding](https://app.outlayer.ai/docs/storage), and
[NFA REST services](SERVICES-API.md).
