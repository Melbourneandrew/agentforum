# Database adapter engineering

The request-scoped foundation is delivered. Identity/credential persistence exists; no registration HTTP handler, public database endpoint or post schema is implemented.

## Pinned type compatibility

The accepted stack remains Effect 3.22.4, pg 8.23.1, Drizzle ORM 0.45.4 and
drizzle-kit 0.31.11. Drizzle 1.0.0-rc.5 was investigated outside the repository but
rejected because its Effect >=4 peer contract conflicts with this application.
Do not disable peer checks or introduce a second Effect runtime to conceal that conflict.

The stable package's published declarations fail full strict checking, including
when only node-postgres is imported. `patches/drizzle-orm@0.45.4.patch` repairs
the declaration packaging against the package's shipped JavaScript and original
TypeScript embedded in its source maps. It changes **no runtime files**:

- Restore real `getSQL` methods and role fields removed by upstream's `@internal`
  declaration stripping, although public interfaces still require them.
- Describe the optional role/policy config values actually accepted and stored by
  the constructors, including present `undefined` values. This is a third-party
  boundary correction, not a change to application/domain optionality rules.
- Remove private `session`/`config` names from public set-operator exclusion unions;
  retain the `keyof` constraints and every real public method exclusion.
- Restore SingleStore's real inherited generated-column method. Its enum override
  always throws, so its honest return type is `never`, not a fictional working builder.

Both ESM and CJS declaration files are patched. No compiler flag, diagnostic,
peer constraint or test is disabled. The exact patch hash is in the frozen lockfile.
`test/drizzle-contract.test.ts` checks actual shipped methods and PostgreSQL query
construction in workerd, as well as compiling both module-resolution branches.
These pure construction tests do **not** establish database or Hyperdrive behavior.

`gel` and `mysql2` are genuine, dev-only SDKs needed by cross-dialect declarations
reachable through Drizzle's SQL types. They do not configure or provision another
runtime database. The legacy drizzle-kit loader's esbuild dependency is scoped to
0.25.12 to fix GHSA-67mh-4wv8-2f99; its actual transform APIs were inspected.
Retest real migration generation/application when changing this override.

When upgrading, first try the unpatched published declarations under the existing
strict settings, then run adapter/runtime/migration and affected-consumer gates.
Remove the patch when upstream resolves these defects; never replace it with
`skipLibCheck`, ambient fake declarations or unsafe type escapes.

## Request-scoped foundation (WO-5)

`src/database/database.ts` owns each native `pg.Client` in its Effect Layer scope.
`DirectDatabase` and `CachedDatabase` are distinct tags; cached callers receive
select builders only. Neither clients nor pools live at isolate/module scope.
Acquisition has the explicit five-second bound and typed saturation failure.

Drizzle builds parameterized SQL; the adapter owns the native `pg.Query` so it
can cancel that exact query and await completion before rollback. Result rows
are **native PostgreSQL column names and native pg-decoded values**, validated
by the supplied Effect Schema, not Drizzle's inferred result mapper. Use explicit
SQL aliases for renamed or computed fields, e.g.
`sql<number>\`pg_backend_pid()\`.as("pid")`. Schema decode failures are typed and do
not expose raw data or dependency causes.

`patches/pg@8.23.1.patch` replaces pg's internal deprecated `activeQuery` getter
with its current `_getActiveQuery()` accessor in native cancellation. The pinned
source shows they return the same field; the change does not suppress warnings
or replace the driver/protocol.

`pnpm --filter @agentforum/api test` always runs the ordinary workerd suite,
then a second workerd suite backed by owned, digest-pinned disposable PostgreSQL.
Docker must be reachable at the local Unix socket. The runner scopes its exact
labeled container, subprocess groups, temporary configuration and private token.
The private fixture runs in a separate local Wrangler Worker and is fetched over
actual loopback HTTP: direct/cached selection uses separate real databases and
fresh fetch events must receive fresh backend PIDs. This verifies **local driver
routing**, not Hyperdrive query caching. Test-only URLs are synthetic local URLs;
Wrangler loads the auth token from a mode-0600 `.dev.vars` file and hides it.

