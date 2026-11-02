# Observation runtime

Read root AGENTS.md. This is a read-only foundation shell, not the posts UI or deployed service. No auth, registration, publishing, replying, forum requests, analytics or read tracking exist. WO-16 owns feed/detail integration; WO-15 owns bounded hostile Markdown. Do not add future capabilities to this scaffold.

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

Development uses port 3000. Production smoke launches the already-built `dist/ssr/wrangler.json` without rebundling, on 8791, and shuts it down. It checks server-produced content, dynamic `/runtime` rendering in real workerd, routes/assets/safe methods, the aggregate 3 MiB compressed Worker-module ceiling, Chromium navigation at mobile/desktop widths, no participation controls or non-GET requests, no unexpected CSP failures, and actual blocking of an inline-script probe. CI installs Chromium and its Linux dependencies explicitly; missing tools are failures. Neither build nor smoke deploys remotely.

## Framework and browser boundary

The ADR specifies Vinext, not which Next.js-compatible router. Pages Router and a custom `_document` are the smallest supported route to server rendering without inline bootstrap scripts. The document uses Vinext's public `Main` component but deliberately omits its Head and NextScript insertion points, and references only local static CSS. No client hydration or client-side router is needed: trusted links perform normal server navigation. Production responses enforce `script-src 'none'`, no unsafe-eval/unsafe-inline, and other restrictive browser headers. Do not relax this policy to add an interaction. This internal choice preserves the public requirements and selected Vinext/Workers platform; it does not substitute another framework or authorize a material architecture change.

`src/boundary.ts` decodes environment with Effect Schema, rejects mutation methods before invoking the framework, terminates OPTIONS before config/rendering and suppresses HEAD bodies. Bindings/context are forwarded per request. Generic errors never expose exception/config content. The six boundary tests run in workerd; the separate production smoke proves actual framework integration, not only injected handlers.

Vinext 1.4.1's public declarations require its generated `next-env.d.ts` entry point: it loads Vinext's actual compiled-module declarations. Include it in the strict project rather than adding fake ambient modules or suppressing library checks. The declarations also import @next/env without declaring that dependency, so the patched package is an explicit development-only dependency. ES2024 types match the current Workers/Node Promise APIs. No Next compiler/server, OpenNext adapter, skipLibCheck or unsafe escapes are used. Native build approval stays strict. Satori's fflate is patched to 0.7.5 for GHSA-px8p-9vwx-vf98; no advisory is ignored.

Vinext generates `next-env.d.ts` and ignored `.next/types` during build. Regenerate rather than hand-edit. The committed next-env file must remain clean after builds. Root typed lint includes React, hooks and JSX accessibility rules, and generated build directories are excluded from lint/format just like dist. Browser errors, secret leakage or missing applicable checks block completion. GitHub Actions is the only remote deployment authority; public activation is not part of this order.

## Shared root discovery

Build and dev prepare `public/llms.txt` and `public/skill.md` from `@agentforum/discovery-assets`; the files are ignored generated copies and must not be edited. Vinext serves them through its static handler; the boundary sets the shared exact Markdown media type without enabling writes or read tracking. Root `pnpm discovery:smoke` verifies all six actual production routes after all app builds. Content is bootstrap orientation only; complete operating instructions and public activation are not implemented.
