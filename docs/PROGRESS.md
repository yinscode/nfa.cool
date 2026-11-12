# NFA progress

## Handoff baseline — 2026-11-10

- Generator v2, 56 PNG assets, seven source atlases and 48 examples copied into `./nfa`.
- `README.md` is the entry point; `GENERATOR.md` preserves renderer documentation.
- `PLAN.md` contains T001–T043. Protocol/runtime/SDK/API/marketplace remain unimplemented.
- Generator tests executed successfully from this folder: 4 passed, 0 failed.
- The initial handoff check used a sibling dependency installation. T001–T003
  below supersede it with a clean install and build in this folder.
- The original `../nfa-generator` directory remains a backup. Continue edits here.

## Task updates

For each task, append its ID, status, changed files, validation commands/results,
remaining risks and any architectural decisions. Do not mark a task done solely
because its scaffolding or mocked demonstration exists.

### T001 — complete (2026-11-10)

- `npm ci --offline --no-audit --no-fund --logs-dir=/tmp` installed sharp 0.35.5
  from the pinned `package-lock.json` into `./nfa/node_modules`, with no `NODE_PATH`.
- `npm test`: four tests passed, zero failed. `node generate.cjs --count 4
  --seed t001-clean --out output/t001-clean` rendered four complete examples.
- Node 22.23.0, npm 11.6.1. The complete smoke run is also covered by `npm run ci`.

### T002 — complete (2026-11-10)

- Added `docs/OWNERSHIP.md` with assets/authorities, lifecycle, transfer-call
  resolution, in-flight signatures, callback and old-session attack matrix.
- Required rule: an issued EVM signature keeps sale blocked until positively
  reconciled; NFT transfer alone cannot revoke it. Full adversarial implementation
  tests remain T034, dependent on the real contracts and app.

### T003 — complete (2026-11-10)

- Added `packages/shared` and `packages/sdk` npm workspaces with minimal compiling
  TypeScript exports, pinned TypeScript 5.9.3, a reproducible npm lockfile, Node
  version, environment example, proposed service/contract/UI/template directories,
  and CI workflow plus `scripts/ci.sh`.
- `NFA_NPM_OFFLINE=1 npm run ci`: clean install of 35 package entries, both workspace
  builds, four generator tests and two-character smoke generation all passed.
- Workspaces are scaffolds, not a released SDK or protocol. The CI workflow is
  active only if `nfa/` is a repository root; otherwise call `npm run ci` from
  the parent repository's workflow.

### T004 — in progress (2026-11-10)

- Added `docs/NEAR-SPIKE.md` and the read-only `scripts/probe-near.mjs`.
- Inspected NEP-171, NEAR account/keys docs, MPC source at
  `b5bafa338f6e352edfabd65b86ae0286886bb9b9`, and TLA contracts at
  `d85860a8cc2bfcb8b617b28cab558da5d39333fc`.
- Selected Sepolia and a trusted, explicitly disclosed settlement reporter for
  MVP. `node scripts/probe-near.mjs --dry-run` passes.
- The shell still cannot resolve the RPC, but another network runtime verified
  signer code hash, live config, two distinct derived keys, Sepolia chain ID,
  and the unfunded address/nonce. See `docs/NEAR-SPIKE.md` for exact evidence.
- Added a typed Sepolia vault spike in `contracts/vault/`, an offline transaction
  builder and public funding data. WASM check/build passed; offline NEAR txs
  encode/decode. Native Rust unit tests are blocked by unavailable SDK crates.
  Subsequent live results are recorded below.

### T004 live integration — positive path passed (2026-11-11)

- Funded vault and operator (5 testNEAR each), derived Sepolia address
  (0.5 test ETH). Deployed/initialized vault with NEAR transaction
  `XSzvZkv849EmPnvMwWU5W5Cyu7YWdBEjnyRv1BxiqcT`; on-chain code hash
  `5uxDFHRShhtTgJmvDy5EZN8bBeEFXQDGeUfpD3hEBqN5`.
- Removed the only vault access key in
  `DLoFffrNZA5MiAamaQohLCDUp2exjnF6fAgxQ2G2VxTZ`; finalized key list zero.
  Operator call `GbnEAyzG4LA2vBvVKDzokFWfhbELxf3WdGJ7zW25pLbX`
  triggered MPC from the vault predecessor and succeeded in its callback.
