#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
version=2.14.0
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) platform=Darwin-arm64 ;;
  Linux-x86_64) platform=Linux-x86_64 ;;
  Linux-aarch64) platform=Linux-aarch64 ;;
  *) echo 'Set NEAR_SANDBOX_BIN_PATH to a compatible NEAR sandbox binary.' >&2; exit 1 ;;
esac
mkdir -p .deps/bin
if [ -x .deps/bin/near-sandbox ]; then .deps/bin/near-sandbox --version; exit 0; fi
temporary="$(mktemp -d)"
trap 'rm -rf "$temporary"' EXIT
curl --fail --location --retry 2 --max-time 120 \
  "https://s3-us-west-1.amazonaws.com/build.nearprotocol.com/nearcore/$platform/$version/near-sandbox.tar.gz" \
  --output "$temporary/sandbox.tar.gz"
tar -xzf "$temporary/sandbox.tar.gz" -C "$temporary"
binary="$temporary/$platform/near-sandbox"
"$binary" --version | rg '2\.14\.0'
cp "$binary" .deps/bin/near-sandbox
chmod 755 .deps/bin/near-sandbox