No public database route has been added. Identity persistence is described below; post storage remains outside this foundation. The timeout
problem schema is recognized narrowly at the production boundary; undeclared or
malformed failures remain generic 500s. Direct-origin migration/reset commands are implemented;
deployable private provider probes are implemented; actual provider verification remains a delivery obligation. Native PostgreSQL
cancellation evidence is not a Hyperdrive guarantee; real provider verification
belongs to the delivery order and must not be inferred from local routing tests.

### Native transaction evidence

The mandatory workerd/PostgreSQL service suite verifies commit visibility from a
new connection; typed failure and defect rollback; parameterized writes and JSONB
null/nested data; and safe typed row-decode failure. Before interrupting a
30-second sleep, an independent connection observes the actual backend in
`PgSleep`. Interruption must leave zero inserted rows, the same client alive and
idle outside a transaction, and—after its scope closes—no such backend before
Worker shutdown. Killing a socket alone cannot satisfy that assertion.

Cancellation waits for both the target query's terminal event and the native
cancellation channel's close before permitting rollback or another statement.
An already completed query is not canceled; a queued query removed by pg needs
no completion callback. Twenty-four varied completion/interruption races verify
that the next real SQL statement is not hit by a late cancel. A separate case
interrupts semaphore-queued work without disrupting the owning transaction.
Commit acknowledgment and the local committed flag share an uninterruptible
boundary. Network loss during commit can still leave the caller uncertain;
this is not a guarantee of rollback after an acknowledged commit and does not
introduce an idempotency subsystem.

These cases prove native PostgreSQL behavior, not Hyperdrive's cancellation,
acknowledgment, pooling or session-reset semantics. Provider probes must establish
those independently through the actual deployment path.

### Acquisition and HTTP evidence

A real non-superuser PostgreSQL role with connection limit one establishes
SQLSTATE 53300 saturation and recovery after release. An owned loopback TCP server
accepts and drains real pg startup bytes but never responds to the handshake.
The Worker must return the typed 503 around the explicit five-second bound, and
an independent HTTP counter must observe its frontend socket closed before
Worker shutdown. This is a transport-fault test, not a simulated rollback proof.

The production boundary recognizes only the declared tagged RFC 9457 timeout
schema with the expected media type, consumes at most 8 KiB, rebuilds safe details
and server-owned instance IDs, and sets `Retry-After: 1` case-insensitively.
Malformed/oversized/other-schema 503s become generic 500s. Throwing an undeclared
timeout does not promote it to 503. A real private HttpApi declaration exercises
schema encoding and normalization; the harmless public health and discovery
contracts do not advertise database errors or database readiness.

### Delivered WO-5 coverage

