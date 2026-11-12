#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
cargo test --offline --features near-sdk/unit-testing --manifest-path contracts/vault-v2/Cargo.toml
cargo build --offline --release --target wasm32-unknown-unknown --manifest-path contracts/vault-v2/Cargo.toml
# The registry embeds the optimized vault (see contracts/registry/build.rs).
wasm-opt -Oz --strip-debug --strip-producers contracts/vault-v2/target/wasm32-unknown-unknown/release/nfa_vault.wasm \
  -o contracts/vault-v2/target/wasm32-unknown-unknown/release/nfa_vault_opt.wasm
cargo test --offline --features near-sdk/unit-testing --manifest-path contracts/registry/Cargo.toml
cargo build --offline --release --target wasm32-unknown-unknown --manifest-path contracts/registry/Cargo.toml
wasm-opt -Oz --strip-debug --strip-producers contracts/registry/target/wasm32-unknown-unknown/release/nfa_registry.wasm \
  -o contracts/registry/target/wasm32-unknown-unknown/release/nfa_registry_opt.wasm
