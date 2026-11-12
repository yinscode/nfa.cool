#!/bin/sh
# Rebuild the prebuilt WASMs in judge/wasm from this checkout (needs Rust, the
# wasm32-unknown-unknown target and wasm-opt). Judges do not need to run this:
# `npm run judge` uses the committed files and checks them against manifest.json.
set -eu
cd "$(dirname "$0")/.."
base="$(pwd)"; out="$base/judge/wasm"; target="$base/.deps/judge-target"
mkdir -p "$out"
opt() { wasm-opt -Oz --strip-debug --strip-producers "$1" -o "$2"; }
# Testnet-target vault and registry (the code a deployment would ship).
CARGO_TARGET_DIR="$target/vault" cargo build --offline --release --target wasm32-unknown-unknown --manifest-path contracts/vault-v2/Cargo.toml
opt "$target/vault/wasm32-unknown-unknown/release/nfa_vault.wasm" "$out/vault.wasm"
NFA_VAULT_WASM_PATH="$out/vault.wasm" CARGO_TARGET_DIR="$target/registry" cargo build --offline --release --target wasm32-unknown-unknown --manifest-path contracts/registry/Cargo.toml
opt "$target/registry/wasm32-unknown-unknown/release/nfa_registry.wasm" "$out/registry.wasm"
# Sandbox variants: the vault calls the local OutLayer mock instead of outlayer.testnet.
CARGO_TARGET_DIR="$target/vault-sandbox" cargo build --offline --release --features sandbox-outlayer --target wasm32-unknown-unknown --manifest-path contracts/vault-v2/Cargo.toml
opt "$target/vault-sandbox/wasm32-unknown-unknown/release/nfa_vault.wasm" "$target/vault-sandbox-opt.wasm"
NFA_VAULT_WASM_PATH="$target/vault-sandbox-opt.wasm" CARGO_TARGET_DIR="$target/registry-sandbox" cargo build --offline --release --target wasm32-unknown-unknown --manifest-path contracts/registry/Cargo.toml
opt "$target/registry-sandbox/wasm32-unknown-unknown/release/nfa_registry.wasm" "$out/registry-sandbox.wasm"
CARGO_TARGET_DIR="$target/mock" cargo build --offline --release --target wasm32-unknown-unknown --manifest-path contracts/outlayer-mock/Cargo.toml
cp "$target/mock/wasm32-unknown-unknown/release/nfa_outlayer_mock.wasm" "$out/outlayer-mock.wasm"
node -e '
const fs=require("fs"),crypto=require("crypto"),cp=require("child_process");
const dir=process.argv[1],files={};
for(const f of ["registry.wasm","vault.wasm","registry-sandbox.wasm","outlayer-mock.wasm"]){const b=fs.readFileSync(dir+"/"+f);
  files[f]={bytes:b.length,sha256:crypto.createHash("sha256").update(b).digest("hex")}}
const sh=c=>cp.execSync(c,{encoding:"utf8"}).trim();
const manifest={note:"Built by scripts/build-judge-wasm.sh. Hashes are checked by npm run judge; builds are path-dependent, so a rebuild elsewhere can differ.",
  sourceCommit:sh("git rev-parse HEAD"),sourceDirty:sh("git status --porcelain -- contracts").length>0,rustc:sh("rustc --version"),
  files,uses:{"registry-sandbox.wasm":"sandbox suites (vault embedded with the OutLayer mock target)","outlayer-mock.wasm":"deterministic OutLayer stand-in",
    "registry.wasm":"upgrade rehearsal: new registry code","vault.wasm":"upgrade rehearsal: guardian vault upgrade"}};
fs.writeFileSync(dir+"/manifest.json",JSON.stringify(manifest,null,2)+"\n");console.log(JSON.stringify(manifest.files));
' "$out"
