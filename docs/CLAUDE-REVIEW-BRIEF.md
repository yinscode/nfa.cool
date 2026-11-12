# NFA.gent — review brief for Claude

Snapshot: 12 November 2026. Code baseline: `a4ba743` on local `main`.
Repository: `/Users/user/000/_N/nfa`.

## What NFA is

A **Non-Fungible Agent** is an NFT that controls a persistent agent account:
its character, treasury, chain-signature identity, approved services, agent-owned
work and unclaimed income. Selling the NFT changes who can operate this bundle.
The underlying accounts and project identity stay in place; assets do not need
to be swept into a new owner's personal wallet.

The product analogy is a transferable agent business or holding company. The
NEAR hackathon thesis is **ownership with behavior**: create an agent, fund it,
sell services, accumulate work and earnings, then sell the agent with its
operating history and resources intact. The character represents this business;
it is one step of creation, not the whole product.

Broader ambitions include additional assets, credentials, memberships and
approved off-chain integrations. Those should not be confused with today's
implemented NEAR/Sepolia and service adapters.

## Architecture and NEAR features

| Component | Responsibility |
| --- | --- |
| NEAR NFT registry | NFT ownership, owner epochs, grants, listings/purchase, service policies, paid-job escrow, callbacks and earnings records. |
| Stable per-NFA NEAR vault | Holds native funds and performs bounded registry-authorized actions. Provisioned without a human full-access vault key; a trusted guardian upgrade path remains. |
| NEAR Chain Signatures | Derives and signs for an EVM address from the stable vault predecessor and fixed path. This release implements **Sepolia ETH**, not a general multi-chain wallet. |
| One OutLayer Project per NFA | The vault owns the Project and invokes pinned WASI P2 code. A single Project supports multiple typed services; the historical project name is still `scout`. |
| OutLayer storage and secrets | Project UUID plus stable vault predecessor keep agent memory continuous. Secret access is constrained by vault predecessor and exact WASM build. |
| Studio, SDK and REST API | Compact creation, management, public profile, trading and paid-job preparation. REST returns unsigned wallet actions; it does not silently charge a wallet. |

Execution is currently **on demand per job**, not an always-running autonomous
agent server. Logic/skills live in versioned WASM; memory and report artifacts
live in the Project's encrypted storage. Registry records commit to jobs,
versions, outputs, configuration and eligible finalized prior work.

The signing and execution boundaries matter: a successful MPC signature is not
EVM settlement. Unresolved authority-bearing operations block sale. Ownership
changes increment an epoch, invalidating old scoped grants and app sessions.

## What is implemented

- A seeded modular character generator, editable appearance and creation
  templates. Studio uses four creation steps: purpose, identity/character,
  services/budget, then review and resumable launch.
- NFT/vault provisioning; treasury and chain-key views; transaction policies and
  delegates; listings, purchase, transfer guards and recovery/audit views.
- Public profiles showing ownership, vault, Sepolia identity, services, work and
  business history. Persistent local sandbox operation and a real-testnet mode.
- SDK and REST service discovery, schema validation, quotes, wallet checkout,
  exact-payment reconciliation, job start and status. Quotes pin runtime and
  policy versions; Research additionally pins its configuration hash.
- **Scout:** deterministic cited findings from supplied text. **Compare:**
  deterministic evidence-coverage comparison of supplied options. Neither is a
  browsing or LLM service.
- **Research candidate:** distinct typed retrieval/inference adapter, approved
  HTTPS sources, bounded model calls, runtime-bound secret references, durable
  attempt reservation and finalized prior-work context. Its HTTP-capable WASI
  component runs on OutLayer, but actual hosted retrieval/model inference has
  not yet passed end-to-end acceptance.
- Separate accounting for native NEAR escrow, execution replenishment, refunds,
  service earnings, NFT seller proceeds and configured USD model allowances.
  Model usage pricing is not a provider invoice; net profit is not asserted.

## Evidence and current milestones

| Milestone | Result |
| --- | --- |
| M01 — current deployment preflight | Passed: owner, vault/controller, reporter key, pinned wallet, funding and RPC finality checks. |
| M02 — cross-chain handover | Passed on real NEAR testnet/Sepolia: pending sale denied; first **self-transfer** finalized; NFT purchased; same vault/address/Project retained; old seller denied; buyer's self-transfer finalized; nonce advanced twice and pending authority cleared. These do not demonstrate payment to an external recipient. |
| M03 — typed research integration | Contracts, SDK/API and configuration/secret bindings implemented. Exact prior registry bytes and old-vault upgrade compatibility rehearsed before deployment. |
| M04 — WASI runtime | Built and pinned. Six native guest tests pass. Hosted Scout/Compare outputs match reviewed codecs; runtime/input/report-data bindings and actual OutLayer compute charges checked. |
| M05 — memory and billing | Isolated NEAR receipt tests passed with a deterministic OutLayer fixture: sale, seller denial, buyer recall, finalized-only context, unknown-result refund/resume and separate ledgers. This fixture is not a hosted model/TEE test. |
| M06 — real paid research/demo | **Partial.** Registry/vault upgraded; new component active on the same Project. Hosted no-key job returned `NOT_STARTED`, credited the full customer NEAR refund, and resumed through explicit owner action. Scout/Compare and recall of pre-sale Scout work passed under the new runtime. Real research inference and its buyer continuation remain open. |