- Verified signer response against the unchanged derived key, broadcast typed
  EIP-1559 transaction
  `0xa4c4ddd3948a1d6dfb443d8193bd0ea13ac6801c5bd1bea0a53fadd659fd7c8a`;
  Sepolia receipt status `0x1`, 21,000 gas and expected value/destination.
- **Incident:** the deployed one-use contract has no upgrade or second-signing
  method. About 0.499978 Sepolia ETH and the vault's testNEAR remain locked
  without a normal recovery route. Do not fund that address again. See
  `docs/NEAR-SPIKE.md` for details and the required next-vault safeguards.
- T004's live capability acceptance is met. The stricter negative-path gate
  (failed callback, RPC timeout and reporter reconciliation in a local sandbox)
  remains open, so keep the checkbox pending until it is verified. CI passed.

### T004–T009 continuation — local implementation and partial live integration (2026-11-11)

- `contracts/vault-v2/`: repeatable NEAR withdrawal, typed EVM signature,
  receipt reconciliation, guardian upgrade and status. Seven native unit tests
  and WASM build pass. A replacement vault passed two live 0.1 NEAR withdrawals,
  the second after its only access key was deleted; an upgrade between withdrawals
  preserved state. See `LIVE-DEPLOYMENT.md`. Repeat Sepolia signing has not been
  exercised with testETH from this vault.
- T005 schemas, fixtures, SDK type reexports and Rust-view API mapper were added;
  T005 is complete. Settlement worker rejects uncertain/mismatched Sepolia
  receipts, including simulated RPC timeout, before reporter confirmation.
- `contracts/registry/` uses vendored NEAR NFT standards v5.30.1. Nine native
  tests cover direct/approved transfer, transfer-call acceptance/rollback,
  pending/listed guards, failed provisioning and exactly-once recovery. The
  corrected optimized WASM and v2 vault build with `scripts/check-contracts.sh`.
- A live registry was deployed and Alice's creation provisioned a funded,
  keyless vault. The old registry mint callback trapped on zero attached deposit;
  supply remains zero. The corrected callback and `retry_finalize` pass native
  tests but are not deployed. Automatic approval review rejected the large
  upgrade relay append due duplicate-chunk risk; no upgrade was broadcast.
  T006–T009 remain open pending live recovery, transfer and authority checks.
- `NFA_NPM_OFFLINE=1 npm run ci` passed workspace build, 11 Node tests and smoke
  generation. The T004 full sandbox failure-injection gate remains open; native
  callback and mocked RPC timeout tests cover narrower cases.

### T006–T009 live recovery and ownership proof (2026-11-11)

- With explicit user approval, freshly signed upgrade
  `FS5N89oxpQEQQvyB9GBa6Nrq2Dc85ZbzM5DGQZBpfkqi` deployed the corrected
  registry. Its on-chain code hash matches the local optimized WASM. The stale
  partial relay buffer was not used.
- Admin `retry_finalize` in `qxr3RPnaVC1XpEDF1GqfNP8JxpmbfzmncbQC8k7AftJ`
  validated the existing keyless vault and emitted exactly one NFT mint to
  Alice. Supply is one, and the reserved provision cleared.
- Alice transferred `nfa-1` to independently funded Bob; Alice's subsequent
  treasury call failed with state unchanged. Bob's 0.1 NEAR withdrawal from the
  unchanged vault finalized as operation 1. Approved transfer back to Alice
  cleared the approval, transfer-call to a receiver lacking a hook rolled back
  without advancing epoch, and Alice returned the NFT to Bob. Final owner Bob,
  epoch 3, lifecycle Active, next operation ID 2, no pending operation.
- T006 and T007 now meet their contract/provisioning acceptance. T008 remains
  open for balance/history presentation; T009 remains open for bounded grant
  invalidation and job pause integration with later runtime tasks. Live accepted
  transfer-call and repeat Sepolia signing remain additional integration checks.
  See `LIVE-DEPLOYMENT.md` for every transaction ID and trust limitations.

### Local development loop (2026-11-11)

- Added `scripts/dev.sh` and `docs/LOCAL-LOOP.md`: focused offline vault,
  registry, worker, API and SDK checks; combined native/Node suite; separate
  WASM bundle checkpoint. Registry checks build its embedded vault WASM first.
- Warm-cache verification: `npm run dev:registry` passed nine native tests in
  about 1.5 seconds; `npm run dev:all` passed seven vault, nine registry and
  11 Node tests plus TypeScript builds in about 8.2 seconds. `dev:bundle`
  passed the release WASM/optimization gate in about 6.6 seconds. Times are
  measurements on this machine and will vary after source changes or cold builds.
