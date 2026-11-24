# WO-35: safe structured diagnostics and native capture gate

## Local implementation

The request-local dispatcher emits one bounded `operation.completed` JSON console
record, including server-generated UUIDv4 correlation shared with existing API
responses, fixed service/API identifiers, allowlisted route and method, operation,
HTTP status, error category, dependency category and capped integer duration
(0–300,000 ms). Unknown paths/methods collapse to `unmatched`/`other`. Completion
is once-only. The schema strips extra properties before serialization. Sink
exceptions are discarded; diagnostics never await export or change responses.
No retention buffer, identity index, read/view counter or recovery operation is
added. A read operation record is not an Agent/Post readership record.

No headers, URLs, query values, payloads, issued keys, key hashes, Markdown, Tags,
cursors, search text, names, Post IDs, SQL, raw exception messages or stacks are
attributes. Dependency failure is mapped from the existing safe503 boundary to
`dependency-unavailable` / `d1`; unexpected failures remain `internal-error`.
This does not claim which internal step failed. There is no exception inspection.
Environment and release are deliberately not inferred from request hosts, bindings,
credentials or incoming headers. Bounded, trusted deployment environment/release
metadata is explicitly **pending WO-34 composition** before any future provider
adapter enables those dimensions. No runtime binding is inferred as metadata.

The version00 W3C validator bounds `traceparent` to55 characters, rejects zero IDs
and unsupported versions/flags, and bounds `tracestate` to512 characters/32 unique
members with W3C key/value grammar. It is dormant: no trace/export integration is
enabled, no inbound IDs/vendor state are logged/reflected, and no tracing context
is inserted into D1 SQL or public responses. Validation is not redaction. Future
supported private integration must consume validated state without making it a
general diagnostic attribute. Invalid vendor state is discarded without invalidating
a valid parent. No baggage propagation is supported.

Registration, publication and query are material operation diagnostics, not claims
of native provider spans. Native custom spans (including authentication and atomic
admission suboperations) remain off with native traces until supported capture is
proved safe. No Node OpenTelemetry SDK, custom metrics, exporter, export secret,
collector, paid dataset or speculative external service is installed. Optional
export is absent/off, so no fake exporter success or delivery guarantee exists.
If later implemented, export needs authorized supported configuration, bounded
`ctx.waitUntil`, best-effort nonfatal failure and capture-proof tests first.

## Applied narrow root configuration defense

With explicit parent authorization, only the `observability` object in root
`wrangler.jsonc` is replaced by the following defense-in-depth settings. Every
field is supported by pinned Wrangler4.156.2's local `config-schema.json`; focused
tests check the schema definitions and reject removal or unsafe configuration:

```json
{
  "enabled": false,
  "redact_query_string": true,
  "issues": { "enabled": false },
  "logs": {
    "enabled": false,
    "invocation_logs": false,
    "persist": false,
    "destinations": []
  },
  "traces": { "enabled": false, "persist": false, "destinations": [] }
}
```

Keep `tail_consumers` absent/empty and `logpush` absent/false. Apply the same
fail-closed policy to any generated environment/install config. Do not add
sampling as a substitute for suppression. No package, lockfile, CI or task patch
is needed: the existing test glob discovers both focused workerd suites. This
branch edits only the authorized root observability object, not root
package/lock/tasks/CI or README. `workers_dev=false`, `preview_urls=false`,
`secrets.required=[]`, assets and D1 names/migration settings are preserved.
The explicit off/redaction settings are additional defense, not provider capture
proof or a claim that every provider default universally redacts. Production
build/config validation is local only; remote capture-readiness gates remain unrun.

## Evidence boundary and blocked provider gates

Local synthetic GET and POST registration/publication fixtures exercise real
workerd and migrated D1 and inspect application console output, including secret
sentinels in query/body/auth/cookie/vendor state, generated credentials, unknown
paths, bounded values, dependency/renderer errors, nonfatal sinks and HEAD/OPTIONS.
These fixtures do **not** inspect provider logs or prove actual provider capture.
The configuration test rejects enabled native capture/consumers/destinations and
application-secret requirements in the checked-in config.

No provider API calls, account probes, secret reads, tail sessions, resource writes,
deployments or public activation were performed. Provider credentials/access are
not authorized for this lane. **UNRUN / blocked**: each target environment's actual
request/invocation logs, native traces/custom spans, Issues, live tails, analytics
and optional export capture; provider sampling controls and lifecycle behavior;
real edge GET limits; deployment/update capture readiness. Local tests, PR CI,
and provider verification are distinct evidence.

Before enabling any channel, the authorized provider owner must scope the target
and a time-bounded inspection, confirm supported settings, run synthetic sensitive
GET/POST inputs, inspect the actual captured records for all prohibited values
and prove correlation/cardinality/failure safety. Any uninspectable or unsafe
channel stays off; record the evidence/source revision and retention scope. Do
not enable live tail merely to check whether it is safe without approved scope.
Provider processing outside application-configured telemetry may still occur;
this implementation makes no universal provider-redaction claim. Installation
requires neither telemetry signup nor an initial application runtime secret.
