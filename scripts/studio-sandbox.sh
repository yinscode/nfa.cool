#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
if [ -z "${NEAR_SANDBOX_BIN_PATH:-}" ]; then
  sh scripts/install-sandbox.sh
  NEAR_SANDBOX_BIN_PATH="$(pwd)/.deps/bin/near-sandbox"
  export NEAR_SANDBOX_BIN_PATH
fi
npm run build
sh scripts/build-outlayer-sandbox.sh
if [ "${1:-}" = "--background" ]; then
  exec node scripts/studio-background.mjs start
fi
NFA_SANDBOX_OUTLAYER=1 NFA_SANDBOX_REGISTRY_WASM=output/sandbox-nfa-registry.wasm \
  node scripts/persistent-studio.mjs
