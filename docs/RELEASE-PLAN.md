# NFA release work — six milestones

Started 2026-11-12. This is the execution checklist for the six approved next
steps. The original T001–T043 acceptance criteria remain authoritative; an
implementation check does not stand in for a hosted or wallet acceptance check.

| Task | Original plan | Deliverable | Status |
| --- | --- | --- | --- |
| R001 | T024, T035–T036 | Stable deployable web/API, durable data, readiness, public origin and external-wallet acceptance | Deferred by user; deployment code retained |
| R002 | T004, T011–T015, T034 | Restart-safe Sepolia submission/reporter worker, holdings and complete transfer acceptance | Live Sepolia/NEAR handover acceptance passed; reporter remains trusted |
| R003 | T016–T020 | Bounded research skill, reviewed retrieval/inference, eligible memory continuity and paid execution | Typed contracts/SDK/API, pinned WASI and local memory/billing acceptance complete; hosted legacy probe passed; real model/transfer acceptance remains |
| R004 | T021–T024, T042 | Versioned service package, validator, REST/OpenAPI and runnable SDK example | Implemented; local create/pay/resume verified |
| R005 | T019, T027, T032, T035 | Revenue/cost/reserve/withdrawable views and buyer inventory | Implemented; browser and receipt checks passed |
| R006 | T037–T038 | Reproducible judge demo, evidence manifest, architecture and submission material | Draft/local replay complete; next recording uses local Studio with live testnets |

## Active scope after deferring public hosting

The user deferred R001 on 2026-11-12. Local Studio remains the development and
demo frontend. This does not defer real NEAR/OutLayer/Sepolia acceptance or turn
mock results into live evidence. A public URL can be added later; R006 can now
produce a live-testnet walkthrough from locally served Studio.

| Milestone | Parent | Concrete completion gate |
| --- | --- | --- |
| M01 — current Sepolia preflight | R002 | Verify actual deployed vault/reporter/key compatibility, pinned address, current owner/epoch, available test balances and RPC finality support. Never fund the historical one-use T004 vault. |
| M02 — cross-chain handover acceptance | R002 | Current owner signs a bounded ETH transfer; pending sale is rejected; exact transaction broadcasts and finalized receipt reconciles; NFT changes owner; same address persists; buyer completes another transfer and seller commands fail. Verify restart/unknown outcomes stay locked. |
| M03 — typed research adapter | R003 | Distinct research schema/service in registry, vault, SDK and API; reviewed owner-configured secret reference and runtime binding; retain Scout/Compare and one Project per NFA. Rehearse compatible contract changes before testnet writes. |
| M04 — research WASI runtime | R003 | Build/pin WASI P2 bytes that retain existing handlers and add allowlisted retrieval and bounded inference. Customer input cannot select credentials, privileged methods or signing keys. Model timeout/failure has an explicit result. |
| M05 — memory and billing acceptance | R003 | Stable vault predecessor storage; only finalized prior work enters context; stale epochs fail; uncertain inference cannot be charged again; model costs, OutLayer reserve, refunds and NFA earnings remain separate. Run locally before hosted acceptance. |
| M06 — hosted paid research and final demo | R003, R006 | Real paid research job in the vault-owned OutLayer Project, buyer recalls eligible work and runs another job using it; same UUID/vault persist and seller authority fails. Record local Studio against real testnets, exact receipts, costs and remaining trust assumptions. |

M03–M05 implementation can proceed while execution-side RPC access for M01–M02
is resolved. A model credential is needed for live inference, not to begin the
contract, SDK, guest and mocked integration work. R004/R005 remain implemented;
extend their existing interfaces rather than start another framework. Hosted
research remains a candidate until M03–M06 pass. Public hosting is not a
prerequisite for this revised demo milestone.

## Acceptance rules

- Public web/API deployment needs an authenticated host and a durable volume or
  private object storage. No temporary tunnel counts as a stable deployment.
- External wallet redirects must be exercised separately from the sandbox wallet.
- EVM acceptance uses real Sepolia transactions and a disclosed trusted reporter.
  Unknown transactions remain locked; raw signed bytes and keys remain private.
