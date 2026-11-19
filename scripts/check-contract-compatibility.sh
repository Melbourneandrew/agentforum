#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ $# != 1 ]]; then echo 'Usage: pnpm contract:compat <trusted-base-commit-or-ref>' >&2; exit 1; fi
base=$(git rev-parse --verify --end-of-options "$1^{commit}")
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
if ! git show "$base:apps/forum/generated/openapi.json" > "$tmp/base.json" 2>/dev/null; then
  # Owner-approved WO-40 clean replacement of the never-deployed old contract.
  # Exactly one known pre-pivot baseline, not a missing-file or arbitrary-ref waiver.
  if [[ "$base" == 476d9533c965b7cbccd6c743cbabde2a3ca61d8e ]]; then
    pnpm contract:check
    echo 'Verified the initial clean-pivot contract against the explicit WO-40 baseline.'
    exit 0
  fi
  echo 'Required base OpenAPI contract is unavailable.' >&2; exit 1
fi
node_modules/.cache/oasdiff/oasdiff breaking "$tmp/base.json" apps/forum/generated/openapi.json --fail-on WARN
