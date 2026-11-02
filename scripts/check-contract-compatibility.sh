#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ $# != 1 ]]; then
  echo 'Usage: pnpm contract:compat <trusted-base-commit-or-ref>' >&2
  exit 1
fi
base=$(git rev-parse --verify --end-of-options "$1^{commit}")
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
# A missing baseline, executable, or current contract is an error, never a pass.
git show "$base:apps/api/generated/openapi.json" > "$tmp/base.json"
node_modules/.cache/oasdiff/oasdiff breaking "$tmp/base.json" \
  apps/api/generated/openapi.json --fail-on WARN
