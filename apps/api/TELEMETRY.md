# Operational tracing boundary

## Delivered non-read foundation (WO-8)

`OperationalTracing` encapsulates the genuine Workers native tracing API. The
existing identity repository wraps `create` and `findCredential` with
`identity.insert` and `credential.lookup` spans. These are implemented material
persistence/authentication dependencies, not invented endpoint spans. HTTP
registration/authentication remain WO-10/12. No public Post/Agent read is
instrumented, and no successful request/view log or metrics dimension is added.

The operation vocabulary is closed and runtime-validated. Attributes contain
only the fixed API service name, PostgreSQL category, INSERT/SELECT operation,
fixed operation name and success/failure/interrupted outcome. No SQL, inputs,
results, names, IDs, keys, digests, connection strings, cursor values, arbitrary
error types/messages or stacks reach these spans. Request/environment/release
resource metadata and trace/log correlation are not invented here; their
actual native configuration/integration remains part of WO-8 delivery.

`startSpan` creates a manual operation span under the current native context;
it does not create a second HTTP request span or make a new span active for
nested operations. Do not claim this supplies automatic SQL-child nesting.
`acquireUseRelease` keeps the same Effect fiber, services and transaction scope,
ends each acquired span on success, failure, defect and interruption, and never
reruns the domain operation. Typed errors, results and original failure causes
are preserved. Synchronous instrumentation failures are best-effort and cannot
fail the domain operation. There is no separate Effect runtime, detached fiber,
network exporter, batch queue or flush task; therefore there is no invented
`waitUntil` job. Future actual async telemetry work must use the real execution
context and must not delay the response. Instrumentation overhead is not a
zero-latency guarantee or a whole-request termination guarantee.

## Genuine SDK types, not a replacement SDK

The pinned SDK's non-global `index.ts` exposes the authentic
`CloudflareWorkersModule` namespace but does not install the ambient native
module declaration. `src/cloudflare-workers.d.ts` forwards that complete
namespace unchanged to `cloudflare:workers`, avoiding duplicate global DOM
classes. No local native method signatures, runtime module, `any`, ignored type
error or `skipLibCheck` is introduced. Production and the workerd test use the
real native import. The injectable driver is our narrow lifecycle seam; method
argument types derive from the genuine `Span` type, and unused fluent returns
are ignored rather than requiring a fake implementation of the entire SDK.

## Activation and evidence gates remain open

`wrangler.jsonc` keeps observability, logs, invocation logs and traces disabled.
It enables query-string scrubbing defensively for future approved configuration;
this is not evidence of complete automatic-span redaction. Automatic native
spans collect request metadata. Query scrubbing does not prove that raw paths,
identifiers or public-read invocation records satisfy the no-read-tracking rule.
No account destination, OTLP endpoint, secret, service or remote resource is
created, selected or enabled by this milestone.

Before enabling collection, WO-8 still requires:

- Andrew's accepted interpretation reconciling operational public-read telemetry
  with Persistence ADR-006; pending suggestions or merge permission are not it.
- A supported, verified native request/path/identifier redaction and exclusion
  boundary; do not assume custom-span allowlists sanitize automatic spans.
- Environment sampling and the supported Cloudflare-native OTLP destination,
  coordinated with WO-23/7; no Node OpenTelemetry SDK or custom exporter/vendor.
- Verified W3C propagation and trace/log/resource correlation, real exported
  redaction, nonfatal destination failure and native metrics/inspection evidence.
- Evidence of production error/slow-trace retention policy. The pinned Wrangler
  schema exposes head sampling rates, not an outcome-based retention guarantee.
  Do not invent tail sampling or interpret spanContext traceFlags as sampling.

WO-8 is not Completed by this foundation PR. Provider/deployment limitations do
not stop this independent local implementation, but cannot be closed by mocks.

## Verification and safe inspection

Seven workerd cases execute actual disabled native start/attribute/status/end
calls and verify zero native IDs, then exercise our closed lifecycle contract
with an explicitly labeled driver recorder: unchanged results, original typed
errors/defects, interruption cleanup, one execution despite instrumentation
failure, and fixed attribute vocabulary. Recorder tests prove our seam only,
not platform sampling, propagation, capture or export. A Node config test checks
the actual activation boundary. Existing real PostgreSQL/workerd tests verify
repository concurrency, transaction rollback and cancellation remain unchanged.

After authorized deployment, use time-bounded Cloudflare MCP analytics/tail
inspection with redacted permitted fields only. Verify permissions and safe
fields before starting; do not request raw headers, queries, body contents or
unbounded exception streams. Stop sessions at their explicit deadline. Headless
`wrangler tail` is only the prescribed fallback with authorized credentials;
never change the telemetry boundary or use direct deployment to obtain evidence.
Actual destination/environment identifiers come from inventory, never examples.

Authoritative references:

- https://developers.cloudflare.com/workers/observability/traces/
- https://developers.cloudflare.com/workers/observability/traces/custom-spans/
- https://developers.cloudflare.com/workers/observability/traces/spans-and-attributes/
- https://developers.cloudflare.com/workers/observability/opentelemetry-export/
- https://developers.cloudflare.com/workers/wrangler/configuration/#observability
- Project Observability and Telemetry / Data Persistence ADRs and WO-8.
