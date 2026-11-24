# WO-26 independent browsing milestone — central integration pending

Branch `8090/wo-26-search-browsing-4087db` starts from parent-designated verified
main `3e6953f502a9d90c60cf6270fe37081d05f31b28` (Bootstrap45098907913 success),
then refreshes once onto verified parent WO-30/PR39 main
`e83469589745034f93834e1c5f72a600b36fa4b3` (actual-main45313676555 success).
Parent discovery metadata routes, enriched Post Schema/docs links, generators,
static assets and whole35 wrapper/exact-off capture remain unchanged.
WO-38/48 prerequisites are genuinely present. Existing WO-27/28 branches are
not rewritten/duplicated; parent test-only WO-27 d0eba90 is preserved remotely.
No provider operations, credentials, deployment, merge or Complete are authorized.

## Independent implementation

- `state.ts`: translate only root `q`, `author`, `parent`, repeated `tag`,
  `tagMatch`, `order`, `pageCursor`, repeated `previous` into shared strict
  `decodeSearch`, fixed10. Reject singleton duplicates, unknown keys, malformed
  percent/UTF-8 encoding and incompatible modes before reads. Tags preserve exact
  whitespace, punctuation and case; empty form controls mean no filter.
- History contains only predecessor cursor tokens, with empty token denoting the
  known first page. Validate every token against the same resource/purpose/order/
  fingerprint before the read. Bound predecessor hints to20 and total presentation
  URL to65,536 UTF-8 bytes, dropping oldest hints before that bound fills while
  retaining immediate Previous and a First link. It is navigation history, never
  a checkpoint/signing/authorization feature. Raw direct-cursor URLs lack an
  invented Previous page. API's14,336-byte GET Submission Limit is distinct;
  this UI bound does not claim provider edge support for every large URL.
- `data.server.ts`: existing request-local `PageContext.search` only, no SSR
  loopback, ambient binding, auth/write service or alternate engine. Preserve
  native FTS/exact all-any Tags/author/direct-parent/order/cursor results; invalid
  query400, dependency503, safe defect500 and retry, never empty success for error.
  HTML remains no-store/private and uses complete response status/body.
- Unregistered `routes/browse.tsx`: shared editorial components/styles, compact
  intro and same-row Search, no visible Go button or search activation layout
  change. Native GET form preserves no-JS controls/Enter submission (hidden
  submit input); it carries NO cursors, so changes reset paging. Excerpts and
  headings are escaped body-derived text, not stored titles or rendered Markdown.
  Public facts/Tags, real bounded table/Next/Previous/First and error/empty states.
  Post-detail links are intended for the coordinated WO-27 integration, not a
  claim an unmerged route is already active. Native table links remain focusable;
  listing responsive/keyboard browser validation is still required after wiring.
- `read-coordinator.ts`: dependency-free pure first-party scheduling module,
  250ms initial debounce, immediate intent invalidation/abort plus generation guard
  (including while a new debounce timer waits), real pending-read lifecycle,
  current-only commit/failure/settled, retry/popstate navigation bypasses debounce,
  disposal cancels owned work. No DOM/network bootstrap is installed here.
- `read-target.ts`: exact same-origin public HTML route allowlist, excluding all
  API/mutation/raw/docs/external/fragment/credential URLs; changed controls drop
  cursor+predecessor state and preserve opaque exact Tag values. DOM adapter must
  only call this for platform-owned controls/navigation, never Agent content.

## Exact parent-owned central proposal — NOT approved/applied

Recorded on the accepted execution index thread:
https://factory.8090.ai/project/3daddf58-9749-4459-93c7-f6f0b5672104/knowledge-base/cb808785-e02e-4081-95a0-b419e29c2964#comment=83948d8f-9fdc-4582-989d-73e516ebe19d

Recommend one checked content-hashed/SRI first-party external deferred asset;
root emits only that script and a persistent platform status outside Agent body.
Dynamic SSR CSP allows only the asset hash, blocks script attributes, permits
same-origin connect and fixed root GET form; static docs/discovery remain no-script.
No unsafe-inline/eval, broad self-script trust, strict-dynamic, inline hydration,
new API/data/fixture route, write operation, prefetch or preview. Supported full
React Router SSR/allReady/direct-query behavior is retained. Register this listing
at root only after parent approval; parent serializes shared entry/root/CSP/routes
and WO-30 metadata/discovery/derived output integration. None is edited here.

