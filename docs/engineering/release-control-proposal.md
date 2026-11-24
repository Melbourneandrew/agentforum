> Approval update: the owner explicitly approved the frozen10b7437 D1 control,
> operational history/bootstrap and fail-closed lifecycle mechanism. This packet
> is retained as its historical exact design reference. Section6 WO35 metadata
> remains NOT APPROVED / NOT APPLIED. Current implementation/evidence/limits are
> described in [release-lifecycle.md](release-lifecycle.md).

# WO-34 exact control and composition proposal — NOT APPROVED / NOT APPLIED

Parent review packet, based on verified main
`3e6953f502a9d90c60cf6270fe37081d05f31b28` (Docs32 + WO35 + WO33).
This file is a proposal, not a migration, runtime patch, authorized provider
handoff, completed root entry, or readiness receipt. No requirement/ADR changes.

## 1. Recommended bootstrap and exact DDL

One non-expiring exclusive operational row in the existing installation D1.
No new service, public endpoint/business field, runtime secret, owner account,
heartbeat, TTL, automatic takeover, reset, recreation or reverse migration.

**Proposed SQL file, not created:**
`scripts/delivery/control-migrations/0001_release_control.sql`:

```sql
CREATE TABLE IF NOT EXISTS agentforum_release_control (
  slot INTEGER PRIMARY KEY CHECK (slot = 1),
  protocol INTEGER NOT NULL CHECK (protocol >= 1),
  account_id TEXT NOT NULL,
  database_id TEXT NOT NULL,
  worker_name TEXT NOT NULL,
  default_origin TEXT NOT NULL,
  generation INTEGER NOT NULL
    CHECK (generation BETWEEN 1 AND 9007199254740991),
  phase TEXT NOT NULL CHECK (phase IN ('idle', 'held', 'uncertain')),
  owner_id TEXT,
  executor_ref TEXT,
  source_revision TEXT NOT NULL,
  artifact_sha256 TEXT NOT NULL,
  effect_seq INTEGER NOT NULL DEFAULT 0
    CHECK (effect_seq BETWEEN 0 AND 9007199254740991),
  effect_kind TEXT NOT NULL DEFAULT 'none'
    CHECK (effect_kind IN ('none', 'control-migrate', 'business-migrate', 'activate')),
  effect_state TEXT NOT NULL DEFAULT 'none'
    CHECK (effect_state IN ('none', 'intent', 'acked', 'unknown')),
  effect_ref TEXT,
  effect_receipt_json TEXT,
  last_release_receipt_json TEXT,
  reconciliation_sha256 TEXT,
  CHECK (
    (phase = 'idle' AND owner_id IS NULL AND executor_ref IS NULL)
    OR
    (phase IN ('held', 'uncertain') AND owner_id IS NOT NULL AND executor_ref IS NOT NULL)
  ),
  CHECK (
    (effect_kind = 'none' AND effect_state = 'none' AND effect_ref IS NULL)
    OR (effect_kind <> 'none' AND effect_state <> 'none')
  ),
  CHECK (phase <> 'idle' OR effect_state = 'none'),
  CHECK (effect_state <> 'unknown' OR phase = 'uncertain')
);
```

No seeded row. Effect Schema additionally bounds/validates IDs, UUIDs, hashes,
executor references, and receipt DTOs. Receipt JSON contains only operational
source/manifest/version/outcome identifiers, never tokens, SQL, keys or payloads.
The owner nonce is not an authentication credential. Generation/sequence are
CAS/ABA protection, **not fencing for external Worker uploads**.

## 2. Native migration contract and cold-bootstrap exception

Appending this table to the business chain would apply business migrations before
ownership on an empty D1. Pre-applying a suffix of that chain violates its order.
Neither is selected. Recommend a separate **operational-only native Wrangler
stream** in the same DB, history table `agentforum_release_migrations`.

- Only Wrangler applies its SQL/history, with binding `DB` and exact retained UUID.
  Business migrations stay exclusively in `apps/forum/migrations`, with
  `d1_migrations`; Drizzle business schema/journal/snapshots are untouched.