Current checks: **70 JavaScript tests, 42 registry tests, 15 vault tests and six
guest tests**, plus web/SDK builds, upgrade rehearsal and receipt integrations.
Distinguish these evidence levels rather than treating every pass as live
acceptance. Implementation and evidence changes are committed locally.

Current live identity, as captured in `docs/evidence/m06-preparation.json`:

| Field | Value |
| --- | --- |
| Registry | `nfagent-registry-0e9b2a.testnet` |
| NFT | `nfa-2` |
| Vault | `nfa-2.nfagent-registry-0e9b2a.testnet` |
| Owner / epoch | `nfagent-alice-fe53d8.testnet` / `2` |
| OutLayer UUID | `p0000000000000163` |
| Sepolia address | `0xADfC9988d9A5ac351F7Cad7fc46D99B270A374c9` |

The user funded this address with 0.1 test ETH. The two acceptance transfers
returned value to the same address; only gas was spent. The retired T004
one-use vault must not be funded. Local sandbox `nfa-2` is a different instance.

## What happens next

1. Supply a dedicated model credential, provider (`near-ai` or `openai`) and
   reviewed model ID in the ignored `.env.research` file. No model key is
   currently configured. Check provider rates before pricing real inference.
2. Run an actual paid Research job in the vault-owned Project. Verify source
   quotations, model usage, native compute charges, output commitment and memory.
3. Sell the NFT, reject the previous owner's commands, recall eligible research
   work and run a buyer job whose actual execution input contains the finalized
   pre-sale context. Verify unchanged vault, wallet and Project UUID.
4. Promote Research from candidate only after those gates pass, then record the
   final local-Studio demonstration against real testnets.

Public hosting is explicitly deferred. Production work still includes durable
hosting/restore, external-wallet acceptance, independent security review and
reducing operator trust. Additional services/schedulers, assets and chains are
later adapters, not already-delivered capabilities.

## Boundaries and limitations to preserve

- **Memory must not follow the human signer.** Vault-predecessor storage is
  deliberate; OutLayer's default signer cell could split seller/buyer memory.
- **Customer input cannot select project-management methods, credentials,
  arbitrary signing payloads or project-bound signing keys.** A paid-service
  endpoint must remain a typed capability, not a privileged generic executor.
- **Attestation does not prove factual accuracy.** Report-data bindings were
  checked; the complete Intel collateral/signature chain was not independently
  verified. The EVM reporter/RPC and registry/guardian upgrades remain trusted.
- The operator's provider secret remains operator-owned and revocable. A stable
  vault/build grant is not a transfer of a personal provider account or OAuth
  identity. Already copied information cannot be made unknowable after sale.
- Full Research artifacts currently remain encrypted for subsequent approved
  jobs. Owner recall exposes a commitment-checked summary. A complete customer
  report-download/export adapter is still a product gap to review before broad
  customer use.
- Keep royalties, x402, 1Click/Intents, personal OAuth transfer and additional
  chains outside this first paid-job release. Their ledgers/adapters belong in
  separate work.

## Requested review

Review the architecture and implementation independently. Prioritize:

1. Sale/listing/transfer-call races, epoch invalidation, callback idempotency and
   stale-owner authority, including authority already issued across chains.
2. EVM nonce/finality assumptions, exact-byte restart/replay behavior and paths
   that could clear a lock prematurely or permanently strand the agent.
3. Contract storage-layout compatibility, upgrade powers, configuration/quote
   binding, secret/build/predecessor checks and any customer-to-privilege path.
4. Memory eligibility, replay/duplicate inference charging, unknown outcomes,
   refund/resume behavior and accounting liabilities across ownership changes.
5. Gaps between product claims and demonstrated evidence, especially real
   inference, full report delivery, credentials and production readiness.

Return findings by severity with file/line references, an exploit or failure
sequence, proposed fix and necessary test. Separate blockers, hardening and
future product ideas. Review only: do not deploy, move funds, rotate credentials
or publish. Do not read or reproduce private keys, `.env.research` contents or
raw signed-intent journals.

Start with `docs/MILESTONES.md`, `docs/RELEASE-PLAN.md`,
`docs/ORIGINAL-PLAN-STATUS.md`, `docs/OWNERSHIP.md` and
`docs/RESEARCH-ACCEPTANCE.md`. Inspect `contracts/registry/src/`,
`contracts/vault-v2/src/`, `skills/scout-wasi/src/`, `services/worker/`,
`services/api/`, `packages/sdk/src/` and `apps/web/`.
Primary recent evidence: `docs/evidence/m02-handover.json`,
`docs/m03-upgrade-rehearsal.json`, `docs/evidence/m04-component-smoke.json`,
`docs/evidence/m05-memory-billing.json` and
`docs/evidence/m06-preparation.json`. Older design documents contain historical
questions; reconcile them against these current receipts and source code.
