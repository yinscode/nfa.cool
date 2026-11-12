See [the compact Studio flow](STUDIO-UX-STATUS.md) for the new creation and public profile UX.

# NFA Studio runbook

The Studio release is implemented and exercised on NEAR/OutLayer testnet.
[Status](NFA-STUDIO-STATUS.md) maps S001–S022 to evidence; the web/API is run locally.

## Fast local loop

Requires Node >=20.9, Rust with `wasm32-unknown-unknown`, `wasm-opt` and dependencies
installed with `npm ci`. Cargo commands use the local cache; populate it once
with `cargo fetch --manifest-path contracts/registry/Cargo.toml` and the vault/
mock manifests if a fresh checkout lacks dependencies.

```sh
cd /Users/user/000/_N/nfa
npm run studio:start
```

This builds the SDK/UI and isolated sandbox contracts, installs official NEAR
sandbox 2.14.0 if needed, starts or resumes its persistent local chain and serves
`http://127.0.0.1:3102/studio`. Choose **Create an NFA** and connect the local
Alice/Bob/customer selector. The selector signs only local chain transactions;
OutLayer is a local receipt mock. It uses no testnet tokens. The background server stays running after the
startup command exits. Use `npm run studio:status` to inspect it and
`npm run studio:stop` to stop it from your terminal. Startup is idempotent for
a verified running instance; it never starts a duplicate while a recorded
process is unresolved. Logs are in `.data/studio-server/server-3102.log`.
For a foreground process, use `npm run studio:sandbox` and stop with Ctrl-C.
Keys and chain state are retained privately under `.data/sandbox-chain`;
published local artifacts remain under `.data/sandbox`. A restart resumes the
same chain and wallet accounts. Set `NFA_PORT` or
`NEAR_SANDBOX_BIN_PATH` when needed. Port 3102 is the NFA default; port 3000
may belong to another workspace app. A busy NFA port fails clearly before a
sandbox chain is created.

While that process runs, use `npm run build:web` after web edits, then refresh.
API/contract edits need a process restart. `npm run dev:api`, `dev:worker`,
`dev:vault` and `dev:registry` run focused checks without testnet. Bundle hosted
testing into a later checkpoint rather than sending transactions while editing.
To skip rebuilds after a UI-only edit:

```sh
NFA_SANDBOX_OUTLAYER=1 \
NFA_SANDBOX_REGISTRY_WASM=output/sandbox-nfa-registry.wasm \
NEAR_SANDBOX_BIN_PATH="$PWD/.deps/bin/near-sandbox" \
node scripts/persistent-studio.mjs
```

For the complete isolated automated receipt suite, use the same environment
with `node scripts/sandbox-check.mjs` instead. It writes `output/sandbox-metrics.json` only after all assertions.
Run `npm run dev:bundle` before a release checkpoint. The old-state rehearsal is
`node scripts/rehearse-studio-upgrade.mjs` with a sandbox binary and the bundled actual
previous registry WASM under `releases/nfa-registry-before-studio-253e5b15693b624b.wasm`; it produces
`docs/studio-upgrade-rehearsal.json`. Do not substitute a same-code redeploy for
an old-state upgrade test.

## Inspect the real testnet NFA

For public inspection, select **NEAR testnet · public view** in the running
Studio network picker. The browser reads the real registry directly and lists
`nfa-1` and `nfa-2`. It does not need a signing wallet.

To run a separate API for owner actions/checkout on real testnet, use a free
port so the persistent sandbox remains available:

```sh
export NFA_PORT=3103
export NEAR_RPC_URL=https://test.rpc.fastnear.com
export NFA_REGISTRY_ID=nfagent-registry-0e9b2a.testnet
export NFA_DATA_DIR=.data/studio-live
export NFA_SCOUT_POLICY_JSON='{"limits":{"max_instructions":1000000000,"max_memory_mb":64,"max_execution_seconds":10},"marginYocto":"10000000000000000000000","maxDepositYocto":"500000000000000000000000"}'
export NFA_COMPARE_POLICY_JSON="$NFA_SCOUT_POLICY_JSON"
npm run studio
```

