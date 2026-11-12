#!/bin/sh
# Build the reviewed guest with pinned Rust and a workspace-only WASI target.
set -eu
cd "$(dirname "$0")/.."
node scripts/prepare-wasi-toolchain.mjs
export CARGO_HOME="$PWD/.deps/research-cargo"
export CARGO_TARGET_WASM32_WASIP2_RUSTFLAGS="--sysroot $PWD/.deps/research-sysroot"
rustup run 1.88.0 cargo test --locked --manifest-path skills/scout-wasi/Cargo.toml
rustup run 1.88.0 cargo build --locked --release --target wasm32-wasip2 --manifest-path skills/scout-wasi/Cargo.toml
node scripts/check-wasi.mjs
