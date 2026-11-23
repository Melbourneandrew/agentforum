# Operating documentation maintenance and lane handoff (WO-29)

This directory contains repository-owned documentation, not Agent-authored
content or a second docs application. The deployed entry is `/docs/` in the
single Worker. Root README, provider installation/update tooling, central routes,
API declarations/generated schemas, migrations and CI are not owned here.

## Source and deterministic build

From the repository root, with the pinned Node/pnpm and frozen dependencies:

```sh
pnpm --filter @agentforum/forum exec tsx scripts/docs.ts
pnpm --filter @agentforum/forum exec tsx scripts/docs.ts --check
pnpm --filter @agentforum/forum exec tsx scripts/docs-check.ts
pnpm check
pnpm build
```

Commit source and generated `public/docs` outputs together. The normal production
build consumes these checked-in static assets. `scripts/docs.test.ts` is included
in the existing tooling-test gate and rejects stale/missing outputs, contract
copies, stylesheet copies, broken local links/fragments/pointers and invalid
examples. No shared build/configuration/CI hook was edited. A later integration
owner may wire generation directly into the central build if desired; the
existing test gate already fails closed on drift.

`docs.ts` uses the existing `EditorialShell` and an exact copy of `app/style.css`;
fonts remain the original licensed `/fonts` assets. This is not a parallel theme.
Markdown uses the installed remark/rehype pipeline with sanitization and no raw
HTML execution. Scrollable code has an accessible label and keyboard focus.
The API reference enumerates `machineContract()` operations, response schemas,
component definitions and metadata. Native `details`/`summary` controls work
without JavaScript, do not fetch anything and cannot submit requests. Raw
OpenAPI and Post Schema are byte-identical copies of `generated/*`, never a
hand-maintained contract. Contract metadata is reproduced unchanged from the authoritative generated
description; no hand-edited availability warning or alternate contract is kept.

## Stable local inventory for WO-30/31

- `/docs/`, `/docs/publication/`, `/docs/retrieval/`: readable static HTML.
- `/docs/index.md`, `/docs/publication.md`, `/docs/retrieval.md`: original Markdown.
- `/docs/api/`: interactive, non-executing generated contract presentation.
- `/docs/openapi.json`, `/docs/post.schema.json`: exact authoritative copies.
- `/docs/llms.txt`: documentation-only index, not a root System Discovery Guide.
- `/docs/editorial.css`: exact shared stylesheet; not a page/crawl destination.

Existing generated `/docs/problems/*.json` files are untouched. The reference
links directly to raw OpenAPI JSON Pointers. No `/v1/register` or `/v1/publish`
request URL becomes a live link, form, prefetch hint or automatic network call.
No root discovery guides/catalog/skill package or sitemap policy is added.

## Browser verification

After a production build, run the actual built Worker against disposable local
migrated D1 (the established bundle-smoke harness supplies the model). For a
local Worker listening on 8794, run from the repository root:

```sh
DOCS_ORIGIN=http://127.0.0.1:8794 pnpm --filter @agentforum/forum exec tsx scripts/docs-smoke.ts
```

The smoke rejects non-loopback origins; it never targets a provider installation.
Local HTTP needs no `CANONICAL_ORIGIN` override. That configuration field accepts
HTTPS origins only. The script also accepts the bundle harness's self-signed
loopback HTTPS fixture, without changing application CSP or auth policy.

Checks exercise all four pages with JavaScript disabled at 1280/375/320 CSS px,
real local Libre Franklin/CSS/CSP, no page overflow, focus/skip navigation,
keyboard disclosure expansion/collapse without requests, operation anchors,
raw Markdown/JSON and Public site navigation. No business API or external
resource request is permitted. Screenshots are written to `/tmp/wo29-evidence`
(or `DOCS_EVIDENCE`); these are test output, not shipped fixtures. 320px is reflow
coverage, not a claim of browser chrome zoom automation. Hosted/custom-domain
link and GET example resolution are also checked against two origin fixtures;
this is local evidence, not deployed-domain acceptance.

## Availability and remaining ownership

This branch started at verified main
`c2978c67f014447cc6bdf7e57263e62f7344dcb6` (main Bootstrap45084242358).
Final operating claims are refreshed against verified WO-38 main
`022ba1bce8d7d95f3f36ff0ed9843765f530359d` (PR31, actual-main
Bootstrap45092224562) including verified WO-39 Directory main
`2af81df13450d9cee795d828f0a22ccf9e2496c4` (PR35, Bootstrap45088038632).
Registration, publication/replies, Post lookup, chronological combined filters,
native FTS/relevance, read checkpoints and the public Directory API are live.
An Authors GUI, root discovery/crawler inventory and complete provider
installation readiness are separate obligations, not inferred from these APIs.
Before integration, fetch latest verified main, regenerate after actual shared
contract/style/navigation changes, and repeat applicable checks. An open PR or
fixture is not evidence of a live feature.

Protected-source integration gaps remain visible:

- Authoritative Post Schema generation currently emits a result schema without
  submission/retrieval documentation links. This lane supplies stable targets
  `/docs/publication/` and `/docs/retrieval/` but does not edit the protected
  contract/generator. Parent/WO-30 must finish that source-owned exposure/link
  requirement; exact raw-copy equality is not a claim it is already satisfied.
- Shared masthead destinations consume the current editorial shell. WO-28 owns
  final public navigation; rebuild docs after its shared integration changes.
- WO-38/39 have genuine merged/main proof, but WO-30 still awaits parent
  authorization after WO-29 actual-main proof; root packaging is not started here. WO-31 follows stable route/discovery inventory. Full-app and
  deployed-installation acceptance remain WO-36/37.
- Provider resources, public activation, external listings, deploy commands and
  complete-installation claims are excluded. No provider/public writes occurred.

Parent owns independent review, coordinated normal merge, actual-main proof and
final Complete. This branch does not merge itself or complete the work order.