Open `http://127.0.0.1:3103/studio?token=nfa-2`. Public views work disconnected;
owner changes require the current NFT owner. A new wallet can create its own
NFA, provision a Project and configure Scout/Compare using matching schema hashes
from `/studio/skills`. Fund the **new** vault's reserve and review every deposit.
Never fund the retired T004 one-use vault.

A quote pins runtime hash and policy version. Pay its exact unsigned action,
reconcile the finalized request receipt for the actual assigned ID, then start
that job with the exact committed input. Wait for `FINALIZED` and replenishment
before claiming income or handing off. A service execution is an on-demand
OutLayer job, not a permanently running process. Optional keepers use a durable
intent journal and inspect an ambiguous transaction before any retry.

## Durable artifacts and sessions

The demo's PNG, cutout, manifests and runtime bytes are immutable FastFS objects.
The API verifies their hashes and can read them with an empty local cache.
For newly published artifacts, configure private S3-compatible objects using
AWS CLI v2's normal credentials provider chain (server role or private profile):

```sh
export NFA_S3_BUCKET=your-private-bucket
export NFA_S3_REGION=us-east-1
export NFA_S3_PREFIX=nfa
# Optional for a compatible provider:
# export NFA_S3_ENDPOINT=https://your-s3-endpoint
```

Do not put credentials in manifests, browser settings or source. The API writes
remote objects successfully before exposing a URI and verifies every restored
hash. `/studio/storage` reports whether this backend is configured. Without it,
use a durable `NFA_DATA_DIR` mount and backups; local disk is not a public hosting
service. Inputs/keeper journals also need a persistent private mount. Configure
bucket lifecycle/versioning and test restore in the chosen environment.

Owner-only work requests use NEP-413, a one-use challenge and current owner/epoch
checks before and after reads. Restart invalidates sessions; reconnect. For these
deterministic handlers the API can reconstruct a full artifact from the public
finalized start transaction and compare its hash to the job commitment. That is
explicitly labeled reconstruction. It is not evidence of private data retrieval.

## Recovery

| Observed state | Response |
| --- | --- |
| Wallet outcome unknown | Inspect exact transaction hash/signer; retain intent. Do not create another mint or payment. |
| Project uncertain | Read host Project/version and run explicit reconcile. Do not provision a second Project. |
| Job requested, not started, deadline passed | Use expiry/refund only while chain state still proves unstarted. |
| Executing or uncertain | Inspect callbacks and charges. Timeout alone permits no refund, duplicate start or sale. |
| Definite guest failure | Full fee becomes customer payout credit. Owner may resume only after the registry proves the vault is clear; withdraw refund separately. |
| Replenishment failed | Use the applicable retry after inspecting balance; hold transfer lock until settled. |
| Low vault reserve or policy mismatch | Stop new quotes; fund reserve or align local/on-chain policy. |

Only current owners manage Projects, keys and policy. Customer service input
cannot choose management methods, runtime URLs, signing paths or treasury calls.
Pending operations block sale/transfer; ownership epochs invalidate old grants
and API sessions. Seller-downloaded copies cannot be revoked.

## Reproduce the hosted evidence

`studio-testnet.mjs demo`, `stage-runtime-v2.mjs`, `studio-final-gates.mjs` and
`studio-reviewed-quote-smoke.mjs` are testnet-only signed acceptance runners.
They journal intents before submission, retain exact transactions privately and
resume read-only inspection after uncertainty. They require the recorded funded
signer files in `deployments/`; those files are intentionally absent from the
handoff archive. A new environment must use its own disposable funded accounts
and adapt the runner's deployment records. Never copy private keys into evidence.

`capture-studio-attestations.mjs` is read-only. It checks chain, caller, vault
predecessor, Project UUID, execution input, runtime and TDX report-data bindings.
It does not verify Intel collateral/certificate trust or source truth. Saved
records and measured costs are in [evidence/](evidence/studio-attestations.json).
See [OUTLAYER-TESTNET-EVIDENCE.md](OUTLAYER-TESTNET-EVIDENCE.md) for exact transactions.
