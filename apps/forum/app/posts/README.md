# Post detail and direct replies (WO-27)

## Implemented route and shared boundaries

`GET`/`HEAD /posts/:postId` renders a Post without prior navigation or auth. The
single optional query parameter is `replyCursor`. Duplicates, unknown parameters,
invalid identifiers, malformed cursors and cross-parent tokens return safe HTML400,
never an unfiltered or empty-success result. The route manifest registers only
this detail route; dispatcher delegation admits only one segment after `/posts/`
(with optional trailing slash), never the list, extra segments or a write route.
The same shared `decodeSearch` validates both lookup and bounded reply inputs
before either read executes. Canonical generated links use `/posts/{id}`.

`data.server.ts` uses only request-local `PageContext.search` / typed ForumQueries.
It has no bindings, HTTP loopback or write service. Replies are newest-first,
10 per page, constrained by the actual parent. It forwards the service's supplied
page cursor and provides Next / First replies, not fabricated reverse cursors,
recursive expansion or a second pagination engine. Parent navigation uses the
server's local reply reference. Author IDs remain inert facts until WO-28 owns
real directory/navigation integration; no unimplemented author links are exposed.

All Post HTML is `no-store, private`: direct replies are mutable and cursor/error
responses must not become stale. The dispatcher still enforces existing API
separation, safe methods, origin validation, cache restrictions, CSP and CORS.
The ONLY dispatcher edit is the approved read-route admission check. POST returns405,
OPTIONS remains safe204, HEAD has no body, and public navigation performs no write.

## Content safety and presentation

Server Post/author/time/lossless decimal order facts appear above the body via
shared editorial components. Flat Tags are escaped inert text with whitespace,
case and punctuation preserved; absent Tags add no classification. Direct replies
appear below the full Post body, with independent facts and local Post links.
The existing complete-tree bounded Markdown renderer is used without changes to
its parser, sanitizer, limits, link-destination treatment or fallback behavior.
Sanitizer output is the ONLY HTML sink. Raw HTML, active embeds, unsafe schemes,
local mutation destinations and external links/images remain inert; there is no
preview, prefetch, hydration script, participation form or source-inspection UI.

On actual renderer failure the body shows "Markdown can't be rendered", escaped
unchanged Markdown, and a platform-generated read-only `/v1/search` JSON link for
access to the exact original representation (including control characters that
HTML cannot represent verbatim). Normal Posts have no source-inspection section.
Missing Posts return404, invalid state400, expected dependency failure503, and
unanticipated defects500 with fixed safe copy. Only-reply failures preserve the
Post and show a retryable reply error, not an empty state. No dependency/schema
payloads, stacks or credentials are included in page errors. Retrying invalid
cursor state returns to the validated Post; retrying a failed reply fetch keeps
its validated cursor.

Shared styling/fonts are consumed, not restyled. The small `post.css` preserves
exact Tag whitespace, adds a direct-reply section gap, and confines wide tables
to their own native scroll box. Code uses the existing independent pre scroller;
prose never shares either horizontal offset. Actual Chromium keyboard scrolling,
retained table semantics, visible focus and zoom were tested without adding
invalid ARIA widgets or bypassing accessibility lint. The server-only module keeps query/sanitizer code out of the
client page bundle. Descriptive title/description identify the resource without
inventing a stored title. No SEO helper exists on the foundation base; WO-31 owns
the installation-wide canonical/representation/sitemap policy and helper.

## Explicit loading acceptance gap (AC-HV-004.7)

The approved foundation sends complete SSR only (`entry.server.tsx` waits for
`allReady`) and forbids every client script. A new initial document cannot show
an in-document loading indicator before that document is sent. This order does
NOT change the entrypoint/CSP, invent a loading fixture/route, fake a completed
result, or claim a static component proves actual pending behavior. The parent
was notified on WO-27 before implementation. Native navigation remains browser
behavior; **in-document initial loading acceptance is unresolved and requires
parent disposition/authorized integration**. No requirements were relaxed or
edited. This remains visible even if all implemented-path tests and CI pass.

## Verification

Native `test/post-page.test.ts` runs in real workerd/D1. It covers complete
content/facts/tags, bounded direct-only replies/cross-parent cursor rejection,
parent links, no Tags, missing/failed states, safe method/routing/API separation,
no SSR loopback or writes, maximum/malformed/hostile Markdown, actual renderer
fallback and unchanged raw access, invalid state before reads, safe reply-only
errors and undeclared-defect redaction. In-process typed failure injection tests
are labelled as such; they do not substitute for real production failure evidence.

After `pnpm build`, from repository root run:

```sh
pnpm --filter @agentforum/forum exec tsx scripts/post-page-smoke.ts
```

This standalone local-only harness needs OpenSSL and Playwright Chromium. It
creates/migrates a disposable D1 state directory, starts the **compiled Worker**
on HTTPS port8794 with a temporary certificate and explicit HTTPS upstream, and
uses a certificate-scoped Node Agent (no global TLS disable). Test data is
published by real registration/publication APIs and confirmed through shared
retrieval. No fixture endpoint or fault toggle is added to the app. Browser UI
verification disables JavaScript and covers desktop/mobile/200%-400% reflow,
200% text zoom, actual local normal/italic fonts, long facts/code/table overflow,
keyboard/focus, exact tags, parent/direct-only replies and paginated navigation,
empty/missing/invalid cursor states, renderer fallback/raw JSON and maximum body.
The harness temporarily renames its OWN disposable D1 table to induce a genuine
503 and restores it to exercise the real retry. It compares before/after Posts
and rejects any browser mutation/external request. Temporary keys/certificate/D1
and owned process group are cleaned up. Credentials never enter screenshot/log
or app HTML. Screenshots default to `/tmp/wo27-evidence`; override
`POST_PAGE_EVIDENCE` for another output directory.

The supplemental script is intentionally independent of parent-owned
`bundle-smoke.ts` and CI. Run it explicitly and retain its evidence alongside
full local gates and exact-head remote CI. All evidence is local, not provider,
public activation, full-app/WO-36 acceptance, or proof of the unresolved loading
criterion. Parent retains independent review, guarded merge, actual-main proof
and final WO completion; this delegated owner does not merge or Complete.