- Derive a purpose-tagged temporary bootstrap view from the complete target,
  changing only DB `migrations_dir` and `migrations_table`. The directory contains
  byte-identical canonical `0001_release_control.sql`, not a separately authored
  DDL copy. Never use this view to activate a Worker. Keep the main target's current
  rejection of arbitrary alternate history layouts; authorize only this internal
  purpose-specific derivation after validating the complete target.
- The only pre-acquisition write exception is frozen, idempotent v1 operational
  schema/native-history initialization. No owner/business rows or app migrations
  are written. Normal updates with verified bootstrap skip its writes entirely.
- Verify existing schema before bootstrap if present and exact committed schema/
  history afterward. `IF NOT EXISTS` must not hide an incompatible existing table.
  Wrong/partial/unknown schema fails closed, without replacement or deletion.
- Pinned Wrangler4.156.2 `getCreateMigrationsTableQuery` gives migration names a
  UNIQUE constraint; `buildMigrationQuery` appends the native history insertion.
  Racing bootstrap can get duplicate-history failure. Verify actual D1 transactional
  rollback/unique-history behavior; a process exit code is not sufficient proof.
- An ambiguous bootstrap stops that candidate; do not call the request quiescent
  because schema is visible. There is not yet an acquired ownership row to retain.
  Other candidates may only perform the same frozen convergent bootstrap, never
  app effects. Allowing that bounded bootstrap overlap is an **explicit part of
  this approval request**, not a general unknown-mutation retry permission.
- Bootstrap forever selects only frozen v1. Later operational migrations append
  immutable files, execute only AFTER acquisition using a compatible existing
  protocol, and require their own reviewed additive/compatibility coverage.
  Unsupported protocol stops. No future destructive rebuild is pre-authorized.

The existing safety reader hardcodes the business/Drizzle layout. Proposed bounded
extension: recognize a separate strict flat operational layout, enforce trusted-
base filename/order/byte preservation and native parser/authorizer replay, and
restrict the operational namespace. Do not weaken the current business rules,
add arbitrary execute-SQL migration logic, insert history manually, or claim the
current gate already validates an absent stream. This adds a second operational
migration directory/history, **not a second business migration engine**; parent
must explicitly accept that bootstrap trade-off.

## 3. Ordering and ownership transitions

1. Local entry admission, scope/authorization context and exact input validation;
   no credential accessor/provider construction yet.
2. Pure clean-source build and complete Worker/assets/contracts/migration checks
   may parallelize. Failed build prevents bootstrap. Consume actual current root
   capture/security fields, not a historical replacement object.
3. Only after genuinely authorized admission: obtain scoped credentials through
   the explicit adapter and verify exact provider account/Worker/DB associations.
4. Verify/perform the bounded bootstrap; atomically acquire/acknowledge ownership.
5. Under ownership recheck artifact/bindings/installed state; apply approved
   control upgrades, then ordered native business migrations; verify history.
6. Reverify artifact; activate; validate terminal receipt; read-only readiness;
   persist outcome and conditionally close ownership. Closure is not readiness.

| Transition                    | Exact condition                                                                                                                                                                                |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Absent -> held                | INSERT slot1 with exact binding tuple, fresh owner UUID, executor reference, source/artifact; conflict cannot replace the row.                                                                 |
| Idle -> held                  | UPDATE matching idle, binding tuple, supported protocol and observed generation; increment generation, set fresh owner and effect none.                                                        |
| Held -> intent                | CAS owner/generation/previous sequence/state; increment effect sequence and durably record effect kind/descriptor. Dispatch only after exact intent acknowledgement.                           |
| Intent -> acked               | Validate terminal receipt for this exact owner/effect/account/DB/Worker/source/artifact before another effect can arm.                                                                         |
| Ambiguous effect -> uncertain | Retain owner/generation/sequence/descriptor; provider operation ref may remain absent. No automatic mutating retries.                                                                          |
| Safe closure -> idle          | All effects terminal, no further dispatch possible, durable outcome receipt, CAS exact owner/generation/sequence. Clear active effect/owner, retain binding identity and last release receipt. |

