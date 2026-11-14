# NFA.cool — implementation plan for Sol

Prepared: 2026-11-10. Updated: 2026-11-12. The original acceptance gates below
remain intact. The newer Studio/OutLayer work and six approved release milestones
are mapped in [docs/ORIGINAL-PLAN-STATUS.md](docs/ORIGINAL-PLAN-STATUS.md) and
[docs/RELEASE-PLAN.md](docs/RELEASE-PLAN.md). Do not interpret historical unchecked
boxes as missing implementations, or implementations as completed live acceptance.

The remaining OutLayer delivery work, including the one-Project/two-service
release gate, is sequenced in [docs/OUTLAYER-COMPLETION.md](docs/OUTLAYER-COMPLETION.md).

## Goal and demonstration

**Create an agent. Give it a job and a treasury. Buy the whole agent, with its
accounts, work history and eligible access rights intact.**

Build three layers: developer foundation (SDK + REST API), template-based creation,
and trading. Demonstrate one useful agent first; explain the reusable infrastructure
after the ownership transfer works.

Alice creates Scout, funds its NEAR account and pays it for a research job. Scout
produces a result and records income, memory and workspace membership. It also has
a funded EVM testnet address controlled through Chain Signatures. Bob buys Scout.
The same accounts, balances, character and agent-owned work remain; Alice's new
commands and old sessions fail. Bob opens the gated workspace and runs the next
job. Show a blocked sale during a pending payout, then sale after settlement.

This is an NFT-controlled software treasury, not legal incorporation. An NFT sale
does not automatically transfer third-party accounts, nontransferable credentials,
subscriptions or copies of data already downloaded by the seller.

## Existing baseline and target layout

Preserve the root generator CLI and source artwork. Do not redraw or regenerate
the collection as a setup task. Introduce a package split only when useful.

| Path | State / responsibility |
| --- | --- |
| `generate.cjs`, `assets/`, `source-atlases/` | Existing v2 artwork pipeline |
| `GENERATOR.md`, `test.cjs`, `output/v2-*` | Existing docs, tests and 48 examples |
| `contracts/registry/` | Planned NFT identity, authority, transfer guards and sales |
| `contracts/vault/` | Planned per-NFA account, treasury and typed execution |
| `packages/shared/`, `packages/sdk/` | Planned schemas and TypeScript SDK |
| `services/api/` | Planned REST, authentication, indexing and artifact delivery |
| `services/worker/` | Planned constrained jobs and settlement monitoring |
| `apps/web/`, `templates/` | Planned product UI and versioned agent templates |
| `docs/`, `deployments/`, `scripts/` | Planned decisions, evidence and reproducible demo |

Default stack: Rust contracts, TypeScript services/SDK, React UI and SQLite for a
single-process demo. Pin actual dependency versions in T003; don't add infrastructure
without a concrete need.

## Architecture decisions to validate

These are proposed application decisions, not implemented guarantees.

1. **Permanent identity:** `(registry_account_id, token_id)`, with non-recycled IDs.
   Registry state contains owner, owner epoch, vault ID, policy, manifest hashes,
   lifecycle and outstanding operation IDs.
2. **Real NEAR account:** create a sub-account running the vault contract for each
   NFA. Bind it once to the registry. Neither holder nor worker gets a full-access
   vault key. All privileged actions go through the registry.
3. **Single authority:** the registry verifies ownership/delegation and records an
   operation before dispatch. Vault commands require the registry as immediate
   predecessor and a non-replayed operation ID. Never authorize this call solely
   from the transaction signer. Avoid a second independently writable owner field.
4. **Guard every transfer:** block ownership changes while authority-bearing work
   is outstanding. Increment owner epoch and invalidate approvals/delegates on
   transfer. Apply the same rules to approved transfers and transfer-call resolution.
   Callback bookkeeping cannot create new authority for the former owner.
5. **Stable foreign wallet:** the vault calls MPC itself; its account ID and a
   canonical per-chain path remain fixed through transfers. Persist the signing
   domain/key configuration. Never derive from the human owner's account.
6. **Issued signatures remain dangerous:** NFT transfer cannot revoke a valid
   foreign-chain signature. Record requests before dispatch; require sufficiently
   confirmed execution or nonce cancellation before transfer. A timer, missing
   mempool transaction, callback failure or RPC timeout does not prove safety.
