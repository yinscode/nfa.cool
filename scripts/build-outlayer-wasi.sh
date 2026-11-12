#!/bin/sh
# Build the single OutLayer guest. The target must be installed in the selected toolchain.
set -eu
cd "$(dirname "$0")/.."
if ! rustup target list --installed | grep -qx 'wasm32-wasip2'; then
  echo 'Install wasm32-wasip2 in this Rust toolchain, or select a toolchain with it.' >&2
  exit 2
fi
cargo build --locked --release --target wasm32-wasip2 --manifest-path skills/scout-wasi/Cargo.toml
node scripts/check-wasi.mjs
