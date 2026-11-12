# Fast local development loop

Install dependencies once with `npm ci` and the pinned Rust toolchain and WASM
target. Work in `./nfa`. None of the `dev:*` commands contacts a chain or
submits transactions; Rust builds use the local Cargo cache (`--offline`).

| Changed area | During editing | Before combining changes |
| --- | --- | --- |
| `contracts/vault-v2/` | `npm run dev:vault` | `npm run dev:registry` (embeds vault WASM) |
| `contracts/registry/` | `npm run dev:registry` | `npm run dev:all` |
| `services/worker/` | `npm run dev:worker` | `npm run dev:all` |
| `services/api/` | `npm run dev:api` | `npm run dev:all` |
| `packages/` | `npm run dev:sdk` | `npm run dev:all` |
| Generator/artwork | `node --test test.cjs` | `npm run dev:all` |

`dev:registry` always asks Cargo to build the vault WASM first. Cargo skips the
work when inputs are unchanged. This is required because the registry embeds
the vault bytes at compile time. `dev:all` runs both native contract suites,
the TypeScript/web builds and the Node tests without reinstalling dependencies
or optimizing WASM. `dev:bundle` is the slower checkpoint: both contract tests,
release WASM builds, registry optimization, TypeScript builds and Node tests.
Use it before saving a candidate for later testnet deployment.

## Work in vertical slices

1. Write one observable transition and its invariants: caller, owner epoch,
   lifecycle, reserved amount or nonce, callback result, and recovery state.
2. Add a native VM test for the success and the risky failure/race. Run only
   `dev:vault` or `dev:registry` while editing. Tests should assert the public
   state and event/operation semantics, rather than duplicating private helpers.
3. Add a fixture for the public view and a worker/API test if the interface
   crosses a package boundary. Run its focused command.
4. Run `dev:all` after the slice works. Run `dev:bundle` before an integration
   checkpoint; record the optimized WASM hash and source revision together.

The native tests can inject callback results but do not execute the full NEAR
receipt scheduler. `scripts/sandbox-check.mjs` is the separate integration
suite; set `NEAR_SANDBOX_BIN_PATH` to the official locally installed binary and
run `npm run sandbox:check` at feature boundaries. Run `npm run economics` for a
quick code-size floor, then reconcile actual gas and storage with the sandbox
metrics. Testnet is a separate deployment batch after
the local suite passes; use fresh signed transactions, check on-chain code hash
and views, and record receipts in `docs/LIVE-DEPLOYMENT.md`.

## Interactive Studio

Run `npm run studio:start` for a persistent local chain, OutLayer receipt mock and
Alice/Bob/customer wallet selector. It serves `http://127.0.0.1:3102/studio` and
uses no testnet tokens. It remains running in the background; inspect with
`npm run studio:status` and stop from your terminal with `npm run studio:stop`.
`npm run studio:sandbox` is the foreground alternative. `npm run build:web` then refresh applies browser edits;
API or contract edits require restart. The fast serve path skips the full
acceptance suite. See [STUDIO-RUNBOOK.md](STUDIO-RUNBOOK.md) for startup,
no-rebuild mode, testnet checkpoint and durable storage.

The full sandbox suite and actual-old-bytecode upgrade rehearsal have passed.
The current registry is deployed on testnet and both hosted services, sale,
buyer memory recall, runtime continuity and refund recovery have passed too.
[Evidence](OUTLAYER-TESTNET-EVIDENCE.md) distinguishes mock results from hosted
results. No external web/API host or production bucket is provisioned.
