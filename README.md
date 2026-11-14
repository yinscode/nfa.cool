# nfa.cool — own the whole agent

**NFA means Non Fungible Agent.** It is a transferable
agent business on NEAR. Its NFT controls a stable
vault, approved services, work history and unclaimed income. When the NFT is
sold, the buyer takes over the same operating agent.

Built at **NEAR HACKATHON**. The site opens on a [landing page](apps/web/landing.html),
with NFA Studio at `/studio` when running locally.

## The problem

An agent can do paid work, but its wallet, runtime, records and earnings are
often attached to the person running it. A sale then becomes a manual migration:
new accounts, broken service links, missing history and uncertain authority for
the former owner.

NFA makes the **agent itself** the persistent unit. The NFT changes its
controller; the NEAR vault, derived chain address and OutLayer Project keep
their identity. The buyer can use eligible finalized work in a new job, while
the seller's owner permissions expire with the ownership epoch.

## What it does

1. **Create:** Studio mints an NFT, provisions a keyless NEAR vault and binds a
   reviewed service Project. The owner sets service policies and budgets.
2. **Work:** Customers pay for bounded Scout, Compare or configured Research
   jobs. The registry records the payment, result commitment and agent income.
3. **Transfer:** Pending authority-bearing work blocks a sale. Buying the NFT
   changes the owner and epoch, leaving the vault and Project in place.
4. **Continue:** The buyer can recall eligible earlier work and commission the
   next job under the same agent identity.

The local Studio creates and manages Scout/Compare agents. Research has a
separate, operator-configured testnet acceptance path; its provider credential
is not entered in the browser.

### Why NEAR

| NEAR capability | Role in NFA |
| --- | --- |
| NFT registry and subaccounts | The NFT controls a stable, keyless vault account. |
| Promises and callbacks | Paid jobs, refunds and transfers settle through explicit states. |
| FunctionCall keys and ownership epochs | Operators have scoped methods; former-owner grants become stale after sale. |
| Chain Signatures | The vault derives one persistent Sepolia address across owners. |
| Native accounting | Escrow, refunds, seller proceeds, execution reserve and NFA income stay distinct. |

OutLayer executes pinned WASI service code and stores eligible work under the
stable vault predecessor. NEAR AI supplies model inference for Research. A
customer cannot choose the runtime, secret, signing path or privileged method
through a job input.

## Watch the handover

[**42-second testnet evidence replay**](docs/research-live-evidence-replay.mp4)
shows create → customer payment → real Research output and earnings → NFT sale
→ buyer recall and another paid Research job. It assembles **separate live
receipts**; it is not a continuous wallet screen recording.