7. **Small signing scope:** one EVM testnet, native-token transfers and one pending
   foreign operation per NFA. No arbitrary calldata, approvals, permits, raw hashes
   or generic messages. Contract code constructs the exact typed transaction hash.
8. **Explicit foreign-state trust:** Chain Signatures alone does not prove EVM
   balances/nonces/receipts to NEAR. MVP may use a configured trusted settlement
   reporter, clearly disclosed. Investigate current verifiable reads in T004;
   repository feature availability does not prove deployed support. Fail closed
   when settlement is uncertain.
9. **Agent data:** public metadata stores versioned manifest hashes/URIs. Cosmetic
   traits are distinct from verified skills/credentials. Private memory and secrets
   never enter public NFT metadata. Prior plaintext copies cannot be revoked.
10. **Access rights:** demonstrate an app-owned entitlement checked against current
    NFT ownership. Mark third-party connectors transferable, reconnect-required or
    nontransferable. Never silently transfer personal OAuth tokens.
11. **Upgrade trust:** inventory deployer keys, upgrades and recovery routes. An
    operator able to replace code or attest settlement remains a trust assumption.
    Do not introduce owner-controlled upgrades that bypass guards or remove keys
    without a tested deployment/recovery design.

## Phase 0 — establish interfaces and transfer risks

Dependencies: artwork baseline. Exit: documented decisions and a live integration
path before substantial frontend work.

- [x] **T001 — Verify the baseline.** Run tests and a seeded batch from `./nfa`.
  Record runtime/results in `docs/PROGRESS.md`. Acceptance: clean dependency install
  and commands work without the old directory or another project's node_modules.
- [x] **T002 — Write the ownership threat model.** Create `docs/OWNERSHIP.md` covering
  retained keys, queued actions, signatures, allowances, callbacks, sessions, data
  and upgrades. Acceptance: every authority route has a prevention rule and test;
  architectural deviations are recorded explicitly.
- [x] **T003 — Bootstrap the workspace.** Add planned packages, exact dependency
  pins/lockfiles, example environment configuration and CI. Acceptance: clean
  installation/build and existing generator tests pass without secrets or absolute
  machine-specific dependency paths.
- [ ] **T004 — Spike current NEAR capabilities.** Verify NFT/account creation APIs,
  deployed MPC ABI/domain/gas/deposit and one EVM testnet. Inspect track-linked
  account-NFT contracts for reuse and licensing. Demonstrate vault-originated
  address derivation and signing; record versions, IDs and evidence. Acceptance:
  choose and document the foreign-settlement trust model; mocks alone don't pass.
  Live signing and Sepolia receipt passed 2026-11-11. The extra failed-callback,
  RPC-timeout and reporter-reconciliation gate in `docs/NEAR-SPIKE.md` has native
  and mocked coverage; a full local sandbox failure test remains open.
  The one-use test vault stranded test funds; never fund it again.

## Phase 1 — NFT identity, treasury and guarded control

Dependencies: T002–T004. Exit: Alice creates/funds/transfers an NFA; Bob controls the
unchanged vault and Alice cannot issue new commands.

- [x] **T005 — Define schemas/events.** Specify identity, lifecycle, epoch, vault,
  capability policy, operation record, manifests and revenues. Distinguish requested,
  submitted, finalized and failed. Acceptance: contracts/SDK/API fixtures agree.
- [x] **T006 — Implement registry NFT behavior.** Reuse maintained NEP-171 components;
  implement required transfer-call behavior, metadata, approvals and events. Route
  all ownership-changing paths/resolvers through the guard. Acceptance: standard
  interactions, approvals and guarded transfer tests pass.
  Native tests pass; live direct/approved transfer and transfer-call rollback pass.
- [x] **T007 — Provision vaults.** Fund/create/deploy/initialize each account without
  holder access keys. Mint only after confirmed successful initialization. Handle
  duplicate requests, storage/gas budgets and partial account creation idempotently.
  Acceptance: injected failures create no unbacked NFT or duplicate identity.
  Before deleting deployer keys, test repeatable withdrawals and recovery for
  an unexpectedly large deposit; T004's one-use vault stranded test funds.
  The first live keyless vault was provisioned; a callback failure left no NFT.
  The upgraded registry recovered it with exactly one mint to the original owner.
- [ ] **T008 — Implement NEAR treasury operations.** Deposits, balance/history,
  typed withdrawals and storage/gas reserves. Reserve before async dispatch; consume
  or restore once through authenticated callbacks. Acceptance: concurrent spending
  cannot overspend and failures cannot double-refund.
  Replacement vault passed two live NEAR withdrawals and native callback tests;
  a transferred NFT's owner also completed a live vault withdrawal. Balance and
  history presentation remains to be built.
