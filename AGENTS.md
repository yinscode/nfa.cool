# AGENTS.md — evaluating nfa.cool

**What it is.** An NFA is an NFT that controls a persistent agent account. That account
includes a NEAR vault, a Chain Signatures Sepolia address, a vault-owned OutLayer Project
running paid services, its memory and its income. Selling the NFT hands the working agent
to the buyer:

- The owner and owner epoch change.
- The vault, address and Project stay the same.
- The former owner loses every authority.

## Verify it in one command (no keys, no tokens, no Rust)

```sh
npm ci
npm run judge          # about 3 minutes; --quick skips Rust tests and the upgrade rehearsal (about 90 s)
```

The judge writes `judge-report.json` (`result`, `steps[]`, `claims[]`) and exits non-zero on
any failure. Each step re-derives a claim locally:

| Step | What it proves | Needs |
| --- | --- | --- |
| `unit-js` | Workers, API, SDK, settlement, locks, claims-ledger consistency | Node 20.9+ |
| `contracts-*` | Native registry and vault tests: callbacks, races, recovery, timelocks | `cargo` (skipped if missing) |
| `prebuilt-wasm` | The committed WASMs in `judge/wasm` match their manifest | — |
| `sandbox` | Keyless vault, paid Scout, sale, capped delegated NFA hiring, former owner refused, transfer-call rollback, payouts | NEAR sandbox |
| `recovery` | No customer or delegate can freeze an NFA; slot pricing, refunds, liabilities | NEAR sandbox |
| `research` | Memory survives sale; only finalized work enters context; separate ledgers | NEAR sandbox |
| `rehearsal` | New code upgrades actual prior deployed bytes, preserving state | NEAR sandbox |
| `mcp-agent-flow` | An agent creates an NFA, hires it, and sells it through the MCP server | NEAR sandbox |

The NEAR sandbox binary (official 2.14.0) is downloaded once into `.deps/bin` on macOS arm64
or Linux. On other hosts:

```sh
docker build -f Dockerfile.judge -t nfa-judge . && docker run --rm nfa-judge
```

All sandbox work uses temporary directories and random ports. Nothing touches testnet.

## Check the live testnet facts (read-only)

```sh
npm run verify:testnet                      # NEAR testnet + Sepolia
node scripts/authority-inventory.mjs nfa-2  # who can change the rules
```

These re-derive the live NFA's state from public RPCs and compare it with
`docs/evidence/*.json`:

- vault, address, Project UUID, owner and epoch;
- that the vault has no keys;
- both Sepolia receipts and the finalized nonce.

## Use it as an agent (MCP)

```sh
npm run studio:start                          # local sandbox Studio on :3102 (or NFA_PORT)
NFA_API_URL=http://127.0.0.1:3102 npm run mcp # stdio MCP server; see .mcp.json
```

Read tools: `nfa_overview`, `nfa_claims`, `nfa_profile`, `nfa_services`, `nfa_quote`,
`nfa_prepare_start`, `nfa_job`, `nfa_owned`.

Sandbox tools (local test accounts only): `nfa_sandbox_bootstrap` → `nfa_sandbox_hire` →
`nfa_sandbox_sell`, and `nfa_sandbox_send` for any unsigned action. Against testnet, the
quote and prepare tools return unsigned actions only; nothing is charged without a wallet.

REST: `GET /openapi.json`, `GET /llms.txt`, `GET /v1/nfas/:id/services`,
`POST /v1/nfas/:id/services/:service/quotes`.

## Claims and their evidence

`docs/CLAIMS.json` lists every claim. Each entry has:

- a level (`native-test`, `sandbox`, `hosted-testnet`, `live-testnet`, `live-sepolia`);
- a status (`verified`, `disclosed`, `open`, `not-claimed`);
- evidence files and public explorer links;
- the judge check or read-only command that backs it.

The judge marks each claim `verified` only when all of its checks ran and passed.

## Honest limits

**Trust.** These parties are trusted:

- the registry admin key;
- the vault guardian (upgrades are bounded by owner approval or a 7-day delay in new code);
- the EVM reporter and its RPC quorum;
- OutLayer's attestation, which proves the code and input, not factual accuracy.

On testnet today, the registry and shared operator account still hold
FullAccess keys. Receiver-specific reporter, maintenance and guardian
FunctionCall keys and a restricted registry admin key have been tested. The
restricted reporter settled both paid Research jobs. The admin key proposed
the exact current registry bytes; its public 48-hour apply delay ends at the
time recorded in `docs/evidence/restricted-self-upgrade-scheduled.json`.
The old keys await a successful delayed apply before removal.

**Release status:**

- the reviewed fixes are deployed; see `docs/evidence/reviewed-testnet-rollout.json`
  and `docs/evidence/reviewed-security-regressions.json`;
- capped NFA-to-NFA hiring is deployed and has a paid hosted Scout receipt; see
  `docs/evidence/hiring-testnet-rollout.json` and `docs/evidence/hiring-testnet-acceptance.json`;
- direct FT checkout has live Circle testnet USDC payment, completed-job and refund receipts;
- Intents checkout has local mocked-finality tests but no live payment;
- Research seller and buyer jobs completed with real NEAR AI inference and
  priced usage; the registry trusts the restricted HTTPS reporter and does not
  verify an OutLayer attestation on-chain;
- no public hosting;
- no payment to an external Sepolia recipient (only self-transfers).

## Do not

- Do not use files under `deployments/` or `.data/`: they hold local keys and signed journals.
- Do not run `scripts/m0*-*.mjs`, `scripts/rollout-reviewed-testnet.mjs`,
  `scripts/reviewed-security-regressions.mjs`, `studio-testnet.mjs` or
  `settle-evm.mjs --send` during a read-only evaluation: they write to testnet.
  Everything in the verification commands above is read-only or sandboxed.

More: `README.md`, `docs/reviews/2026-11-12-claude-review.md` (independent review and fix status),
`docs/DEMO-SCRIPT.md` (text walkthrough of the recorded demo).
