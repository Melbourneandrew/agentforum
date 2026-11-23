# Agent Forum engineering

## Authority and current execution

Read the current [completion plan](https://factory.8090.ai/project/3daddf58-9749-4459-93c7-f6f0b5672104/knowledge-base/cb808785-e02e-4081-95a0-b419e29c2964), accepted ADRs and selected work order. The owner approved a clean replacement of the never-deployed old app: one `apps/forum` Worker, D1, React Router/Vite, flat tags, FTS5, fixed-window admission, validated unsigned cursors and no bootstrap application secrets. Do not resume canceled PostgreSQL/Hyperdrive/three-app work, build old API/key/cursor compatibility or import old data. The old queue and test receipts are historical, not redesigned-app acceptance.

WO-40 through WO-47 are sequential foundation orders; parallel owners start at the saved plan's native gate. One integration owner controls routes, root lockfile/tasks/CI, Wrangler, contracts and D1 migrations. Renderer/UI, docs and delivery owners consume these extension points. Provider ownership must be coordinated with the existing local Codex owner before provider changes; never create a second deployment owner. Cloud access does not block independent local work. Requirements remain binding; unresolved contradictions block only affected work.

## Repository and commands

`apps/forum` is the only deployable app. Internal API/runtime/rendering modules remain separate. `scripts` contains Node tooling, not Worker business code. `.repos/effect` is read-only upstream reference, never imported or included in workspace/task/lint/format/TypeScript discovery. Extract workspace packages only for real independent consumers.

Use Node `.node-version` and exact pnpm `package.json` versions.

- `pnpm install --frozen-lockfile`: reproducible install.
- `pnpm db:migrate:local`: apply versioned SQLite migrations to disposable **local** D1; no remote default.
- `pnpm db:safety <trusted-base-commit-sha>`: fail-closed SQLite native parser/authorizer, pinned Wrangler chunks and append-only SQL/journal/snapshot history; CI supplies the trusted event SHA.
- `pnpm --filter @agentforum/forum db:generate`: generate schema changes; CI requires generated schema/migrations to remain clean.
- `pnpm db:reset:local`: explicit local-only reset, never an update/retry step; rejects arguments/symlinks.
- `pnpm dev`: supported React Router/Vite/workerd on port3000.
- `pnpm check`: formatting, zero-warning typed lint, strict types, all-zero Effect diagnostics, actual tooling and workerd/D1 tests.
- `pnpm ci:setup`: checksum-pinned oasdiff installation for real compatibility negative fixtures.
- `pnpm dependency:check`, `pnpm contract:check`, `pnpm contract:generate`, `pnpm contract:compat <trusted-base>`: dependency and generated API checks. The initial owner-authorized contract replacement accepts only the exact WO-40 pre-pivot baseline; arbitrary missing baselines fail. WO-43 also replaces the exact WO-42 empty-input/204 foundation artifact with the hash-pinned initial logical contract. Subsequent forum contracts use the real breaking-change check; unknown bases or changed transition artifacts never receive a waiver.
- `pnpm build`: complete production Worker/assets build, never remote deployment.
- `pnpm --filter @agentforum/forum exec playwright install chromium`, then `pnpm bundle:smoke`: production workerd with disposable migrated D1, SSR/static/API separation and actual no-JavaScript Chromium.
- `pnpm security:check`: dependency audit; advisories fail delivery.

The runtime scaffold is not a complete installation. Registration is live with digest-only authentication (WO-44). Authenticated atomic publication/replies are live (WO-45); public chronological retrieval/checkpoints are live (WO-46); public Directory is live (WO-39); native FTS5 search and exact all/any Tag filters are live (WO-38); the domain schema belongs WO-42 and authoritative logical contracts WO-43. Do not claim success from stubbed domain responses. Local tests do not prove provider installation or readiness. Documentation/discovery must not advertise inactive behavior.

## Type safety and Effect

All projects extend strict `tsconfig.base.json`, including noUncheckedIndexedAccess and exactOptionalPropertyTypes. No unsafe casts, ignored errors, skipped tests, check suppressions or diagnostics overrides. React/a11y lint applies to the app. Every Effect gate invokes the actual pinned CLI and requires a complete report with zero errors, warnings AND messages; malformed or informational diagnostics fail. Keep real negative fixtures.

Read `node_modules/effect/AGENTS.md` before Effect changes. This pinned npm release has none; use `.repos/effect/.agents/AGENTS.md` plus installed source for exact versioned APIs. Never edit/import the vendored source. Effect Schema validates untrusted boundaries; typed services/Layers encapsulate dependencies. Request I/O/D1/context must not be captured in isolate-scoped layers. Native D1 batches/constraints, not PostgreSQL connection finalizers, establish atomicity. Use Effect combinators, not try/catch around yield*. Internal optionality uses Option. Do not print credentials, raw payloads, SQL, cursor values or dependency errors.

## Foundation interface handoff

Read `docs/engineering/foundation-handoff.md` for the WO-47 acceptance matrix, request-local `PageContext.search` read bridge and lane/shared-file ownership. General fan-out requires its recorded merged/main-verified gate, not fixture-only success. Production local smoke requires OpenSSL for its disposable certificate and preserves HTTPS through Wrangler's explicit local upstream; it verifies the actual built-Worker agent loop and restart retention without an application bootstrap secret.

## Delivery

Commit coherent milestones and push regularly. Branches: `8090/<wo-id-or-chat>-<slug>-<six-character-id>`. Conventional Commit/PR titles, with actual `(WO-N)` suffix on PRs. Open a PR, set the order In review, perform agent review/remediation and exact-head CI, merge normally with expected-head guard when permitted, then verify actual-main checks. Never fabricate independent approval, impersonate, use admin bypass or weaken branch protection. Completion requires the order's actual evidence, not just a PR or green status.

The stable required check remains **Bootstrap tooling**, on every PR/main/merge-group without path filters, deployment secrets or writable token. It grows with implemented capabilities. Clean-pivot test replacement removes obsolete mechanisms, not behavior still required by the new app.

Independent installations use the approved provider button/Workers Builds or authorized CLI flow; maintained delivery may use Actions. Provider authorization, complete installation, data-preserving update/retry and compatible recovery belong WO-33/34/37. No remote resources, paid services or public activation are authorized by local runtime work. Future updates preserve the NEW D1 app's data/keys/cursors; application rollback never promises database reversal.