| Live step | Evidence |
| --- | --- |
| Seller job `48` finalized with priced NEAR AI usage | [Research settlement](https://testnet.nearblocks.io/txns/D2WAQrDWSLV6G76HiJTsm5wM2oCQxRahQsucsB4yKXDW) · [receipt](docs/evidence/paid-async-research-seller.json) |
| Alice sold NFA-2 to Bob; vault, address and Project UUID persisted | [Sale transaction](https://testnet.nearblocks.io/txns/2wEpiqPGBW7gMBxDHAXrvuawJVGKmC347rQYyiSHxPXz) · [handover checks](docs/evidence/async-research-handover.json) |
| Buyer job `51` finalized using job `48`'s earlier output commitment | [Research settlement](https://testnet.nearblocks.io/txns/29cPB4NvQasi1kLeCSXoj5hVZTddxraPMnB9pY1mUGBP) · [receipt](docs/evidence/paid-async-research-buyer-accepted.json) |

The testnet handover also rejected a replayed refund, stale seller upgrade
approval and the former owner's recall. [All stored liabilities reconcile](docs/evidence/live-liability-reconciliation.json)
after the jobs and sale. The live NFA is `nfa-2` under
`nfagent-registry-0e9b2a.testnet`; its OutLayer Project UUID is
`p0000000000000163`.

## Try it yourself

Requires Node.js 20.9+ and npm. No keys or testnet tokens are needed for the
local experience.

```sh
npm ci
npm run studio:start
```

Open **http://127.0.0.1:3102/** for the landing page, then **/studio** for
the persistent local Studio. Choose the local Alice, Bob or customer wallet.
Create an agent, pay for a Scout/Compare job, sell it and inspect the buyer's
continuing account. The local chain and OutLayer mock survive a server restart.
Use `npm run studio:status` and `npm run studio:stop` to manage it.

### For agent judges

```sh
npm run judge            # local NEAR sandbox; writes judge-report.json
npm run verify:testnet   # read-only live NEAR testnet + Sepolia checks
```

`npm run judge` replays creation, paid work, refunds, handover, prior-work
context and recovery. It needs no secrets; Rust is optional for the native
contract tests. `verify:testnet` re-derives the current vault, address,
Project, owner epoch and Sepolia receipts from public RPCs. The
[claim ledger](docs/CLAIMS.json) gives each claim its evidence level, checks
and exact receipt links. [AGENTS.md](AGENTS.md) is the machine-readable review
guide. Docker users can run
`docker build -f Dockerfile.judge -t nfa-judge . && docker run --rm nfa-judge`.

The [local walkthrough](docs/release-evidence-walkthrough.mp4) uses a
deterministic OutLayer mock. The Research replay above uses hosted OutLayer,
NEAR AI and real testnet payments. These evidence levels are labeled separately.

## Current boundaries

- The local web/API is available; **public hosting is deferred**. Testnet-only
  deployment is intentional for this release.
- The restricted HTTPS reporter observes OutLayer and settles its reported
  result. The registry binds job, runtime, owner epoch, output and cost cap,
  but does **not** verify an OutLayer attestation on-chain. Model usage pricing
  is an estimate, not a provider invoice or net-profit claim.
- Bob's hosted Research recall used the operator-held vault Payment Key. Bob
  signed the later paid continuation, whose input included Alice's finalized
  work commitment. Personal OAuth grants and seller-held copies do not transfer.
- Restricted reporter and guardian keys are live. A restricted admin proposed
  the exact current registry code for a delayed apply; remaining FullAccess
  keys await that [48-hour gate](docs/evidence/restricted-self-upgrade-scheduled.json).
- The Sepolia acceptance transfers returned ETH to the NFA's own address;
  external-recipient EVM payment is outside the demonstrated scope. Intents
  checkout is locally tested, while direct Circle testnet USDC checkout has
  completed-job and refund receipts.

## Hackathon scope and prior work

The modular character generator and art assets began as earlier local work
(`../nfa-generator`) and are treated as a baseline. The NEAR NFT registry,
keyless vault, Chain Signatures identity, OutLayer service integration,
ownership handover, accounting, SDK, Studio and testnet acceptance form the
NEAR HACKATHON work. This standalone repository's Git history starts with an
import on 12 November 2026; that import commit is not a pre-hackathon baseline
tag. The subsequent local history and [milestones](docs/MILESTONES.md) record
the NEAR integration work.

## Explore the implementation

| Area | Start here |
| --- | --- |
| Studio and landing page | [`apps/web/`](apps/web/) · [Studio runbook](docs/STUDIO-RUNBOOK.md) |
| NEAR registry and vault | [`contracts/registry/`](contracts/registry/) · [`contracts/vault-v2/`](contracts/vault-v2/) |
| OutLayer guest and worker | [`skills/scout-wasi/`](skills/scout-wasi/) · [`services/worker/`](services/worker/) |
| API and SDK | [`services/api/`](services/api/) · [`packages/sdk/`](packages/sdk/) |
| Live Research, demo and submission | [acceptance](docs/RESEARCH-ACCEPTANCE.md) · [demo script](docs/DEMO-SCRIPT.md) · [submission summary](docs/SUBMISSION.md) |

The [independent review](docs/reviews/2026-11-12-claude-review.md) preserves
its original findings and later fix status. The [release plan](docs/RELEASE-PLAN.md)
distinguishes shipped acceptance from future products.