Cold/direct/reload response cannot display its own document before full SSR
resolves while retaining authoritative404/503 status/full body. Genuine pending
first-party navigation/filter/paging/retry indicators are implementable without
streaming shell200 or inline bootstrap. Parent must disposition the cold-load
coverage boundary; no browser-chrome substitution, artificial mount reread,
fake loading fixture or requirement waiver. Actual ADRs prohibit Agent code,
not all trusted client enhancement; sanitizer remains unchanged.

## Evidence and remaining acceptance

Native tests exercise real workerd/D1 and direct SSR loader/component, including
live FTS/order/exact filters, cursor/history reload, pre-read validation, hostile
escaped text, empty/missing-error distinctions, genuine D1 table fault503/restore/
retry and safe methods. Pure scheduling tests use controlled actual Promises and
fake clocks; they are NOT production browser/loading proof. Read-target tests
pin exact permitted/rejected URLs and filter reset. No mocks count as native
search or integrated browser success. Typed lint/types and actual Effect gates
must remain all-zero; run full checks/build/security on pushed heads.

Production JS+noJS debounce, real delayed requests/out-of-order/loading, keyboard,
responsive/reflow/search stability, hostile Agent CSP and27/28 integration remain
UNRUN/blocking until central approval and real route/asset wiring. Existing
production scaffold gates do not prove this unregistered UI. Parent keeps merges,
actual-main proof and final completion; no acceptance/requirements/ADR edits.

## Inactive client milestone (continued independent implementation)

`read-html.ts` bounds full same-origin credential-free/nonredirecting HTML GETs
at16MiB/35 seconds with fatal streaming UTF8, supported authoritative statuses and
abort; it never calls a JSON API/mutation/preview. `read-document.ts` parses in an
inert template (not a resource-fetching DOMParser), requires exact trusted main/
view/root/status identity, and rejects executable/resource/event/style/form-action
capabilities before insertion. `enhance.ts` binds only platform forms/explicit
navigation, maintains URL/history/reset, IME cancellation,250ms debounce/immediate
stale invalidation, actual pending aria-busy/status, full safe errors/retry and
input node/focus/caret/disclosure restoration. No automatic mount read, hover,
prefetch, storage/tracking/auth/write or Agent node dispatch. `client-entry.ts`
and the deterministic **in-memory-only** Vite build helper are not imported by
root or enabled; no public asset/manifest is emitted pending central approval.
Seven controlled transport tests plus cancel/resume coordinator test complement
nativeD1 coverage. They do not prove registered production UI acceptance. Scope
remains fresh empty installation, no legacy/import/backfill/shim/release work.
No further base refresh without parent verified-main notification. WO34 controls
are separate from35 metadata/client approval. Existing27/28 retained untouched.

Additional automatic tooling tests build the inactive asset twice and check exact
SHA256/SRI determinism, one standalone chunk,32KiB cap and no eval/storage/backend/
auth code. `pnpm --filter @agentforum/forum exec tsx scripts/read-client-browser.ts`
runs a disposable **isolated HTTP presentation/module fixture**, not the live
Worker/D1. It loads the real external built code under exact hash-only CSP and
checks blocked inline/broad-self scripts, no mount reread, debounce/held actual
HTTP pending state, cancellation, input focus/caret, IME, exact Tags/next blank
control, full503/retry, inert template/resource rejection, Back and native Enter.
This does not replace registered production/noJS26/27/28 acceptance. No fixture
route is added to the application. Browser/server are always closed.

The harness found and fixed text-change-on-blur reapplying the outgoing form
while restoring history; only input (or select change) is a new control intent.
Explicit Enter forces immediate read; ordinary duplicate input/select events
remain deduplicated. Same-URL retries read without duplicate history entries.
The persistent proposed root status lives inside EditorialShell's platform
#forum-content wrapper BEFORE main, outside every Agent body, not after footer.
No extra shared component/CSS change is needed to create that sibling slot.
Full production responsive/viewport-visible status styling is still unrun and
will be resolved within approved integration, not claimed from this fixture.
