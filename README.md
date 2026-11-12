# nfa.gent

An NFT that controls a persistent agent account: character, treasury, pinned
chain-signature identity, reviewed services, work history and unclaimed income.
The account stays when ownership changes.

## For judges and agents

Start with [AGENTS.md](AGENTS.md). No keys, testnet tokens or Rust are needed:

```sh
npm ci
npm run judge            # ~2–3 min; re-runs the claims in a local NEAR sandbox, writes judge-report.json
npm run verify:testnet   # read-only: re-derives the live NFA's vault, address, Project and Sepolia receipts
```

- `docker build -f Dockerfile.judge -t nfa-judge . && docker run --rm nfa-judge` runs the judge on any Docker host.
- [docs/CLAIMS.json](docs/CLAIMS.json) lists every claim with its level, status, evidence and explorer links.
- `npm run mcp` (configured in [.mcp.json](.mcp.json)) lets an agent quote, hire and sell an NFA against a local Studio.
- [docs/DEMO-SCRIPT.md](docs/DEMO-SCRIPT.md) is the text equivalent of the demo video.
- [The independent review](docs/reviews/2026-11-12-claude-review.md) records findings and fix status.

**The compact Studio flow is complete:** four-step creation, resumable launch,
persistent local state, public profiles and current paid-service checkout.
See [six-point completion](docs/STUDIO-UX-STATUS.md) for the new workflow.

**NFA Studio S001–S022 is implemented and its NEAR/OutLayer testnet acceptance
passed.** Studio supports character mint/edit, vault and key policies, delegates,
one OutLayer Project with Scout/Compare services, paid jobs, memory recall,
refund recovery, version changes, sale/transfer and receipt audit.

```sh
npm ci
npm run studio:start
```

Open `http://127.0.0.1:3102/studio`, choose Create, and use the local
Alice/Bob/customer wallet selector. This starts or resumes a persistent NEAR sandbox and OutLayer
mock without testnet tokens. `studio:start` leaves the server running in the
background; use `npm run studio:status` or `npm run studio:stop`.
For prerequisites, real-testnet startup and durable
storage see [docs/STUDIO-RUNBOOK.md](docs/STUDIO-RUNBOOK.md).

- [Studio task status](docs/NFA-STUDIO-STATUS.md) — S001–S022 and limits
- [Hosted testnet evidence](docs/OUTLAYER-TESTNET-EVIDENCE.md) — two services, sale,
  buyer recall, version continuity, failed-job refund and measured costs
- [Studio plan](docs/NFA-STUDIO-PLAN.md) and [service REST API](docs/SERVICES-API.md)
- [Fast focused checks](docs/LOCAL-LOOP.md) and [deployment history](docs/LIVE-DEPLOYMENT.md)

Validation: 70 JS tests, 15 vault tests, 42 registry tests, six WASI guest tests, web/SDK builds,
full sandbox receipt suite, actual-old-bytecode upgrade rehearsal and hosted
acceptance. Current testnet NFT is `nfa-2`, registry
`nfagent-registry-0e9b2a.testnet`, Project UUID `p0000000000000163`.

The web/API runs locally; no public production host or S3 bucket was provisioned.
The demo's art is published to immutable FastFS; new API publications need a
durable mount or configured S3 backend. Inputs/recall summaries are public.
Scout/Compare process supplied text deterministically; attestation does not prove
source accuracy. x402, royalties, Intents, personal OAuth handoff and more chains
remain separate products. Existing old vaults do not silently acquire new code.

`nfa-handoff.zip` is the refreshed portable source/artwork/release snapshot.
Work from this folder. The archive excludes keys, signed transactions,
dependencies, caches and local deployment journals; public acceptance evidence
is included under `docs/evidence/`. Do not fund the retired T004 one-use vault.

## Release milestones

The six approved release milestones are tracked in [RELEASE-PLAN.md](docs/RELEASE-PLAN.md). SDK/service packages, economics/inventory and a 13-check local handover demo are delivered. M01–M05 are complete: current Sepolia handover, typed research contracts/SDK/API, pinned WASI and local memory/billing acceptance. M06 hosted compatibility and no-key failure/refund checks passed; real inference, research handover and the final demo need a dedicated model credential. Public hosting remains deferred. See [MILESTONES.md](docs/MILESTONES.md). See [DEVELOPER-QUICKSTART.md](docs/DEVELOPER-QUICKSTART.md) and [DEMO-SCRIPT.md](docs/DEMO-SCRIPT.md).

## Already implemented

The v2 character generator, 56 transparent PNG parts (50 active), seven source
atlases and three sheets containing 48 generated examples are saved here.

| Path | Purpose |
| --- | --- |
| `generate.cjs` | Seeded generator and curated presets |
| `assets/` | Transparent parts and checksum catalog |
| `source-atlases/` | Original generated artwork |
| `output/v2-eyewear/` | Glasses examples and sheet |
| `output/v2-accents/` | Small attachments and floating ornaments |
| `output/v2-mixed/` | Mixed examples including fitted hats |
| `GENERATOR.md` | Generator documentation |
| `test.cjs` | Reproducibility, asset and compatibility tests |
| `PLAN.md`, `docs/OWNERSHIP.md` | Implementation handoff and transfer threat model |
| `docs/NEAR-SPIKE.md` | T004 interface evidence and live completion gate |
| `docs/LOCAL-LOOP.md` | Fast offline test commands and testnet checkpoint boundary |
| `docs/OUTLAYER-PLAN.md` | Phased plan for transferable OutLayer execution, memory and NFA-funded jobs |
| `packages/shared/`, `packages/sdk/` | Typed schemas and wallet-action SDK |
| `contracts/vault-v2/`, `contracts/registry/` | NEAR vault and guarded NFT registry; see live deployment status |
| `services/worker/`, `services/api/` | Scout worker, durable work storage, API access and EVM settlement components |
| `templates/scout/`, `apps/web/` | Working Scout template and local create/passport/market UI |

## Run

Requires Node.js 20.9 or newer.

From the repository root:

```sh
npm install
npm run check
node generate.cjs --count 16 --seed my-nfa --out output/my-nfa
```

Open `output/my-nfa/index.html` or `contact-sheet.png`.
The renderer works offline after dependency installation; it does not mint NFTs.
For a clean installation and smoke run, use `npm run ci` (or
`NFA_NPM_OFFLINE=1 npm run ci` with a populated npm cache). The workflow under
`.github/workflows/` runs when this folder is the repository root; when this is a
subfolder of another repository, wire `npm run ci` into that repository's CI.
For day-to-day work, use the focused `npm run dev:*` commands in
[docs/LOCAL-LOOP.md](docs/LOCAL-LOOP.md); they do not contact testnet.
`npm run dev:bundle` verifies the release. Use `npm run studio:sandbox` for
interactive local development or the runbook to inspect real testnet.

Use this folder for future work. The earlier `../nfa-generator` copy was retained
as a backup. See [GENERATOR.md](GENERATOR.md) for all presets and options.
