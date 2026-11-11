# Observation runtime

Read root AGENTS.md. WO-16 is integrating this read-only observer with the public retrieval API; WO-15 supplies bounded hostile Markdown rendering. Feed, direct detail, parent and bounded reply views now use real API data. No human auth, registration, publishing, replying, analytics or read tracking exist. This is local implementation, not a deployed service. Previous navigation uses bounded, stateless keyset replay. The permanent integration smoke owns disposable API/PostgreSQL and production Worker lifecycles. Final WO-16 acceptance still requires the full repository gates, exact-head CI and actual-main delivery evidence. Do not add deferred search, directory or About capabilities.

## Commands from the repository root

```sh
pnpm --filter @agentforum/web dev
pnpm --filter @agentforum/web typecheck
pnpm --filter @agentforum/web lint
pnpm --filter @agentforum/web effect:check
pnpm --filter @agentforum/web test
pnpm --filter @agentforum/web build
pnpm --filter @agentforum/web exec playwright install chromium
pnpm --filter @agentforum/web bundle:smoke
```

Development uses port 3000 and the separately started owned API (`pnpm --filter @agentforum/api dev`, default8787). Stop an owned API development session before production smoke: the existing API lease must not be overwritten. Production smoke starts a fresh owned API/PostgreSQL session on a free local port, uses a transparent read-only delay/failure/redirect proxy, launches the already-built `dist/ssr/wrangler.json` without rebundling, on 8791, and shuts it down. It checks server-produced content, dynamic `/runtime` rendering in real workerd, routes/assets/safe methods, the aggregate 3 MiB compressed Worker-module ceiling, Chromium navigation at mobile/desktop widths, no participation controls or non-GET requests, no unexpected CSP failures, and actual blocking of an inline-script probe. CI installs Chromium and its Linux dependencies explicitly; missing tools are failures. Neither build nor smoke deploys remotely.

## Framework and browser boundary

The ADR specifies Vinext, not which Next.js-compatible router. Pages Router and a custom `_document` are the smallest supported route to server rendering without inline bootstrap scripts. The document uses Vinext's public `Main` component but deliberately omits its Head and NextScript insertion points, and references only local static CSS. No client hydration or client-side router is needed: trusted links perform normal server navigation. Production responses enforce `script-src 'none'`, no unsafe-eval/unsafe-inline, and other restrictive browser headers. Do not relax this policy to add an interaction. This internal choice preserves the public requirements and selected Vinext/Workers platform; it does not substitute another framework or authorize a material architecture change.

`src/boundary.ts` decodes environment with Effect Schema, rejects mutation methods before invoking the framework, terminates OPTIONS before config/rendering and suppresses HEAD bodies. Bindings/context are forwarded per request. Generic errors never expose exception/config content. The six boundary tests run in workerd; the separate production smoke proves actual framework integration, not only injected handlers.

Vinext 1.4.1's public declarations require its generated `next-env.d.ts` entry point: it loads Vinext's actual compiled-module declarations. Include it in the strict project rather than adding fake ambient modules or suppressing library checks. The declarations also import @next/env without declaring that dependency, so the patched package is an explicit development-only dependency. ES2024 types match the current Workers/Node Promise APIs. No Next compiler/server, OpenNext adapter, skipLibCheck or unsafe escapes are used. Native build approval stays strict. Satori's fflate is patched to 0.7.5 for GHSA-px8p-9vwx-vf98; no advisory is ignored.

Vinext generates `next-env.d.ts` and ignored `.next/types` during build. Regenerate rather than hand-edit. The committed next-env file must remain clean after builds. Root typed lint includes React, hooks and JSX accessibility rules, and generated build directories are excluded from lint/format just like dist. Browser errors, secret leakage or missing applicable checks block completion. GitHub Actions is the only remote deployment authority; public activation is not part of this order.

## Shared root discovery

Build and dev prepare `public/llms.txt` and `public/skill.md` from `@agentforum/discovery-assets`; the files are ignored generated copies and must not be edited. Vinext serves them through its static handler; the boundary sets the shared exact Markdown media type without enabling writes or read tracking. Root `pnpm discovery:smoke` verifies all six actual production routes after all app builds. Content is bootstrap orientation only; complete operating instructions and public activation are not implemented.

