# WO-26 — URL-addressable Posts browsing and trusted reads

## Authority and scope

The parent explicitly approved the bounded root/status/index/hash-only CSP
activation in execution-index thread83948d8f. LATEST EXPLICIT OWNER DISPOSITION
supersedes prior cold-loading holds: direct URLs/reloads retain full SSR,
complete no-JS body/allReady and accurate final HTTP status; the initial document
wait belongs to the browser. Eligible enhanced search/navigation/pagination/retry
MUST show visible in-document loading during actual pending reads, with real
search debounce and stale-response protection. No fake states/artificial mount
refetch/premature streamed200 or safety change. This closes interpretation, NOT
acceptance. Pending runtime ADR-002/roadmap edits document the explicit owner
decision; they do not imply unrelated pending suggestions are accepted.

Earlier cold-gap receipts are historical and superseded by this owner decision.
No new root approval or cold decision is required. Existing e834695 is retained
without another refresh. No provider, PR merge/Complete, production seed/import/
backfill/compatibility shim or release-scope expansion. Retained27 f7cc814 and28
b9aaa30 preserve original parent histories and stay untouched until coordinated
shared integration.

## Native state and presentation

- Root singleton q/author/parent/tagMatch/order/pageCursor; repeated exact tag and
  query-scoped previous cursor hints. Fixed10. Shared decodeSearch validates all
  current/history cursors before reads. History20 and65,536-byte UTF8 presentation
  URL bound preserve immediate Previous/First; no invented predecessor. Filter,
  order and Text Query changes reset paging/history. Exact nonempty Tags retain
  spelling, whitespace, case and punctuation. Native Enter/hidden submit, no Go.
- Request-local PageContext.search only; no SSR loopback, second query engine,
  auth/write service or new business operation. Invalid400/unavailable503/safe500
  full bodies are separate from empty success, with private/no-store handling.
- Pure presentation.tsx is shared by route and isolated harness; browse.tsx owns
  loader/meta/CSS integration. Escaped body-derived headings/excerpts/public facts,
  no stored titles/new metadata fields. Post destinations require retained27
  route composition, not claimed working on this standalone26 base.

## Trusted first-party enhancement

- One dependency-free external deferred asset and immutable generated manifest;
  automatic parity/determinism/bounds/security tests. Existing Vite and Prettier
  produce one checked formatted chunk, no root lint/format ignores/config/task/
  CI/lockfile exception. Source edits regenerate byte hash and manifest together.
- Current asset15,047 bytes:
  `/first-party/read.2689f0fe436f8117579434522eb2897e67616791be6d050e8eca5585d05b4cbc.js`
  with `sha256-Jonw/kNvgRdXlDRSLrKJfmdhZ5G+bQUOjspVhdBbTLw=`.
- Exactly one script/root persistent platform status before children INSIDE
  EditorialShell, outside main/Agent body. Only admitted successful200 dynamic
  HTML receives exact hash-only script capability/attributes none/connect self/
  fixed GET-root form policy. Errors/nonHTML/API/metadata/static Docs retain
  restrictive policy. No hydration/inline state/eval/broad script-self/trust.
  -250ms debounce, immediate intent invalidation, abort+revision stale guards,
  immediate navigate/popstate/retry, IME cancel/commit and explicit Enter. URL
  history, actual form nodes/focus/caret/disclosures/exact Tags are preserved;
  same-URL explicit retry performs a read without duplicate history. Blur alone
  is not a new intent. No mount reread/prefetch/hover/preview/storage/tracking.
- Exact same-origin platform page allowlist; excludes API/mutations/raw/docs/
  external/credentials/fragments/unsupported destinations and Agent nodes.
  Full HTML GET, credentials omit/redirect error/no-store/no-referrer,35s and
  16MiB actual streaming UTF8 bounds; complete200/400/404/500/503, fatal malformed
  UTF8/oversize/abort and robust cancel/release-lock. Inert template validation
  rejects active resources/events/styles/unsafe forms before main insertion.
  Only title/description mirrored; richer31 head metadata remains coordinated.
- Owned route read-status.css reserves a sticky platform line; actual production
  assertion keeps Search stationary during pending read. No shared CSS changes.
  Pre-debounce copy says displayed results have not updated, not fake loading.

## Verification boundaries

`bundle-smoke.ts` preserves existing HTTPS Worker/private migrated D1/TLS/cleanup,
API/FTS/Tag/NUL/checkpoint/agent-loop/restart/noJS checks. Scaffold assertions alone
adapt to actual Posts/one script/SRI/hash/fixed GET form. `browse-smoke.ts` runs on
that SAME real compiled Worker using native local API seed and browser observer:
no mount read/API/Agent execution; genuine Worker response held for pending read;
debounce/Search stability/focus/caret; cursor Next/Previous/filter reset; exact
Tags/additional control; full400 versus empty; stale aborted response cannot
repaint; IME read only on commit; Back restoration;375/320 document reflow; native
noJS Enter. Disposable local D1 table rename produces REAL503/full error, restores
in finally, then real Try again recovers10 rows. No application fault endpoint or
fabricated business HTML/status. Optional BROWSE_EVIDENCE saves actual production
pending/ready/mobile503/recovered/noJS screenshots. Browser errors, external and
observer business API requests are checked through the complete matrix.

`read-security-smoke.ts` adds actual Chromium negative probes against that same
compiled HTTPS Worker: tampered transferred asset bytes fail exact SRI with
complete SSR/native GET fallback; nonmanifest scripts without SRI or with wrong
SRI fail CSP before transfer; inline scripts and event handlers are blocked.
Playwright reports CSP-blocked request events with failure `csp`; these are not
successful network transfers. Agent form/input/IME/header/navigation/status/retry
hooks are ignored, including hover and local mutating GET destinations. Eight
controlled modifications of genuine fetched native documents are rejected
inertly before swap/resource reads; fetched-head scripts are never applied.
These are explicitly synthetic disposable browser/transport ATTACK probes, not
fabricated business data/status, fault routes, production tests or proof of the
future full Post-body integration. Real native Posts also contain hostile raw
hook/script/mutation text which listing presentation escapes. The actual
sanitizer, API and server entry are unchanged. App AGENTS documents the precise
explicit renderer capability and the owner-disposed direct-versus-enhanced loading boundary; integrated acceptance remains separately verified.

`read-client-browser.ts` is an isolated presentation/transport module fixture,
NOT real D1 acceptance. Native tests and complete inherited Docs/discovery
consumers remain separately labeled.301b full local sequence failed that extra
Node fixture's route CSS import AFTER normal production/safety gates; pure
presentation extraction in867732b fixed it without CSS stub/loader bypass.
Inactive467/bc03 and failed-format1435727 proof remain historical, not final active
proof. Final local/remote receipts identify the exact pushed head separately.

Remaining integration acceptance: retained27/28 route/common status/asset hooks,
cross-page loading/hostile rich Agent bodies, complete navigation, and richer31
head metadata. Authors/About remain disabled until real route composition.
Parent serializes integration and verified-main notifications; no duplicate route
work/history rewrite or unauthorized new base refresh. This PR is not a release,
provider, merge or full26/27/28 acceptance claim.

Inherited docs-smoke replaces only the obsolete root D1-scaffold landing text
assertion with exact actual Posts main/heading/Search/fresh-empty state after
Public site navigation. All Docs noJS/mobile/font/CSP/keyboard/raw/disclosure/
no-external/no-business and30 discovery checks remain unchanged. The30579ba full
sequence found this stale consumer after passing all other gates; failed log is
retained and final proof is rerun, never relabeled successful.
