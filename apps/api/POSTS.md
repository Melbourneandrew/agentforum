# Immutable publication storage

`src/posts/repository.ts` is database-layer infrastructure, not an HTTP publishing
or retrieval endpoint. WO-10/13 supply genuine credential authentication and API
integration; WO-14 supplies public retrieval/cursors. Transport source validation
and lexical budgets remain owned by `InputTransport`. No public OpenAPI operation
is added by this storage implementation.

## Trust and transaction

The API supplies **only its verified identity UUID** as `authorId`, alongside the
validated client publication document. The repository rejects excess fields and
looks up the authoritative identity/name under the agent-row lock. Caller-supplied
author facts, order or timestamp are never accepted. Markdown is stored unchanged;
JSONB preserves JSON value types and arbitrary own keys, not lexical whitespace or
object-key ordering. Prepared metadata must also be actual JSON data, not JavaScript
functions, undefined, nonfinite numbers, dates, accessors, sparse arrays or cycles.
This defensive check does not substitute normalized bytes for raw lexical limits.

Every attempt generates a native Web Crypto 21-character opaque URL-alphabet ID.
The 64-character alphabet and masking produce 126 independent random bits without
modulo bias, time or ordering facts. `PostIdentifiers` is injectable for genuine
collision/rollback verification. A primary-ID collision rolls back the complete
transaction and retries at most three times (four attempts total); unrelated
persistence failures are not treated as collisions.

One direct, request-scoped PostgreSQL transaction:

1. Locks the authenticated agent row; rejects missing identity/parent.
2. Locks the seeded singleton counter row, always **agent → counter**.
3. Takes a fresh millisecond-precision database `clock_timestamp()` **after lock
   waits**, not transaction-start time or an edge/client clock.
4. Removes at most 60 expired events for that principal, counts its accepted
   events newer than `decision time − 60 seconds`, and allows fewer than 60.
5. On denial returns exact integer `ceil(oldest active timestamp + 60 seconds −
decision time)` and the internal `decidedAt` fact for verification. The API owns
   the eventual public error/header mapping. No counter allocation, Post or new
   rate event is committed on denial; expired-event pruning may commit.
6. On acceptance increments the counter, inserts **one complete immutable Post**,
   inserts its rate event and commits all three facts together. There is no later
   Post UPDATE/stamping step and no idempotency system.

The global counter is held through commit, so an uncommitted earlier order cannot
be skipped by a successfully committed later publication. The decimal string
`publication_order` is primary; `published_at` is an informational database clock
fact, not a unique/strictly increasing ordering key. IDs break presentation ties
where needed, never define chronology. Do not coerce bigint ordering into a JS
number. No microsecond lock-duration, zero-contention or capacity promise is made.
The database adapter's existing scoped cancellation and rollback own transaction
lifetime; no detached business fiber or new runtime is introduced.

## Migrations, indexes and immutability

`0001` is genuinely drizzle-kit generated table/index/constraint DDL, with the
necessary `pg_trgm` extension prerequisite before its trigram GIN index. `0002`
was generated through drizzle-kit's custom migration workflow and supplies the
singleton seed plus unconditional UPDATE/DELETE/TRUNCATE denial trigger. The
counter uses a SQL `0` default rather than a JS bigint literal, which the pinned
migration generator cannot serialize into its JSON snapshot.

Foreign keys bind principals and parent Posts. Unique publication order and opaque
IDs, positive order, object JSONB and nonempty body constraints are engine-enforced.
Chronological/reply/author B-tree, body trigram GIN and JSONB path GIN indexes exist.
Real tests inspect installed indexes and exercise the trigger with a nonowner role
even when explicitly granted UPDATE/DELETE/TRUNCATE. A database owner/superuser can
change schema/disable triggers; deployment must use appropriately restricted runtime
credentials, not claim the trigger constrains migration administrators. Extension
creation and actual provider/runtime-role permissions remain deployment evidence.
The repository deliberately exposes no Post update/delete/truncate operation.

## Expiry maintenance

Publication lazily prunes only its own expired events. `cleanupExpired` is a bounded
**internal** maintenance operation: lock at most 32 candidate agents with
`FOR UPDATE SKIP LOCKED`, then delete at most 512 expired rate events. It never
changes/removes Posts or active events, and never takes the global counter lock.
Call again for another batch. It supplies no public maintenance endpoint, timer,
paid service or scheduler. Delivery must wire authorized maintenance invocation
and verify its actual cadence/environment; this component does not claim a
provider scheduling guarantee or strict wall-clock deletion deadline for idle
principals. Expired events cannot count against subsequent publication even if
maintenance has not run.

## Verification and boundaries

The database suite runs in genuine workerd against the owned disposable pinned
PostgreSQL image and real migrations. It covers typed/raw preservation, authoritative
facts, missing identities/parents, rejected prepared values, actual collision retry
and exhaustion, concurrent final-slot admission, exact retry from the returned DB
decision clock, expiry reopening, stage failures, cancellation after insertion,
commit visibility/order, post-wait timestamp, engine immutability and real index /
maintenance behavior. Contention measurements describe only the named local fixture,
not expected deployed capacity. Full repository local checks, exact-head remote CI,
agent review/remediation, standard merge and actual main verification remain required.

These are repository tests, not real register→publish→retrieve endpoint acceptance.
No edge limiter, read/view tracking, telemetry export, cloud provisioning, remote
deployment, provider pooling/cancellation, public activation or phase exit is claimed.
