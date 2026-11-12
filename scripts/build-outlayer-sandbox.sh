#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
mkdir -p output
base="$(pwd)"
# Isolated Cargo targets keep the release vault and registry binaries intact.
CARGO_TARGET_DIR="$base/output/sandbox-vault-target" cargo build --offline --release \
  --features sandbox-outlayer --target wasm32-unknown-unknown \
  --manifest-path contracts/vault-v2/Cargo.toml
NFA_VAULT_WASM_PATH="$base/output/sandbox-vault-target/wasm32-unknown-unknown/release/nfa_vault.wasm" \
  CARGO_TARGET_DIR="$base/output/sandbox-registry-target" cargo build --offline --release \
  --target wasm32-unknown-unknown --manifest-path contracts/registry/Cargo.toml
wasm-opt -Oz --strip-debug --strip-producers \
  output/sandbox-registry-target/wasm32-unknown-unknown/release/nfa_registry.wasm \
  -o output/sandbox-nfa-registry.wasm
cargo build --offline --release --target wasm32-unknown-unknown \
  --manifest-path contracts/outlayer-mock/Cargo.toml
cp contracts/outlayer-mock/target/wasm32-unknown-unknown/release/nfa_outlayer_mock.wasm \
  output/sandbox-outlayer-mock.wasm
shasum -a 256 output/sandbox-nfa-registry.wasm output/sandbox-outlayer-mock.wasm