- [ ] **T009 — Implement authority and lifecycle guards.** ACTIVE, DRAINING, LISTED
  and TRANSFER_CALL_PENDING states. Record work before promises; block transfer
  until reconciliation. Increment epoch, invalidate grants and pause jobs on transfer.
  For `nft_transfer_call`, suspend authority for both interim owner and sender;
  increment epoch only on final acceptance and restore original approvals on
  rollback as required by NEP-171. Acceptance: direct/approved transfers,
  transfer-call rollback and races pass.
  Live direct and approved transfers, rejected old-owner command and rollback
  pass. Bounded grants and runtime job pause must be integrated when built.
- [ ] **T010 — Add bounded delegation.** Per-NFT/epoch method, recipient, budget and
  expiry constraints; reserve concurrent budgets. Workers get no arbitrary vault
  keys. Acceptance: expired/revoked/previous-owner grants and queued stale dispatches
  are rejected on-chain.

## Phase 2 — stable cross-chain assets

Dependencies: Phase 1 and T004. Exit: the EVM address survives transfer; withheld
signatures cannot bypass the sale barrier.

- [ ] **T011 — Persist derived addresses.** Use vault identity, canonical chain path
  and pinned signing configuration; prevent changes after activation. Acceptance:
  two NFAs have distinct addresses and transfer preserves the original address.
- [ ] **T012 — Implement typed signing.** Validate recipient, amount, chain ID,
  nonce and fee bounds in the contract path, construct payload internally and call
  MPC from the vault. Support repeated bounded transfers with durable nonce
  advancement only after authenticated settlement. Acceptance: digest substitution
  and altered approved fields fail; no raw arbitrary signing endpoint exists;
  a second withdrawal can spend an unexpected excess balance.
- [ ] **T013 — Implement durable submission and reconciliation.** Persist operation
  IDs, nonce reservations, signatures, broadcasts, receipts and confirmations.
  Authenticate the chosen reporter and disclose its trust. Acceptance: retries,
  crashes and duplicate callbacks cannot lose pending authority or double-send.
- [ ] **T014 — Drain or cancel before transfer.** Stop new signing; confirm issued
  transactions or same-nonce replacements under the selected finality rule. Keep
  ambiguous outcomes blocked with a recovery explanation. Acceptance: a seller's
  withheld signature cannot spend after an allowed sale; no timeout force-unlock.
- [ ] **T015 — Display actual holdings.** Show the funded foreign address, observed
  block/freshness and reserved outgoing value. Acceptance: funds/address persist
  across transfer; stale observations are labeled and never imply finality.

## Phase 3 — useful jobs, memory and access

The optional OutLayer-hosted continuation, including vault-owned project
identity and paid execution accounting, is specified in
[`docs/OUTLAYER-PLAN.md`](docs/OUTLAYER-PLAN.md). Its O001–O011 tasks follow
the local Scout baseline and do not change the phase exit gates below.

Dependencies: Phase 1. Can progress while Phase 2 is built; release still requires
cross-chain transfer guards. Exit: an agent does real paid work and carries access.

- [ ] **T016 — Define manifests/templates.** Scout (research brief), Muse (content
  brief), Keeper (treasury digest): versioned skills, tools, schemas, budget and
  transfer policy. Implement Scout first. Acceptance: publish only working workflows;
  placeholder templates must be labeled unavailable.
- [ ] **T017 — Implement a constrained worker.** Recheck epoch/state before jobs and
  every privileged side effect; enforce allowlists, budgets, deadlines and output
  limits. Treat retrieved text as data. Acceptance: prompts cannot authorize spending,
  elevate tools or keep spending after ownership changes.
- [ ] **T018 — Store owned work and memory.** Separate public profile, agent-owned
  knowledge, personal context and secrets; version artifacts with hashes/provenance.
  Acceptance: buyer receives eligible work, seller context is excluded, and the UI
  does not claim deletion of seller-held copies.
- [ ] **T019 — Demonstrate income.** A customer test account pays for actual Scout
  work; record result, treasury payment and receipt. Optional creator revenue share
  must be an explicit split, separate from resale fees. Acceptance: chain/payment/job
  reconcile; prefunded balances are not described as earned revenue.
