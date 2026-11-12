#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
version=2.14.0
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) platform=Darwin-arm64 ;;
  Linux-x86_64) platform=Linux-x86_64 ;;
  Linux-aarch64) platform=Linux-aarch64 ;;
  *) echo 'No official NEAR sandbox build for this platform (for example Intel macOS). Set NEAR_SANDBOX_BIN_PATH, or run the judge in Docker: docker build -f Dockerfile.judge -t nfa-judge . && docker run --rm nfa-judge' >&2; exit 1 ;;
esac
mkdir -p .deps/bin
if [ -x .deps/bin/near-sandbox ]; then .deps/bin/near-sandbox --version; exit 0; fi
temporary="$(mktemp -d)"
trap 'rm -rf "$temporary"' EXIT
curl --fail --location --silent --show-error --retry 2 --max-time 120 \
  "https://s3-us-west-1.amazonaws.com/build.nearprotocol.com/nearcore/$platform/$version/near-sandbox.tar.gz" \
  --output "$temporary/sandbox.tar.gz"
tar -xzf "$temporary/sandbox.tar.gz" -C "$temporary"
binary="$temporary/$platform/near-sandbox"
"$binary" --version | grep -q '2\.14\.0'
shasum -a 256 "$binary" 2>/dev/null || sha256sum "$binary"
cp "$binary" .deps/bin/near-sandbox
chmod 755 .deps/bin/near-sandbox