A crash may leave held/intent: still blocked, not a free lock. Lost acquisition
response permits no app effect until the SAME invocation verifies its exact nonce
and generation. A failed contender performs no business SQL/upload. Delayed
conditional acquisition/release must not clear a newer generation. No reset of
sequence/generation to manufacture ownership. Overflow fails closed.

Current `ReleaseSession.close(): Effect<void>` needs typed failure: closure
persistence failure cannot disappear. Build/known readiness failure with ALL
remote effects terminal may close safely and report NOT READY. Ambiguous mutation
failure/crash retains ownership. Current build-inside-acquisition can be split
into pure prebuild and protected apply without relaxing re-verification.

## 4. Reconciliation is evidence, never a confirmation flag

Both are required:

- **Q-executor:** verified exact old executor and descendants/retry machinery are
  terminal and cannot dispatch another effect. Build cancellation requested or a
  PID without invocation/start/supervisor identity is insufficient.
- **Q-effect:** every outstanding dispatched mutation is terminal and its DB
  history or Worker version/bindings is reconciled. Executor death does NOT prove
  that a submitted native subprocess HTTP mutation has stopped remotely.

Potential evidence: authoritative terminal build/supervisor state plus operation-
completion/cancellation receipts and resulting-state verification for the exact
installation/effect. An armed intent with no provider ref is NOT proof of no send.
A compliant durable `none` state plus proven executor termination can establish
no armed effect; intent/unknown cannot use that inference.

Insufficient: `--confirm-quiescent`, elapsed time, quiet logs/heartbeat gap, one
unchanged history/version snapshot, missing operation ID, cancellation merely
requested, or a user-authored JSON boolean/digest. A digest records validated
evidence; it does not validate itself. No unsigned arbitrary evidence-file
"authorization" replaces a real supported execution/observation boundary.

A reconciler may quarantine the matching stuck row but cannot become release
owner. Only validated Q-executor AND Q-effect allow CAS of the unchanged old
owner/generation/sequence to idle, recording evidence digest. New release then
acquires normally. Unknown terminality remains blocked indefinitely. Whether
Cloudflare exposes adequate terminal evidence for a lost upload/migration response
is still unproved WO37 scope; this proposal cannot promise eventual recovery.

## 5. Identity, authorization and actual root entries

Permanent single slot identity: account ID + DB UUID + Worker name + default
origin. DB label is provider-checked metadata, not a lock key; another Worker cannot
claim the same DB by choosing another row. Reject duplicate/unresolved/conflicting
DB bindings, foreign association, account/Worker/default-origin mismatch, unsupported
protocol and unverified identity. Recheck before activation and validate its receipt.
No implicit Worker rename/rebinding/reprovisioning to escape a failure.

Native consumes provider-resolved config and a genuinely supported validated
invocation/account/origin/authorization handoff. CLI consumes resolved WO33 retained
identity plus scoped owner execution authorization. CI/WORKERS_CI/build UUID/token
presence alone proves none of that. Do not invent provider attestation or assume
Builds injects Wrangler's recognized variables with D1 grants.

Proposed shared aliases (NOT applied): `deploy` -> release-entry default;
`deploy:native` -> native adapter; `deploy:cli` -> CLI adapter;
`release:qualify:local` -> the local qualification. Default deploy admits native
ONLY through its proved supported handoff, otherwise exits before credentials,
HTTP or Wrangler. No blind --confirm. Dedicated local fixtures cannot enable remote
transport. Existing positive local qualifier is not that production entry.

Proposed Bootstrap step (NOT applied), after production smoke:
`pnpm exec tsx scripts/delivery/release-local.ts --qualify-local`.

## 6. Bounded WO35 metadata hunk — separately proposed, NOT applied

Actual WO35 `Diagnostic` accepts neither environment nor release today.
Proposed metadata value: `{ environment: 'local'|'preview'|'staging'|'production',
revision: <40 lowercase hex> }`. Sink keys: `deployment.environment.name` and
`service.version`. Both must be present together or both omitted.

Proposed touch points, only after parent/35 approval:

- `apps/forum/src/telemetry/diagnostics.ts`: schema for the bounded PAIR; validate
  separately supplied trusted composition input before adding it to the current
  fixed allowlist. Keep stripping all extra fields, one-record bound, status/
  duration policy and nonfatal sink. Request/caller diagnostic objects must not
  supply or override the trusted pair: compose it after base-field sanitization.
