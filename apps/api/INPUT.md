# Shared business input boundary (WO-12)

This is reusable transport infrastructure, not public registration, publication
or search implementation. The production Worker still advertises only health
and shared discovery routes. WO-10/13/14 must supply real domain schemas,
authentication/services and handlers, integrate these primitives with Effect
HttpApi and its outer declared-error normalizer, update OpenAPI/discovery before
exposure, and prove actual GET/POST behavior. Fixture callbacks here establish
transport safety, not database writes or the integrated agent loop.

## Decisions and usage

WO-9's decision thread records the owner's technical delegation, selected
invariants, review and instruction to implement. Blueprint text suggestions
remain platform-pending; they are not represented as accepted edits. Requirements
are unchanged. No paid service, deployment or public activation is introduced.

`InputTransport` is a pure Layer-provided Effect service. `decode` takes the
native Request, one of the three existing operation names and its Effect Schema.
GET uses a single `payload` parameter containing the same UTF-8 JSON document
as canonical POST. Percent encoding is decoded once, strictly; unknown/duplicate
transport parameters and POST query payloads are rejected. Credentials belong
only in Authorization Bearer headers, never in payload/query/cookies. The
credential helper returns a Redacted Option; it does not verify the key or
require authentication on registration/public reads. Malformed supplied Bearer
headers produce a declared 401 challenge; domain owners verify actual keys.

`runOperation` supplies the transport Layer only after safe-method handling:
HEAD is bodyless and OPTIONS returns 204 without acquiring services or invoking
handlers. GET/POST share validation and the caller's Effect context. The adapter
returns safe declared input problems; arbitrary typed domain failures remain
in their original error channel for the endpoint's declared mapping. It does
not spawn a runtime, detach a fiber, log input or consume database resources.
No-store/private and CORS headers apply to adapter-produced responses. Endpoint
owners must also apply the established outer Worker headers/error boundary.
Do not provide database/domain Layers outside this safe-method boundary.

## Exact budgets and JSON compatibility

- GET: at most 14,336 UTF-8 bytes of the complete encoded absolute Request URL,
  including scheme/host/path/query. Worker-generated oversize problems identify
  this limit and direct clients to canonical POST.
- Client JSON document: at most 65,536 UTF-8 bytes after GET transport decoding
  or from POST's bounded UTF-8 stream, before JSON normalization or server facts.
  Submitted JSON whitespace/escapes count. An equivalent document has the same
  budget in either transport; GET's independent smaller encoded cap still applies.
- Metadata: at most 16,384 UTF-8 bytes of the original lexical JSON object,
  including internal whitespace/escapes. Preserve arbitrary keys/types, including
  prototype-shaped property names, without interpreting them or assigning type.
- Existing metadata limits: container depth 8 (root 1), 64 keys/items per
  collection, 256 value nodes including root/containers but not keys, 4,096-byte
  string scalars and 128-byte keys. The source scanner enforces these before
  Schema decoding or database access. No YAML/frontmatter processing.

The source scanner rejects malformed JSON, duplicate decoded keys at every
level, NUL/isolated surrogates, nonfinite values and numeric lexemes whose
mathematical decimal value would change on JavaScript decode/re-encoding.
Equivalent spellings such as 1/1.0/1e0 are accepted. It checks source positions
before JSON.parse can lose duplicates or lexical byte information. Metadata
identity validation avoids rebuilding arbitrary-key Records and preserves
`__proto__` as inert own JSON data. This is an internal bounded scanner rather
than a new parser dependency or a replacement Effect Schema model.

POST requires application/json, optional UTF-8 charset and identity content
encoding. Incremental fatal UTF-8 decoding handles split multibyte sequences.
Body readers are canceled/released on success, failure, request abort and Effect
interruption; input is never drained with an unbounded text/json call. Native
socket disconnect propagation and provider behavior are separately verified;
this does not claim whole-isolate termination cleanup.

## Contract and evidence boundaries

`contract:generate` emits both unchanged public `openapi.json` and standalone
`input-schemas.json` from the actual Effect schemas. `contract:check` checks
source parity. Reusable schemas are not advertised endpoint support, and JSON
Schema alone does not express lexical source budgets, duplicate keys or all
runtime structure/numeric checks. Those remain tested boundary invariants.

Workerd tests exercise exact limits, Unicode/percent encoding, duplicate/invalid
input, metadata structure and arbitrary keys, redaction, bounded stream cleanup,
interruption, safe methods and preserved typed domain errors/context. Full
PostgreSQL tests remain regression coverage, not transport-to-domain integration.

Cloudflare may reject large URLs before invoking Worker code. Such provider
responses are outside this adapter's control; no local test establishes their
media type or actionable guidance. Delivery/deployed verification owns those
observations. No claim of full business-operation or deployed acceptance follows
from the fixture tests or a successful schema generation.