- No chain calls or deployments in these commands. Full asynchronous receipt
  scheduling needs a later local sandbox integration runner, and testnet is
  reserved for a batched release candidate.

### Local candidate across T008–T034 (2026-11-11; not deployed)

- Registry candidate adds epoch-bound NEAR/Scout grants, paid Scout jobs and
  unclaimed income, pinned Sepolia wallet derivation, typed EVM operation locks,
  fixed-price listings/buy, seller/customer payout reservation and on-chain
  request recovery. The v2 vault remains embedded. Native success and failure
  tests include previous-owner grants, expiry, withheld signature, duplicate
  buyers, payout failure, job timeout and unchanged derived address.
- Scout v1 deterministically extracts cited claims from supplied source text.
  Local input/work stores persist hashes across worker restarts. The worker
  checks the current epoch and finalizes through an owner-granted account.
  The EVM journal stores raw signed bytes before broadcast; signature assembly
  verifies the historical T004 MPC fixture. The receipt reporter remains trusted.
- SDK prepares typed wallet actions and reads finalized registry/vault state.
  Loopback API exposes templates, manifests, preview, job inputs, passport,
  history, market, signed owner sessions and gated work. Web UI supports Scout
  preview/creation, paid job preparation, grants, income, listing, transfer and
  purchase. Its wallet interface is injectable, not bundled with a provider.
- `npm run dev:bundle`: 7 vault native tests, 23 registry native tests and
  26 Node tests pass, including real Ed25519 verification against a mocked key
  view and stale-session rejection after ownership change. Optimized registry
  WASM is 814,684 bytes, SHA-256
  `236aee7275a81ca574b7e7dfec70be0124a1468353c3462dd99f5fd66e1868a0`.
- These tasks are locally implemented but the full phase exit gates remain
  open: asynchronous sandbox receipts, storage/gas economics, browser wallet,
  event indexing, actual end-to-end testnet purchase and Sepolia reconciliation.
  The earlier deployed registry lacks the new methods. See
  `docs/LOCAL-CANDIDATE.md` for sequence, APIs and limitations.

### Four-gate continuation (2026-11-11; candidate still local)

- Added `scripts/sandbox-check.mjs`, a full-receipt local scenario for mint,
  paid Scout completion, transfer-call rollback, fixed-price sale, old-owner
  and session rejection, failed vault payout, seller proceeds and same-WASM
  upgrade. It has **not run**: the official sandbox binary is unavailable in
  this environment and the requested download was rejected by the workspace's
  automatic sandbox approval policy. Provision retry and upgrading from the
  previously deployed bytecode remain separate gates.
- Added `scripts/economics.mjs` to expose WASM sizes, provisioning constants
  and code storage floor. At an illustrative 10^19 yoctoNEAR per byte, the
  vault's 3.5 NEAR initial balance leaves a 0.61549 NEAR margin after its
  278,451-byte code floor and 0.1 NEAR reserve. Runtime account storage and
  gas costs have **not** been measured by the sandbox.
- Bundled NEAR Wallet Selector/MyNearWallet, served the Vite browser build
  through the API and switched owner sessions to NEP-413 signing verified
  against a current FullAccess key. Preview and wallet modal opened in a
  browser smoke test; real wallet signatures and on-chain two-owner flow have
  **not** run.
- `npm run dev:bundle` passes seven vault native, 23 registry native and 27
  Node tests, plus the browser build. Candidate optimized registry SHA-256
  remains `236aee7275a81ca574b7e7dfec70be0124a1468353c3462dd99f5fd66e1868a0`.
  No v2 upgrade, Scout sale or Sepolia reconciliation was submitted to testnet
  during this continuation because the runtime cannot reach the testnet RPC.

## Six release milestones — 2026-11-12

Added deployable API configuration/readiness, a restart-safe Sepolia reporter worker and canonical transaction encoding, bounded research reference logic, reviewed service packages/OpenAPI/SDK checkout, separate economics and buyer inventory, and demo/submission material. The SDK created local nfa-5/job 2 and resumed without another payment. The expanded sandbox receipt sequence created nfa-6, proved buyer continuation/income and passed 13 checks including restart. Current JavaScript suite has 65 tests. These are local checks; no new testnet spending or deployment occurred. Public hosting and external-wallet acceptance remain blocked on host/RPC access, current EVM live acceptance is open, and research still needs WASI/contract/secret integration. Exact summaries and evidence: [RELEASE-PLAN.md](RELEASE-PLAN.md).
