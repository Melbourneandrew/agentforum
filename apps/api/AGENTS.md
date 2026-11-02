# API runtime

Read the root AGENTS.md first. This application currently exposes only `GET /v1/health` (no query fields) as a harmless runtime probe. HEAD returns headers only and OPTIONS terminates with 204 before environment decoding or service acquisition. No registration, publishing, search, database, telemetry export or public deployment is implemented.

## Local commands

Run from the repository root:

```sh
pnpm --filter @agentforum/api dev
pnpm --filter @agentforum/api typecheck
pnpm --filter @agentforum/api lint
pnpm --filter @agentforum/api effect:check
pnpm --filter @agentforum/api test
pnpm --filter @agentforum/api contract:generate
pnpm --filter @agentforum/api contract:check
pnpm --filter @agentforum/api build
pnpm --filter @agentforum/api bundle:smoke
```

Development listens on port 8787. Build uses Wrangler's **dry-run**, not remote deployment. Bundle smoke starts the already-built script without rebundling in local workerd on port 8790, checks health, malformed query, unknown business route, HEAD and OPTIONS, and shuts the process group down. Neither command requires cloud credentials.

`generated/openapi.json` is derived from Effect HttpApi schemas. Regenerate it rather than hand-editing it. Contract checks validate OpenAPI 3.1 and exact source parity; framework-default decode errors are normalized to the declared RFC 9457 validation schema. Do not rewrite the `3.1.0` generator marker or advertise unimplemented endpoints. Problem-type documentation URLs are reserved for the docs implementation; this scaffold does not claim those remote pages exist.

## Request lifecycle and trust boundaries

- The default exported object retains only pure schemas and immutable Layer recipes. A fresh Effect runtime and Layer scope is created per fetch and disposed before completion.
- `RequestContext` carries decoded environment bindings, the actual execution-context object (exposed through its required structural subset), and a server-generated correlation ID. No request ID from headers is trusted.
- Health is an injectable typed service acquired inside the request fiber, so cancellation also interrupts service acquisition rather than only the active handler; future database clients and other I/O resources belong in request-scoped Layers, not isolate globals. The current health probe proves no database readiness.
- Expected validation errors use the declared schema; undeclared/encoding/finalizer failures become the generic 500 schema. Framework error bodies never reach clients. Current failure normalization supports only the current runtime contract; future endpoints must add explicit declared mappings, not turn arbitrary status codes into public failures.
- Diagnostics contain a fixed failure category and server-generated correlation ID only: no exception text, stack, URL, headers, payloads or binding values. No successful read/view telemetry is added. WO-8 still owns the accepted telemetry policy and exporter.
- Source and tests are strict-checked using web-standard DOM types plus explicitly imported Cloudflare execution-context types. Runtime correctness is verified in real workerd, not inferred from ambient DOM types. Node-only tooling scripts use the same strict compiler settings. No `skipLibCheck` or unsafe type escapes are used.
- The pinned Effect npm release does not ship `AGENTS.md`, nor does the vendored upstream root. Read `.repos/effect/.agents/AGENTS.md` and the installed `effect/src` / `@effect/platform/src` before selecting APIs. The vendored main is a newer major than the pinned runtime, so installed source is authoritative for exact signatures.
- Vitest's Cloudflare plugin configuration is a Node `.mjs` file; tests run in workerd. Its published tool declarations currently reference missing internal Miniflare modules, so importing that Node plugin into the application's TypeScript project is not appropriate. Application and test TypeScript remain fully checked, with zero-warning typed lint and strict Effect diagnostics.

The pinned native installers (`esbuild`, `workerd`, `msgpackr-extract`) are explicitly approved in the root workspace manifest; do not disable strict dependency-build approval. Wrangler's local config disables workers.dev, preview URLs and automatic observability; remote setup and activation belong to their own work orders and owner decisions.
