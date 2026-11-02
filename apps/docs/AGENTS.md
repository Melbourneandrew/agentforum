# Static documentation foundation

Read root AGENTS.md. This app uses Fumadocs' React Router provider and page components with React Router/Vite pre-rendering. It does not use a Next.js runtime, Next build, Vinext or OpenNext adapter. Only `build/client` static assets and a native asset-serving Worker deploy; Node pre-render code stays out of the Worker.

## Commands from the repository root

```sh
pnpm --filter @agentforum/docs dev
pnpm --filter @agentforum/docs content:generate
pnpm --filter @agentforum/docs typecheck
pnpm --filter @agentforum/docs lint
pnpm --filter @agentforum/docs effect:check
pnpm --filter @agentforum/docs test
pnpm --filter @agentforum/docs build
pnpm --filter @agentforum/docs exec playwright install chromium
pnpm --filter @agentforum/docs bundle:smoke
```

Dev uses 3001. Build prepares deterministic content, pre-renders `/`, `/docs/overview`, `/docs/runtime`, `/docs/contract`, then dry-bundles the static Worker. No command deploys remotely. Production smoke serves the already-built Worker on 8792 without rebundling and cleans its process group. It crawls actual HTML/links, raw Markdown/source parity, contract fingerprint, safe methods, 404s and reserved paths, and proves navigation in Chromium with JavaScript disabled. Missing browser/build/asset tools are failures. Six boundary tests execute in workerd.

## Source and contract ownership

`app/content.ts` is the minimal document model. `scripts/prepare-content.ts` emits raw Markdown and the documentation index from that model, validates the API-owned `../api/generated/openapi.json` with Effect Schema, and generates `app/generated/contract-info.ts`. Generated files are committed and must stay clean after regeneration/build. Never hand-edit a generated API artifact, metadata file or Markdown representation. The docs build task explicitly hashes the API artifact as an input, so Turbo cannot restore stale identity output after an API contract change.

This scaffold presents contract identity only, not an operation summary or an interactive API reference. API operations, public raw-contract delivery/links and complete guides belong to WO-17/later owners. Docs never serves a competing raw OpenAPI copy. No registration/publishing/search operations, catalog, directory or public activation are claimed.

Root `/llms.txt` and `/skill.md` are reserved for `packages/discovery-assets` under WO-22; this scaffold deliberately returns 404 there. The documentation-only index is `/docs/llms.txt`, distinct from the System Discovery Guide. Raw pages are `/markdown/{overview,runtime,contract}.md`. Existing root-path behavior must remain easy to extend with the shared adapter.

## Browser and runtime boundary

Public output uses actual Fumadocs components and CSS. RootProvider disables theme-script injection and unused search; Root omits client scripts/hydration. All navigation uses normal server links, with meaningful text already in HTML. The Worker enforces `script-src 'none'`, restrictive style/object/frame policies, no-sniff and no-referrer, validates platform bindings with Effect Schema, denies mutation methods, terminates OPTIONS early, and keeps HEAD bodyless. Asset/config errors return only generic text. No auth, forum writes, analytics or read tracking exists.

React Router's generated SPA fallback is not used: asset routing has `not_found_handling: none`, and the runtime crawl proves unknown paths return 404 rather than a client shell. Invalid loader parameters are build errors because only the bounded pre-render list executes the loader; there is no live React Router SSR server. The deployed Worker owns real unknown-route 404 responses.

Fumadocs' published search-client declarations import optional SDK types even when search is disabled. Explicit exact-pinned development dependencies provide those real declarations; no search provider is configured, instantiated or contacted, and no resources/credentials are needed. These are compile dependencies, not authorization for new services. Strict type/Effect checks remain enabled without skipLibCheck, fake ambient declarations, unsafe escapes or lint exceptions. Framework and JSX-accessibility lint applies to this app. Native approval and dependency audit remain enforced.
