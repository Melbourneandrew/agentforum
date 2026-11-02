# Agentforum engineering

## Authority and execution

Read the [implementation skill](https://factory.8090.ai/project/3daddf58-9749-4459-93c7-f6f0b5672104/skills/3452f408-5650-4037-8454-5324e6ad2d7f), [rolling plan](https://factory.8090.ai/project/3daddf58-9749-4459-93c7-f6f0b5672104/knowledge-base/01267851-3b67-49e2-8391-080a1989bde1), and [coverage matrix](https://factory.8090.ai/project/3daddf58-9749-4459-93c7-f6f0b5672104/knowledge-base/48c7e646-435a-4b50-ad35-90eff38efc12) before selecting work. Requirements are binding; accepted ADRs govern architecture. Pending suggestions are not accepted decisions. Ask the owner about conflicting requirements or material architecture changes. Humans observe only; do not add operator accounts, ownership links, key recovery, reputation, read/view tracking, or an idempotency subsystem.

Inspect the work order, dependencies, comments, code, tests and CI. Verify prerequisites exist on the approved base. Do not implement an order In review unless addressing review or broken checks. Keep an explicit scope/verification todo list and update it with evidence. Later-phase planning orders do not authorize their future capabilities.

## Repository map and commands

- `apps/*`: deployable applications; each future app owns its runtime configuration and instructions.
- `packages/*`: extract only genuine contracts/configuration used by at least two apps. Single-app code stays in that app.
- `scripts/*`: repository tooling tests (Node only), not Worker application code.
- `.repos/effect`: read-only upstream Effect subtree, not a workspace or application dependency.

Use Node from `.node-version` and the exact pnpm version in `package.json` (via Corepack or an equivalent exact-version installation).

| Command                                               | Meaning                                                                                                 |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`                      | Reproducible install; never regenerate the lockfile in CI                                               |
| `pnpm check`                                          | Format, zero-warning typed lint, strict types, Effect diagnostics, tooling and workspace tests          |
| `pnpm format` / `pnpm format:check`                   | Prettier write / verify, independently of ESLint                                                        |
| `pnpm lint` / `pnpm typecheck` / `pnpm test`          | Root tooling checks followed by corresponding workspace tasks                                           |
| `pnpm effect:check`                                   | Noninteractive Effect diagnostics for root tooling; also runs each registered workspace diagnostic gate |
| `pnpm security:check`                                 | Dependency vulnerability audit; failure blocks delivery                                                 |
| `pnpm build`                                          | Turbo production builds for implemented apps/packages                                                   |
| `pnpm turbo dev`                                      | Local development tasks once app setup orders supply them                                               |
| `pnpm turbo run build lint typecheck test --dry=json` | Inspect real task discovery and dependencies                                                            |
| `pnpm --filter <package-name> <task>`                 | Run a package's documented task                                                                         |

The native API runtime now exists under `apps/api` (read its AGENTS.md). Business endpoints and the other applications do not exist yet. Empty task graphs do **not** establish build/runtime correctness. Add capability tests and gates in the same PR as the capability. Worker tests must use the current `@cloudflare/vitest-plugin` in workerd; database guarantees need disposable real PostgreSQL. Add framework-specific lint rules, production build and bundle checks, runtime/contract checks, generated-artifact cleanliness, browser checks and affected-consumer verification as their capabilities appear. WO-6 owns growing CI enforcement; bootstrap CI covers only the tooling introduced by WO-1.

## Type safety and Effect

All TypeScript projects extend `tsconfig.base.json` and retain strict mode, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes`. No unsafe type escapes, ignored errors, skipped tests or disabled checks to get a green build.

Before writing Effect code, read `node_modules/effect/AGENTS.md`. If that installed release does not ship it, record that fact and read `.repos/effect/AGENTS.md` and relevant upstream source/tests rather than inventing guidance. The Effect runtime is an API dependency, not a root dependency. This pinned npm release has no AGENTS.md; the vendored guidance is `.repos/effect/.agents/AGENTS.md`. Consult installed source for exact versioned APIs. Never import from the subtree. Use Effect Schema for untrusted boundaries, typed errors and explicit services/Layers; manage resources with scoped Layers. Never wrap `yield*` in native try/catch inside `Effect.gen`; recover through Effect combinators. Use `return yield* Effect.fail(...)` for failure termination. No ambient third-party clients in business logic.

## Git and delivery

New branches: `8090/<work-context>-<slug>-<short-id>`, e.g. `8090/wo-123-add-feed-cursors-a1b2c3`. Use a real work-order ID, otherwise `chat`; use a six-character lower-case alphanumeric conversation-derived suffix and check for collisions. Stay on an existing branch when requested. This repository uses Conventional Commits. Commit coherent milestones, push regularly, and open a PR to the original base. PR titles end with actual work-order IDs, e.g. `chore: establish toolchain (WO-1)`. Link the PR and set its order to In review while you perform agent review, not as a handoff to Andrew. Andrew authorizes autonomous review, remediation, approval where the configured GitHub identity permits, and merge. Review the current diff against scope/ADRs, security, compatibility, tests and actual exact-head CI; fix findings and rerun affected checks. Do not ask Andrew to manually validate features. Do not impersonate reviewers or self-approve through another identity. If the configured identity is the author, record an honest agent review comment and use standard merge only if repository rules allow it. Never use administrative bypass or weaken protection/checks. Merge dependency-first with an expected-head guard; retarget stacked PRs and verify against merged main. Confirm the actual merge and applicable post-merge checks, record evidence, and mark the order Completed only when its scoped verification is satisfied. Continue to the next eligible order.

GitHub Actions is the only routine remote deployment authority. Do not deploy from this workspace or provision paid services. Preserve isolated environments, migration safety, same-artifact automatic promotion and the explicit initial public activation decision. Missing credentials or staging evidence block affected delivery, not independent local work. Report local, remote CI and deployment evidence separately, including unrun checks.

## Updating the upstream reference

The current subtree's upstream commit is recorded in Git's squash commit (`git log --all --grep=git-subtree-split`). Update deliberately, never as an incidental change:

```sh
git subtree pull --prefix=.repos/effect https://github.com/Effect-TS/effect.git main --squash
```

Keep `.repos` excluded from workspace discovery, Turbo, lint, formatting, TypeScript project inputs, watchers and auto-imports. Repository tooling tests exercise these boundaries. Do not edit upstream reference files as part of product work.

## Required PR verification

Run `pnpm ci:setup` after frozen installation to install checksum-pinned oasdiff, then `pnpm check`, `pnpm dependency:check`, `pnpm --filter @agentforum/api contract:check`, `pnpm contract:compat origin/main`, `pnpm build`, `pnpm --filter @agentforum/api bundle:smoke`, and `pnpm security:check`. Regenerate the contract and verify a clean diff. CI compares the generated contract with the trusted event base commit, not a file supplied by the PR. oasdiff warnings and errors fail; do not add ignore rules to accept a breaking change under the same path version.

The stable required status is **Bootstrap tooling** (workflow Bootstrap). It runs on every PR, main push and merge-group without path filters, deployment credentials or writable token permissions. Its negative-fixture tests exercise actual tool failures rather than merely asserting configuration. App owners add real new checks in the same PR; absent database/web/docs capabilities are not passing tests. The current API compressed bundle ceiling is 3 MiB (the Workers free-plan script limit), not a throughput or deployment-readiness claim.

Repository administrators must configure this status as required and require branches to be current (or use the merge queue), without bypass actors. Inspection/configuration needs GitHub administration permission; an inaccessible endpoint is an explicit evidence blocker, not proof of protection. Preserve existing protections and reviewer requirements; do not blindly overwrite them. Autonomous merge authorization does not authorize a protection bypass or public activation.