- `apps/forum/src/runtime/dispatch.ts`: optional immutable composition argument to
  `makeDispatcher`, default NONE; forward to `requestDiagnostics`. No route,
  request-layer, correlation, authentication or capture changes.
- `apps/forum/src/worker.ts` + bounded build-composition hook in
  `apps/forum/vite.config.mjs`: consume a build-embedded allowlisted value supplied
  only by the authorized delivery builder. Proposed virtual module
  `virtual:agentforum/deployment`; ordinary/unauthorized builds embed NONE.
  The build hook receives explicit validated nonsecret build context from that
  builder, NOT an inferred host, Request, binding, CI flag or ambient credential.
  The corresponding new virtual-module TypeScript declaration is also a proposed
  shared hunk, not an existing interface. Exact context transport is part of this still-unimplemented builder seam; do
  not silently invent a provider handoff or admit arbitrary input JSON as trusted.
- Focused telemetry/composition tests: hostile headers/hosts/bindings/caller fields
  cannot inject/override the pair; malformed/partial metadata -> NONE; valid
  authorized compiled pair is exact and source revision matches artifact; no
  change to capture off/redaction/retention/export; sink failures remain nonfatal.

This is an additive console-schema/composition proposal, not enabling native logs,
traces, Issues, persistence, destinations or export. Exact current root observability
object (including redact_query_string/issues/logs/traces/persist/destinations) and
all unknown complete-built fields remain intact. No runtime file has been changed
by WO34 for metadata. If the transport/composition seam is not accepted/proven,
metadata stays absent; do not label it wired from a safe-looking environment var.

## 7. Actual D1 and root-entry qualification plan

- Native D1 concurrent cold bootstrap/unique-history rollback; wrong pre-existing
  schema; empty/prior-version DB; bootstrap unknown stops before business effects.
- Contended native vs CLI acquisition: one winner, loser executes no business SQL
  or local activation; stale owner/generation/release and failed/unknown acquisition.
- Kill actual child executor before intent/after intent/after committed migration;
  retain ownership, data, keys and supported checkpoints. No inference of no send
  from missing operation ref.
- Delayed out-of-process mutation commits AFTER executor cancellation: reconcile
  refuses while outstanding; terminal evidence then permits one exact CAS closure.
  Test handlers execute real native D1, not callback-only successful mocks.
- Missing/forged/stale evidence, unknown remote state, cancellation merely requested
  and changed sequence all refuse. Local controlled-transport evidence is LOCAL,
  never Cloudflare eventual-completion/fencing proof.
- Actual root subprocess/native and CLI fixtures exercise distinct handoffs, complete
  generated config selection, native bootstrap/business migration commands, exact
  retained DB and built Worker restart. Denied root entry has ZERO credential
  accessor/provider adapter/subprocess access. Default no supported native handoff
  stays denied. Local transport must refuse non-loopback/remote operations.
- Preserve/extend current prior-version/FTS/index/constraint/bounded-backfill/failure/
  retry/key/checkpoint tests. Dedicated test config/safety/entry/shared hunks require
  approval before application; no production control migration exists yet.

Actual Docs32 path is `/docs/openapi.json` with server `/`, a same-origin contract
not a missing origin. `/docs/llms.txt` is a DOCS index, not the WO30 root guide.
Use current parent interfaces; never make UI/WO30 incomplete installation ready.
Readiness on a real owner installation performs only nonmutating GET/POST searches
and static reads. Registration/publication/retention proofs occur only in explicitly
authorized disposable WO37 scope (or isolated local disposable qualification).

## Approval boundary

Parent must review the exact DDL, operational-only native stream/bootstrap exception,
protocol/evidence boundary, focused D1/root tests and bounded safety/test/shared
hunks before they are implemented. WO35 metadata composition has its own proposed
hunk above, not an assumed permission. The requirement/ADR text is unchanged.
WO34/PR38 remain In Review/draft partial, not a human handoff or full lifecycle
acceptance; continue local implementation when the appropriate approval arrives.