- Research inference is an external model call from reviewed code, not proof of
  factual accuracy. Customer instructions never select privileged methods or keys.
- One stable vault owns the OutLayer Project and calls its storage. No human
  signer namespace is treated as transferable agent memory.
- Royalties, x402, Intents/1Click, additional chains and personal OAuth transfer
  remain outside this release.

## Task summaries and evidence

Append each task's implementation, checks, live acceptance and remaining blockers
below. Keep local/mock checks distinct from hosted execution.

### R001 — deployment implementation and blockers

Added a Node container recipe, private build exclusions, exact HTTPS origin,
explicit persistent-volume requirement, bind host, safe public RPC configuration,
liveness/readiness checks, wrong-network rejection and graceful shutdown.
Production RPC credentials are not returned in browser config. Public deployment
requires a selected authenticated host and durable volume. Railway is not logged
in; Fly/Vercel configuration access and the Docker daemon are unavailable in this
execution environment. Direct NEAR/OutLayer/Sepolia network probes timed out.
No container build, public URL, production bucket or external wallet acceptance
is claimed. See PUBLIC-DEPLOYMENT.md.

### R002 — restart-safe settlement implementation

Added `settle-evm.mjs`, a typed mark/report/reconcile worker, fsynced exact NEAR
reporter intents, labeled holdings, pre-broadcast Sepolia checks and canonical
receipt/reorg observation. Fixed canonical EIP-1559 zero parity encoding.
Transfer reconciliation also waits for the RPC finalized head, not only a
confirmation count. The reporter's observation remains a disclosed trust.
Historical MPC fixture assembly, new parity-zero regression, wrong-chain,
reorg, timeout and restart tests pass. No new signature or testnet transaction
was requested in this work. Current live EVM transfer/sale/buyer-repeat acceptance
remains blocked on RPC access and configuration; see EVM-SETTLEMENT-RUNBOOK.md.

### R003 — tested reference candidate; hosted implementation remains

Implemented allowlisted retrieval, one capped inference attempt, typed cited
output, input/runtime/epoch checks, private durable inference reservations and
vault-scoped memory limited to finalized commitments. Three focused tests cover
citations, budgets, stale authority, duplicate charging and buyer continuity.
Usage-priced USD cost is separate from NEAR and is not a provider invoice.
No inference key is configured. The existing OutLayer guest has no HTTP/model
capability, its vault adapter does not pass `secrets_ref`, and research is not in
the contract service allowlists. Porting and testing that integration remains
implementation work, not merely a deployment toggle. The local default toolchain
also lacks WASI P2. Research stays `candidate` and cannot enter current checkout.
See RESEARCH-SERVICE.md; do not mark this milestone complete.

### R004 — SDK/API/package delivery

Added committed schema packages, permission validation, OpenAPI and a typed
NfaServicesClient with exact quote/payment/job binding. The checkpointed
create-and-run example produced local `nfa-5`, finalized job 2 and resumed with
the same IDs without another payment. Completed receipt/assignment verification
is persisted; subsequent runs recheck the on-chain job instead of relying on an
old sandbox transaction cache. Unknown submissions with no hash still require
inspection, never a second payment. See DEVELOPER-QUICKSTART.md.

### R005 — business/account inventory

Added economics and buyer-inventory REST views, Studio balances and public
business history. Separate gross customer receipts, replenishment reserve,
credited earnings, escrow, refunds and currently withdrawable income. Compute,
inference, storage and gas are not fully reconciled, so net profit is unknown.
The browser showed Bob's local `nfa-6` after restart with 0.0448 testNEAR in
receipts, 0.0048 replenishment and 0.04 credited earnings from two jobs.

### R006 — repeatable demo and submission draft

The expanded local receipt sequence passed 13 checks: create/provision/policies,
uncertain-action recovery, paid work, pending sale lock, sale, buyer edit/recall,
old-session denial, buyer's next customer income, economics/inventory and restart.
`docs/evidence/release-demo.json`, a real browser capture, a 42-second labeled
evidence replay and DEMO-SCRIPT.md/SUBMISSION.md are prepared. The replay is not
a continuous live wallet recording. Final public testnet recording and URL await
R001/R002 live acceptance. No submission or message was sent externally.