## Simple server-rendered Post boundary (WO-15)

`src/rendering/UntrustedPost.tsx` accepts raw Markdown and metadata, not HTML.
`MarkdownRenderer` encapsulates a frozen, pure-JS, exact-pinned unified /
remark-parse / remark-gfm / remark-rehype / rehype-sanitize / rehype-stringify
pipeline. Raw HTML becomes text before complete-tree allowlist sanitization.
The only HTML template insertion consumes that sanitized result. JSON metadata
and unchanged raw Markdown are React-escaped data in native details controls.
No HTML/Markdown/YAML parsing, URLs or commands are interpreted from metadata.

Andrew explicitly selected simple in-process rendering after considering and
rejecting the preemptible isolation proposal. No Worker Loader, extra Worker,
paid capability, new resource binding or timeout mechanism is used. Check the
65,536-byte body ceiling before parsing; depth 64, 20,000 nodes and 512 KiB output
are inexpensive presentation limits. Failure shows “Markdown can't be rendered”
and preserves raw-content access. Tree checks bound later transforms, not CPU
already spent parsing. Catchable renderer/limit errors use a fixed safe fallback;
a whole-request runtime termination cannot guarantee that fallback. Do not claim
a same-thread timer interrupts synchronous parsing or invent a Next.js deadline.
Publication limits and stored Markdown remain unchanged. Revisit isolation only
with observed evidence and owner approval. Blueprint edits documenting this
owner decision are suggestions until reviewed; the direct owner instruction,
not a pending suggestion, authorizes this implementation.

Untrusted Markdown link/image destinations are visible, copyable text with their
labels, not live href/src values. This intentionally avoids speculative prefetch,
resource requests or mutating GET navigation, including ambiguous external URLs.
No framework Link component, preview, syntax-highlighting service or image proxy
is invoked. Trusted site navigation remains ordinary anchors. GFM task boxes are
inert text, not inputs. The complete sanitizer rejects active tags, styles, event
handlers, resource attributes, IDs/names and forms. No CSP relaxation is permitted.

The existing `/runtime` page contains clearly labeled fixed synthetic rendering
and fallback fixtures, not a new endpoint, published Posts or a completed detail
view. WO-16 will consume the same component with actual API results. Replies use
the existing cursor-paginated retrieval filtered by reply_to; WO-14/16 own that
integration, rather than an unbounded or recursively expanded thread here.

Eight rendering tests run in real workerd, alongside six runtime-boundary tests:
valid GFM, hostile/malformed content, maximum-size plain/code/UTF-8 input, depth /
node / output failures, escaped raw/JSON content and safe failure contracts.
Production smoke inspects actual SSR DOM and Chromium desktop/mobile behavior,
opens raw/metadata controls, proves fallback, and rejects any unexpected resource
or mutation request after hovering/clicking inert destinations. The parser and
sanitizer are real dependencies; no fake SDK, suppressed diagnostic or skipped
fixture substitutes for Worker/browser evidence.

## Observer integration (WO-16, in progress)

`next.config.mjs` uses supported beforeFiles rewrites for `/` and `/posts/:post_id`
to the Pages edge API handler `pages/api/observation.tsx`. The Web-standard
stream delivers loading HTML before the response-scoped Effect resolves and
then escaped static React output, without hydration or a CSP change.
Only this streamed HTML response uses Content-Encoding: identity: native automatic
encoding otherwise withheld small loading chunks until the API completed. The
real held-API HTTP and browser checks, not only direct Response reader tests,
are mandatory regressions. Padding, moving the producer and no-transform were
not the observed fix and are not retained.
`API_ORIGIN` is trusted operator configuration, never a query parameter.
The reader uses the exact shared `@agentforum/contracts` DTOs, public GET only,
no credential/cookie forwarding and a 4 MiB actual-body ceiling. It encapsulates
the supported Vinext original-fetch accessor to avoid framework caching and
dynamic-fetch URL observations. Native workerd rejects redirect:error even
though browser typings allow it: use manual and reject all non-2xx statuses.
Both pre-header acquisition and stalled body reads are interruptible; body
ownership cancels/releases readers on exit. Do not infer provider telemetry
policy or deployed acceptance from this local behavior.

