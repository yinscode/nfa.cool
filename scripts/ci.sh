#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
if [ "${NFA_NPM_OFFLINE:-0}" = "1" ]; then
  npm ci --offline --no-audit --no-fund --logs-dir=/tmp
else
  npm ci --no-audit --no-fund
fi
npm run check
smoke_dir="$(mktemp -d)"
trap 'rm -rf "$smoke_dir"' EXIT HUP INT TERM
node generate.cjs --count 2 --seed ci-smoke --out "$smoke_dir/characters"
