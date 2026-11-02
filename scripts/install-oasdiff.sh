#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Reviewed v1.35.0 release asset digest from the upstream GitHub release API.
# No floating installer, container tag, sudo, or unverified cached executable.
if [[ "$(uname -sm)" != 'Linux x86_64' ]]; then
  echo 'oasdiff setup currently requires Linux x86_64 (workspace/CI).' >&2
  exit 1
fi
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl --fail --location --retry 3 --proto '=https' --tlsv1.2 \
  https://github.com/oasdiff/oasdiff/releases/download/v1.35.0/oasdiff_1.35.0_linux_amd64.tar.gz \
  --output "$tmp/oasdiff.tar.gz"
printf '%s  %s\n' 'a8023002fcb2eaa7f5758148a9303cb63d33b939886df312268bc0fc7b939140' "$tmp/oasdiff.tar.gz" | sha256sum --check
mkdir -p node_modules/.cache/oasdiff
tar -xzf "$tmp/oasdiff.tar.gz" -C "$tmp" oasdiff
install -m 755 "$tmp/oasdiff" node_modules/.cache/oasdiff/oasdiff
node_modules/.cache/oasdiff/oasdiff --version