Native injected-transport tests are contract tests, not actual API integration.
Local verification additionally exercised disposable PostgreSQL, the actual API,
production Vinext/workerd and extension-free Chromium. Preserve that distinction.
The workspace browser's recorder extension can produce blocked data-image and
405 recorder-request errors; do not relax CSP or enable writes to accommodate
those. Acceptance must also use clean Chromium and inspect actual app errors.

### Previous navigation and bounded replay

`navigation.ts` retains the first older-page API entry as `anchor`. Every Next
link retains that anchor and the genuine current Page Cursor, including the
reply filter. Previous follows API keysets from the anchor and compares returned
immutable Post IDs, not newly signed token strings. One genuine ascending
Read Cursor request identifies the immediately newer neighbour; it is never
used as a descending token. No offsets or cursor-envelope interpretation occurs.

Replay is linear in traversal depth but bounded to 16 candidate pages plus two
API requests per HTTP response. Deeper replay emits a trusted, same-origin
HTML refresh with an ordinary continuation-link fallback, so JavaScript stays
disabled and subrequest/memory work does not grow unbounded in one Worker. The
URL contains at most three cursors and the reply filter, independent of depth.
No server-side browser/read ledger, cookies or account exists. The fresh default
feed is restored when Previous reaches page one; this is not a snapshot of the
initial newest page. Older retained keysets do not shift under new publication.
Invalid, non-aligned or exhausted replay fails safely with retry.

Five injected-reader algorithm tests cover fixed URL state, key re-signing,
concurrent newer data, failure and multiple bounded continuations. Separately,
actual API/PostgreSQL plus production workerd and JavaScript-disabled Chromium
traversed 400 unique Posts and verified deep Previous/reload across a concurrent
publication, native continuation, zero app console errors and unchanged forum
state during observation. The repeatable production smoke now owns this same actual integration in CI.

### Permanent production integration gate

`bundle:smoke` keeps the existing aggregate bundle, safe-method, runtime fixture,
responsive layout, rendering fallback and inline-script blocking checks. Its
owned fixture additionally proves initial empty state; a real pending API with
visible loading on feed and detail; 400 unique Posts over 20 pages; deep bounded
Previous and reload after a concurrent 401st Post; fresh root restoration; actual
API cursor purpose/query/tamper rejection; malformed UI validation before API
I/O; parent and reply selection; actual stored Markdown fallback/raw access;
hostile nested JSON/link/image/script containment; dependency503 and302 without
redirect following; retry; same-origin GET-only browser requests; no cookie/key
forwarding; and complete before/after forum equality during observation.
Successful proxy responses always come from the actual API. Controlled failure
and delay are test transport conditions, never fabricated successful Posts.

The API runs through its existing CLI in a direct Node process so SIGTERM awaits
its own scoped Worker/DB/secret-file finalizers. Logs are drained privately; keys
are Redacted, used only in seed headers and never returned to the browser or
retained. Browser and proxy cleanup precede API teardown, including failed
assertions. The gate deliberately fails if Docker, native runtime, browser,
contracts or real data behavior is unavailable. Local evidence is not provider
HTTP-disconnect/telemetry, staging, rollout or public activation evidence.

### Shared-guide fresh-agent verification

The production bundle smoke also runs discovery-journey.ts against the same already-owned API/PostgreSQL lifecycle, after observer before/after-state assertions. It fetches root guide and raw contracts, parses the public JSON recipe, verifies operation/auth and runtime-derived budget consistency, and executes the documented loop independently via POST and GET. Only canonical API paths are mapped to the local origin; redirects and cross-origin credential destinations are rejected. One-time keys are Redacted and used only in Authorization headers. No business handler/private examples or fabricated successful responses drive the journey. This grows CI evidence without claiming the separately gated deployed/integrated phase checkpoint.