- [ ] **T020 — Implement holder-gated access.** App-owned research workspace; login
  binds signed nonce/domain/account and protected actions check current owner/epoch.
  Document reconnect/nontransferable connectors. Acceptance: Alice's retained cookie
  fails after sale; Bob's newly authenticated session accesses the eligible workspace.

## Phase 4 — SDK and REST foundation

Dependencies: stable interfaces from Phases 1–3. Exit: use an NFA without the web UI.

- [ ] **T021 — Implement the TypeScript SDK.** create/get/fund, updateManifest,
  grant/revokeDelegate, runJob, getHistory, prepareTransfer/transfer, listForSale/buy.
  Separate wallet-signed writes and reads; expose operation status. Acceptance: one
  short script creates Scout and completes a paid job.
- [ ] **T022 — Add REST/OpenAPI.** Template/NFA/art/history reads, authenticated
  job/manifest operations and unsigned transaction preparation for owner actions.
  Add validation, idempotency, pagination, rate limits and typed errors. Acceptance:
  SDK/API agree; a URL token ID cannot confer authority and server keys do not
  impersonate owners.
- [ ] **T023 — Wrap the renderer.** Provide validated, bounded rendering cached by
  version + asset digest + complete traits. Return manifest/content hash and preserve
  character choice through mint retries. Acceptance: selected preview equals mint
  media and ownership transfer does not reroll the avatar.
- [ ] **T024 — Index and document.** Index finalized events with deduplication and
  rebuild checkpoints; use contract state for write authority. Add SDK examples for
  create/run/transfer. Acceptance: rebuilding the database reproduces owner, income
  and history views without inventing finalized activity.

## Phase 5 — creation and agent dashboard

Dependencies: Phases 3–4. Exit: a new user can create and understand a working agent.

- [ ] **T025 — Build template-first creation.** Template/name/character/budget,
  permission and transfer summary, account funding and recoverable progress.
  Acceptance: failed provisioning/mint resumes without duplicate charges or rerolls.
- [ ] **T026 — Build the character editor.** Randomize/pin traits; glasses plus one
  head accent; compatible hats only. Use existing assets. Acceptance: preview and
  export share generator validation and unsupported combinations are disabled.
- [ ] **T027 — Build the passport/dashboard.** Avatar, owner, account addresses,
  balances, skills, outputs, credential issuer/status and payment/ownership history.
  Separate agent-owned items from owner connections. Acceptance: actual service/
  contract data, no operational placeholders presented as real results.
- [ ] **T028 — Add owner controls and pending UX.** Fund/run/budget/revoke/prepare
  transfer and explain blockers. Acceptance: wallet rejection, API timeout, low gas
  and stale ownership yield recoverable next steps without duplicate submission.

## Phase 6 — trade the whole agent

Dependencies: transfer guards from Phases 1–3 and SDK/UI. Exit: one safe fixed-price
purchase changes control and creates the seller's payable balance.

- [ ] **T029 — Implement listings.** DRAINING stops fresh jobs/signing; reconcile
  outstanding authority then LISTED freezes outgoing actions, grants and mutable
  manifests/settings. Snapshot price, expiry, nonce, included assets and exclusions.
  Incoming funds may continue with clear balance timestamps. Acceptance: a seller
  cannot drain or reconfigure the listed agent while the buyer relies on the offer.
- [ ] **T030 — Settle in the registry.** Native NEAR fixed-price MVP, same contract
  as ownership. Validate nonce, buyer, price, expiry and locked state. Atomically
  transfer ownership/epoch and credit seller/fee withdrawal balances in that receipt.
  Withdraw separately with reserves/refund callbacks. Acceptance: one competing
  buyer wins; payout failure cannot strand the NFT or cause double withdrawal.
- [ ] **T031 — Handle cancellation and bypasses.** Clear expired/cancelled listings;
  restart jobs only on explicit current-owner action. Guard ordinary transfers,
  approvals and transfer-call resolution as well as buy. Reject self-sale/stale
  offers. Acceptance: bypassing the frontend never bypasses a lifecycle lock.
- [ ] **T032 — Build marketplace discovery/details.** Character, capability,
  demonstrated earnings, assets, exclusions, freshness and pending work. Acceptance:
  Bob can inspect the actual sale package without assuming every connection transfers.
- [ ] **T033 — Implement handover.** Show unchanged accounts, new ownership and
  eligible access; reconnect personal integrations and let Bob enable budgets.
  Acceptance: Bob's first job works; Alice's previous authority/approvals/sessions fail.

