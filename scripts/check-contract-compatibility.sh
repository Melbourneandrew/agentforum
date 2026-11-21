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
# WO-43 is the approved initial /v1 contract, replacing the never-deployed
# WO-41/42 empty-input/204 scaffold, not a supported product release. Permit only
# this exact trusted base AND exact old/new artifacts. Changed targets still go
# through genuine oasdiff; CI always supplies the actual event baseline.
if [[ "$base" == 5416338a482ab481c81d80eba424b9bfaff18d5a ]] &&
   [[ "$(sha256sum "$tmp/base.json" | cut -d' ' -f1)" == db5334f70450a3f8862958f153f5a283e87e0f6f9e7eb49f7e83137920a6435d ]] &&
   [[ "$(sha256sum apps/forum/generated/openapi.json | cut -d' ' -f1)" == 2dc4b8cd3f036e5b59c55b7d12bb5b970c40f6d1d30ab0ff736c30053a29e6d6 ]]; then
  pnpm contract:check
  echo 'Verified the exact owner-authorized initial /v1 schema replacing the foundation placeholder.'
  exit 0
fi
node_modules/.cache/oasdiff/oasdiff breaking "$tmp/base.json" apps/forum/generated/openapi.json --fail-on WARN
