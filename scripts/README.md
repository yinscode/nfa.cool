# Reproducible probes and demos

`ci.sh` installs, checks and smoke-generates in a temporary directory. Use
`NFA_NPM_OFFLINE=1 npm run ci` when all pinned packages are cached.

For the fast, offline development loop use `npm run dev:vault`, `dev:registry`,
`dev:worker`, `dev:api` or `dev:sdk`. `dev:all` combines native and Node tests;
`dev:bundle` builds and optimizes deployable WASM. See `../docs/LOCAL-LOOP.md`.

`npm run economics` prints a code-only provisioning/storage floor, using an
illustrative byte price unless a reachable RPC URL is passed as an argument.
`NEAR_SANDBOX_BIN_PATH=/absolute/path/to/near-sandbox npm run sandbox:check`
runs the prepared full-receipt mint, paid job, sale and failed-transfer scenario
and writes `output/sandbox-metrics.json` on success. The sandbox executable is
required and this scenario has not yet run in this environment.

`probe-near.mjs` prepares a read-only MPC public-key derivation probe. Run
`node scripts/probe-near.mjs --dry-run` to inspect its RPC inputs. A live run
requires network access to NEAR testnet; it cannot prove a vault can sign
until a funded vault is deployed and sends a transaction.

The testnet two-owner demo and Sepolia reconciliation must follow a passing
sandbox run and a reviewed, single-batch registry upgrade.
