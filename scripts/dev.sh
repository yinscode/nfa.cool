#!/bin/sh
# Fast, offline checks for the local development loop. No RPC or testnet writes.
set -eu
cd "$(dirname "$0")/.."

vault_test() {
  cargo test --offline --quiet --features near-sdk/unit-testing \
    --manifest-path contracts/vault-v2/Cargo.toml
}
vault_wasm() {
  # registry/src/lib.rs embeds this file, so a missing or stale vault build must
  # be rebuilt before compiling registry tests, even on a clean checkout.
  cargo build --offline --quiet --release --target wasm32-unknown-unknown \
    --manifest-path contracts/vault-v2/Cargo.toml
}
registry_test() {
  vault_wasm
  cargo test --offline --quiet --features near-sdk/unit-testing \
    --manifest-path contracts/registry/Cargo.toml
}

case "${1:-}" in
  vault) vault_test ;;
  registry) registry_test ;;
  worker) node --test services/worker/test/*.test.mjs ;;
  api) npm run build:web; node --test services/api/test/*.test.mjs ;;
  sdk) npm run build ;;
  all)
    vault_test
    registry_test
    npm run build
    npm test
    ;;
  bundle)
    sh scripts/check-contracts.sh
    npm run check
    ;;
  *)
    echo 'Usage: sh scripts/dev.sh {vault|registry|worker|api|sdk|all|bundle}' >&2
    exit 2
    ;;
esac
