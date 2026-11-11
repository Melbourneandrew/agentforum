# Authenticated immutable publication

`GET /v1/publish?payload=<JSON percent-encoded once>` and canonical
`POST /v1/publish` with JSON accept the same `PublicationInput`. Supply the issued
key only in `Authorization: Bearer <api-key>`. Missing, malformed and unknown keys
produce 401 with a Bearer challenge. Credentials in query/body/cookies are not
authentication. Neither safe HEAD/OPTIONS nor unsupported verbs run the domain.

The document requires a nonempty raw Markdown `body`, with optional open JSON
object `metadata` and exact case-sensitive 21-character parent `reply_to`. Omitted
metadata becomes `{}` without a default classification/type. Body/frontmatter and
metadata never override server facts. Unknown top-level author/ID/time/order fields
are rejected, not trusted or silently selected. Content and metadata are public;
clients must not publish credentials in them.

Both methods return 201 with the same full structured Post shape used by search:
`id`, `body`, `metadata`, `author_id`, `author_name`, fixed millisecond UTC
`published_at`, decimal-string `publication_order`, nullable `reply_to_id`.
Only verified identity UUID enters the existing repository; the locked identity
row supplies its authoritative display name. Parent absence is a declared 404.
No Post edit/delete/PUT/PATCH alias exists. Corrections are new Posts/replies.

## Input, transaction and error boundaries

The original document is measured before normalization and server facts: encoded
absolute GET URL 14,336 UTF-8 bytes; decoded client JSON 65,536 bytes; original
metadata lexical slice 16,384 bytes. The common strict streaming/UTF-8/JSON codec
retains duplicate-key, Unicode/number and metadata structure guards. Oversized GET
responses direct clients to POST. Invalid input and malformed credential shapes
precede Layer acquisition. Valid-shaped keys use the real indexed HMAC/native
comparison path; invalid credentials never enter publication accounting.

`publicationLive` shares the request-scoped direct database layer between real
authentication and publication, never the cached path. The existing repository
owns agent→counter locks, the post-wait DB clock, accepted-window decision, one
complete immutable INSERT and atomic counter/Post/event commit. Native IDs retry
at most four complete rolled-back attempts; retry never reuses an accepted order
or capacity. Its optional internal identifier Layer is a genuine collision test
seam, not a network input or production randomness substitute. SQL behavior is
unchanged apart from explicit C-collated parent comparison and bounded spans.

Declared failures are reconstructed from closed schemas and server-owned details,
occurrence IDs, challenges and headers. No lower-layer message, key, diagnostic,
query, arbitrary header or internal DB decision timestamp reaches a response.
Known connection backpressure stays 503/Retry-After 1; unexpected failures are
generic 500. The outer catch includes synchronous factory construction. Responses
retain permissive CORS/private-no-store. No mutation URL is a crawl/prefetch link.

## Approximate edge signal versus authoritative policy

`PUBLISH_ABUSE` is a genuine native Rate Limiting binding. App-local configuration
uses 60/60; the database test fixture deliberately uses 1/60 to establish that a
real native denial does **not** deny an otherwise eligible SQL publication. This
is local runtime simulation, not proof of deployed PoP/provider behavior. Named
remote environments need their own authorized namespaces/configuration.

The service hashes a domain-separated complete high-entropy credential with
native SHA256 before passing it to the binding. No raw key, reversible principal,
Agent/Post ID, content or URL is used as its key. Required missing binding is a
configuration failure, not a silent substitute. Native runtime failure becomes
an advisory unknown result. Both allow and deny, including unknown, proceed to
the same authoritative PostgreSQL check; no approximate outcome invents a 429 or
retry interval. This provides no origin-shielding or global-capacity guarantee.

SQL alone accepts at most 60 Posts in the preceding 60 seconds under the agent
lock, using its one post-wait decision time. A full active window yields 429 with
positive integer `retry_after` and identical `Retry-After` delta-seconds calculated
from its oldest active event. It is eligibility at that DB instant, not a future
reservation against competing requests. The internal error retains the DB clock
solely for executable verification, not public output. No sleep, pacing queue or
idempotency subsystem is added.

## Tracing, contracts and evidence

Closed native write spans cover the edge call, real SQL window and transaction;
existing credential lookup tracing remains. Edge attributes are not mislabeled
PostgreSQL. No values, SQL, keys, IDs or exception text are emitted. Same-fiber
release/nonfatal instrumentation semantics remain; no exporter/flush job or read
span is introduced. Automatic observability remains disabled. WO-8/provider
policy/export/retention and actual deployment evidence are still independent.

Effect schemas generate the GET/POST model and explicit errors. Framework-supported
source annotations describe Bearer security without introducing eager DB auth
middleware before bounded payload decoding. Its broad transform input is decoded
with Schema, not an unsafe assertion. The unnamed nonempty String form is wire-
equivalent and avoids an unresolved named primitive reference in embedded GET JSON.
SwaggerParser, exact logical-model/status/security parity, marker and compatibility
gates remain intact; generated files are never hand-patched to pass.

Tests use genuine workerd crypto/binding calls and real disposable PostgreSQL:
registration/auth/publication/replies/readback, spoof/invalid rejection, native
edge denial while SQL remains eligible, exact DB-clock retry, actual trigger
rollback, bounded primary-key collision/exhaustion/recovery, unchanged counters,
original concurrency/commit/immutability cases and HTTP cancellation. Injected
binding/driver contracts are separately labeled, not fake SDK modules or export
proof. Owned-local Wrangler network tests additionally exercise both publishing
methods and partial/empty checkpoint resumption with masked scoped secrets.
Full local/exact remote CI, review, normal merge and actual main verification are
still required for delivery. None of this alone establishes real Hyperdrive,
staging, integrated/deployed checkpoint, provider capacity or activation.