## Phase 7 — adversarial checks and submission

Dependencies: complete vertical slice. Exit: reproducible deployment and demo evidence.

- [ ] **T034 — Run the transfer attack matrix.** Old owner/delegate/session; forged
  predecessor; duplicate/out-of-order callback; concurrent overspend; sale during
  NEAR payout/MPC signing/EVM broadcast; withheld signature; wrong nonce/chain;
  reorg/uncertain finality; transfer-call rejection/rollback; drain-after-list;
  double buy; failed seller payout; worker restart; credential reconnect. Acceptance:
  automated tests cover each applicable invariant and ambiguous states fail closed.
- [ ] **T035 — Verify operations and recovery.** Measure actual creation/storage,
  job/signature/sale costs and latency. Add bounded retries and pending-operation
  recovery runbook. Acceptance: cold restart preserves all outstanding authority.
- [ ] **T036 — Deploy a reproducible testnet demo.** Record code hashes, settings,
  contract IDs, admin/reporter authority and trust assumptions. Script two owners,
  one customer, funded agents and real receipts. Acceptance: another developer can
  reproduce; secrets stay outside git.
- [ ] **T037 — Record the judge-facing demonstration.** Create → fund → work → earn
  → list → buy → same assets/new control. Show blocked mid-payout sale, old-owner
  rejection and a short real SDK example. Acceptance: operational claims link to
  evidence; mocks/fixtures are labeled.
- [ ] **T038 — Prepare submission material.** Architecture, setup, transfer rules,
  test results, live demo/video and limitations. Position as a transferable agent
  account with a business history. Acceptance: demonstrates useful behavior and
  ownership integrity beyond the avatar.

## Later phases — outside the first release

- [ ] **T039 — General asset inventory.** Add reviewed NEP-141/NEP-171 receivers,
  per-asset withdrawals and one EVM token type with accounting/approval tests.
- [ ] **T040 — Additional chains and intents.** Add adapters individually, with
  chain-specific nonce/UTXO/finality/cancellation review. Add intents for a concrete
  funded workflow; don't extend EVM transfer guarantees to all chains by assumption.
- [ ] **T041 — Credential/integration adapters.** Issuer verification, revocation,
  consent and reissue flows, only where the provider permits transfer.
- [ ] **T042 — Additional agent products.** Richer templates, scheduling, teams and
  skill upgrades with permission diffs.
- [ ] **T043 — Production assurance.** Replace demo trust assumptions where feasible,
  independently review contracts/security, design upgrade/recovery procedures and
  verify economics before accepting material mainnet funds.

## Execution and scope cuts

Proceed in dependency order. Update `docs/PROGRESS.md` per task with status, files,
commands/results and remaining risks. A mock test, screenshot or unsigned transaction
does not prove live custody/transfer. Keep changes reviewable; don't edit sibling
projects. Treat every phase exit as a measurable implementation gate.

If time is short, keep Scout, one EVM testnet, native NEAR sales, the app-owned
workspace membership and existing art. Defer extra templates/tokens, auctions,
external marketplaces, new 3D art and broad SaaS transfer. Never cut transfer guards
or replace settlement evidence with a timeout.

Suggested instruction for Sol:

> Work in `./nfa`. Read README.md, GENERATOR.md and PLAN.md. Begin with T001–T004,
> preserve the artwork, and implement by numbered tasks. Keep docs/PROGRESS.md
> current with evidence. Resolve routine choices within scope; report concrete
> blockers and architectural deviations. Only mark tasks done after acceptance.

## Primary references checked

The application design above is a proposal. Verify deployed interfaces in T004.

- [NFT track](https://github.com/nearai/near-hackathon-prompt-examples/blob/main/tracks/10-nfts.md):
  accounts, access, history and transfer-during-payout behavior.
- [NEP-171](https://github.com/near/NEPs/blob/master/neps/nep-0171.md): NFT and transfer-call interface.
- [Chain Signatures documentation](https://docs.near.org/chain-abstraction/chain-signatures):
  derivation, signing domains, outbound signing and replay protection.
- [NEAR MPC](https://github.com/near/mpc): signer SDK and verifiable-read implementation;
  inspect deployment support before relying on newer functionality.
- [Track-linked account-NFT contracts](https://github.com/houseofstake/tla-contracts):
  reference to inspect for reuse, not adopted by this plan yet.