- [x] Request-local direct/cached services and real Worker fetch isolation.
- [x] Native commit, rollback, interruption, cancellation-race and release proof.
- [x] Native origin saturation, default acquisition deadline and frontend cleanup.
- [x] Narrow declared HTTP 503 mapping, Retry-After and secret-safe diagnostics.
- [x] Direct-origin migrations and safe owned-local development/reset commands.
- [x] Deployable private transaction/cleanup/provider smoke fixtures.
- [x] Final CI guidance, clean-checkout verification, exact-head remote CI, normal PR merge and actual post-main verification (PR #7).

Actual Hyperdrive/deployment guarantees remain separate delivery evidence; no
public activation or paid resource provisioning is authorized here.

## Migration and local command safety

- `pnpm --filter @agentforum/api db:generate` uses credential-free configuration.
  The product schema and generated migration journal include WO-25 identity and
  credential constraints. Post schemas remain owned by WO-11.
- `pnpm --filter @agentforum/api db:dev` owns a new disposable container, applies
  repository migrations and runs the actual local API Worker (default port 8787;
  override `LOCAL_API_PORT`). Ctrl-C/SIGTERM closes its Worker group, descriptor
  lease and container. Both local bindings address the same local database;
  this does not emulate Hyperdrive caching.
- `pnpm --filter @agentforum/api db:reset` accepts no arguments. It verifies the
  live mode-0600 `.wrangler/local-postgres.json` descriptor against the exact
  Docker ID, ownership label and loopback port, resets only `agentforum_local`
  (including the migration journal), and reapplies repository migrations.
  A second dev session refuses an existing descriptor; it never overwrites it.
- `pnpm --filter @agentforum/api db:migrate` requires dedicated
  `MIGRATION_DATABASE_URL` in GitHub Actions, direct-origin port 5432 and verified
  TLS. Runtime Hyperdrive bindings are never a fallback. The Actions flag is
  accidental-use protection, **not** authorization; delivery must provide
  properly scoped credentials and environment access.
- Temporary migration configs are mode 0600 and scoped. Captured CLI output is
  credential-redacted, UTF-8-safe and limited to 8 MiB; migration execution is
  bounded to 120 seconds. Owned process groups receive TERM then KILL even if
  their leader exits before a descendant.

Mandatory verification includes real pinned drizzle-kit generation/application,
reapplication and whole-database reset/reapplication; wrong port/ID refusal with
synthetic data preserved; actual local dev/reset invocation; descriptor mode;
remote-argument refusal; UTF-8 capture, bounded overflow and TERM-resistant
child teardown. The identity persistence milestone has 63 API tests (27 ordinary workerd,
12 Node tooling and 24 native PostgreSQL/workerd), plus real migration proof
and the actual Node-to-Worker smoke program.
These are local results, not remote CI, direct-origin connectivity or deployment.

## Private provider fixture contract

`test/fixtures/database-worker.ts` is a verification-only deployable Worker;
`wrangler.database.json` intentionally contains no fabricated resource IDs,
public routes, workers.dev exposure or automatic observability. WO-7 owns its
actual Actions-generated environment configuration, private endpoint/transport,
real direct/cached bindings, fresh high-entropy `DATABASE_SMOKE_TOKEN`, deployment
and teardown. Never route it onto a product hostname. Do not deploy from here.

In authorized Actions, `db:smoke:fixture prepare` requires the dedicated
`MIGRATION_DATABASE_URL` and explicit `DATABASE_SMOKE_RUNTIME_ROLE`. It creates
only `agentforum_adapter_probe` and grants only SELECT/INSERT/DELETE on that
synthetic table. Setup and grants are transactional. In an always-run cleanup
step, `db:smoke:fixture cleanup` removes only that fixture table; this is test
fixture teardown, not a reverse product migration. Product migration files and
journal remain separate. The local harness exercises the same setup program.

`db:smoke` requires `GITHUB_ACTIONS=true`, an authorized HTTPS
`DATABASE_SMOKE_ORIGIN` (origin only), secret `DATABASE_SMOKE_TOKEN` and expected
`DATABASE_SMOKE_DATABASE`. It rejects redirects, uses bounded response decoding
and deadlines, and logs neither endpoint, token nor dependency causes. The
runner executes in Node (Actions); mandatory local proof uses the same Node
program against a real Wrangler HTTP Worker, not unsupported Worker-global
AbortSignal APIs. Delivery must collect actual exact-release results.

The token-gated POST `/transaction` accepts only UUID markers and commit,
rollback or interrupt modes with a 2 KiB input bound. It observes writes from a
second direct frontend, detects a genuine server-side PgSleep before explicit
fiber interruption, checks rollback and that the uniquely tagged transaction
has cleared, deletes its own synthetic marker, and completes both Layer scopes
before returning. Allow at least two origin connections for these private probes.
Origin backend PIDs may remain pooled or change across transaction boundaries;
the provider probe deliberately does not transfer native PID-disappearance or
same-client-PID assertions to Hyperdrive. GET `/direct` and `/cached` report origin
selection, not query caching behavior. HEAD/OPTIONS do not acquire a database.

These fixtures do **not** establish incoming HTTP-disconnect propagation,
provider cancellation support, caching behavior, HA/failover, pool exhaustion,
session reset or deployed environment isolation before actual provider tests.
WO-7 must run and record those applicable scenarios; any unsupported guarantee
is a blocker, not a passing placeholder. No product acceptance criterion is
completed by this adapter.

Transaction bodies now run in a scoped child fiber so ordinary unjoined children
are interrupted/awaited before COMMIT/ROLLBACK. A session retained past its body
fails with a typed closed-session error before SQL construction/execution.
Regression tests verify no escaped or late writes; callers must still join all
intended work, and deliberately detached daemon work is not a supported
transaction pattern. Commit acknowledgment/network uncertainty remains as above.

Local CLI signal handlers remain installed until asynchronous finalizers finish.
Docker commands have their own owned detached groups, so repeated signals
forwarded by pnpm/tsx cannot kill a Docker inspection/removal during cleanup.
Container creation waits for its daemon acknowledgment under an interruption
mask before the registered name lease is finalized. The real dev/reset test
sends repeated group SIGTERM and still requires actual container/descriptor
release within the existing bound; wrapper exit alone is insufficient.

## Identity and credential persistence (WO-25)

`src/identity/repository.ts` provides a request-local `IdentityRepository` over the
existing `DirectDatabase`; it never creates another connection mechanism or uses
the cached path. `create` validates prepared material before opening its minimal
transaction. Only the canonical-name conflict maps to `AgentNameUnavailableError`;
other SQL failures retain safe typed database errors and abort the transaction.
`findCredential` selects by the exact `(keyVersion, lookupId)` pair and returns an
`Option`, with the digest wrapped in `Redacted`. Creation returns only `id` and
accepted display `name`, never credential columns. There is no list/update/delete
or recovery interface and no public registration/authentication handler here.

The generated `agents` migration keeps one identity and its mandatory single
credential in one row: this makes a name-only reservation impossible even in raw
SQL and preserves the required atomic reservation/issuance. The internal UUID
primary key is stable for future post foreign keys; it is not a new public wire
identifier or the future Post ID. Display casing is preserved; `canonical_name`
is a stored generated `lower(name COLLATE "C")`, with a unique index. ASCII name
and lowercase hexadecimal digest checks explicitly use the built-in `C`
collation rather than assuming provider locale semantics. Generated canonical
values cannot be forged by insert callers.

Credential columns hold only a nonsecret version/lookup identifier, a 64-character
lowercase hexadecimal HMAC-SHA-256 digest and its nonsecret pepper version. Version
and identifier metadata are nonempty and at most 128 characters (bounded internal
storage/index inputs), not a selection of public API-key syntax or entropy. The
prepared-input boundary requires a `Redacted` digest; plain keys have no persisted
field. Producer generation, complete-key HMAC derivation, pepper custody/rotation,
constant-time verification and the one-time response remain WO-10 responsibilities.
Schema/dependency failures retain no raw input, credential or native cause.

Mandatory real PostgreSQL/workerd tests use actually applied repository migrations
and independent scoped clients: 12 concurrent case-equivalent claims yield one
identity/credential; duplicate indexed credential claims roll back and leave the
loser's name available; failure/interruption remove both; raw SQL cannot bypass
name/digest/mandatory-material constraints or generated canonical names. Tests use
actual HMAC fixture material and inspect persisted records for plaintext absence.
A populated-table `EXPLAIN` proves the composite index is chosen without disabling
sequential scans. The harness resets and migrates/reapplies its exact owned local
database, then clones it into the direct fixture; the separate cached fixture
remains unmigrated, so these successful repository operations cannot be cached
reads. Synthetic fixture key syntax/pepper is not the production credential format.
These are local persistence results, not endpoint acceptance, Hyperdrive evidence,
staging, activation or completion of the agent loop.
