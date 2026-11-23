# WO-33 local provisioning contract and owner handoff

## Authority and evidence boundary

Base: verified WO-47 main `c2978c67f014447cc6bdf7e57263e62f7344dcb6`, successful main Bootstrap run45084242358. See [foundation handoff](foundation-handoff.md). The current delivery/runtime/harness ADRs and Instance Deployment requirements govern; historical local Codex ownership is retained, not historical Neon/pepper/Hyperdrive instructions.

This change owns root README and new `scripts/delivery` modules/tests only. No provider API was invoked for implementation or testing. Explicit local transport fixtures exercise the Cloudflare v4 wire contracts used by pinned Wrangler; they are **not provider permission, provisioning, deployment or readiness evidence**. No account/credential coordination, secret handling/rotation, resource creation, migrations, deployment, workflow activation or public activation has been performed or authorized. WO-35 telemetry/privacy remains outside this lane.

## Module interfaces and stage boundary

- `model.ts`: strict Effect Schemas for request, retained identity and journal; stage-specific safe errors/recovery; structured release handoff. Account IDs and UUIDs are installation inputs, never repository defaults. Tests use visibly synthetic values.
- `provider.ts`: injected transport behind the Effect `Provider` service. Reads the authorized account's existing workers.dev subdomain, Worker settings and explicitly identified D1; creates D1 only for an explicit fresh create. Uses exact `/accounts/{account}/workers/subdomain`, `/workers/scripts/{name}/settings`, `/d1/database/{uuid}` and POST `/d1/database` contracts. No listing accounts/databases, name guessing, provider login, retry of a POST, remote SQL, Worker upload or domain write. Timeout/redirect/network/HTTP/schema failures are fail-closed and dependency payloads are never reported.
- `provision.ts`: checks retained identity before provider calls, checks origin/Worker binding before create, durably records intent before a side effect and resolved identity before returning. A Worker with conflicting/multiple D1 bindings is refused. Repeated create against a resolved identity uses its ID, never creates replacement storage. A pending intent requires owner reconciliation and explicit bind, even if the original response failed before returning an ID. No attempt to infer that a missing response meant no resource was created.
- `identity-file.ts`: exclusive local lock, private mode0600 JSON, strict schema, fsync+atomic rename, external non-symlinked directory. No credentials in state. Stale lock or pending file fails closed; the owner must inspect/reconcile before removal. The lock coordinates **one local journal**, not provider Builds or multiple hosts; per-installation release serialization is WO-34. Keep one authoritative journal per installation, never run separate create journals for the same Worker.
- `cli.ts`/`main.ts`: local `plan` versus explicitly gated `provision`, cancellation and missing authorization fail before input/credential/provider access. No ambient provider fallback in tests. CLI confirmation/source flags attest owner intent, not independently proven grants. Main reads the securely supplied deployment token only after all remote gates; no login or broadening.

`provision` returns `status: provisioned-not-ready`, retained `identity`, `binding` (`DB`, exact D1 ID/name, migration directory), and Worker name/default workers.dev/canonical origin configuration. The Worker identity is a **target name**, not an uploaded Worker/version; the default origin is resolved from provider account configuration, not evidence the URL is live. Build, initialization, deployment and readiness remain `not-run`. WO-34 must consume this result rather than duplicate provisioning or manufacture ready status.

## Narrow parent integration request (not edited in this lane)

Root files remain owned by the parent integration owner. Before qualifying the README button/Workers Builds path, integrate and verify these bounded changes:

1. Add root plan/provision aliases pointing to `pnpm exec tsx scripts/delivery/main.ts` if desired; retain the direct root CLI invocation documented in README. Do not add a deployment-success alias until WO-34 exists.
2. Wire installation-specific resolved `DB` identity and `CANONICAL_ORIGIN` into the authoritative **complete** root Worker build/deploy target without committing resource IDs. Root currently has `workers_dev: false`; the authorized installation target must enable workers.dev while preserving all asset/API routing, compatibility settings and migration paths. Do not deploy merely to test that patch.
3. Demonstrate the official button/Workers Builds native D1 create-or-bind/resolved-identity handoff into the ordered release lifecycle. The provider button does **not** call this CLI automatically. Do not wire a plain `wrangler deploy` that can activate ahead of migrations, or blindly add `--confirm` in an unattended build. Initial source/account/resource/paid-resource authorization and confirmation must be genuine.
4. WO-34 consumes the retained identity, serializes releases, records source revision/version, verifies complete build/contracts, applies native versioned migrations before activation and performs origin-correct complete-app readiness. No initial runtime secrets, registry or foreign seed data. Custom-domain changes must keep workers.dev usable. No telemetry-boundary change is needed.

These are integration/qualification prerequisites, not claims implemented here. Neither a README badge nor a fixture success completes AC-INST-001.2/001.3 or the provider branch of AC-INST-002.

## Provider-only proof: existing owner and scoped D1 access required

The existing local Codex provider owner must accept a scoped handoff **before any provider call, even read-only probing**. This implementation task has no such grant. Do not obtain access by reading existing secrets or using an inspection integration. The old read-only Actions token is not D1 authorization.

| Evidence still required                                                                                                      | Explicit authorization / access needed                                                                                                                  | Acceptance concern                             |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Genuine official button, account/source authorization, explicit Deploy confirmation; denied/cancelled flow does not complete | Owner-controlled Cloudflare login, source-provider connection, selected account and exposure/resource terms                                             | AC-INST-001.1–001.6                            |
| Fresh D1 creation and exact returned binding; explicit bind; retry reuses same D1; no foreign records                        | Scoped D1 resource read/create/edit for the agreed account; retained identity storage; authorized disposable installation                               | AC-INST-003.1/003.5; AC-INST-004.2             |
| Account workers.dev resolution, Worker settings/bindings, default address and provider-managed identity persistence          | Scoped Workers/account metadata reads and later explicitly authorized Worker deployment/configuration rights                                            | AC-INST-002.1/002.2                            |
| Build → ordered remote migrations → activation → complete same-origin web/API/docs/discovery and persistence; failure stages | Separate WO-34 implementation prerequisite plus explicitly authorized remote D1 migrations and Worker/assets activation; disposable mutation-test scope | AC-INST-002.3–002.7; WO-37                     |
| Data-preserving update/retry and compatible application rollback after committed migrations                                  | Authorized prior-version disposable D1 and releases, mutation/retention/recovery test scope; no reset or automatic DB reversal                          | AC-INST-004; supported read checkpoints; WO-37 |
| Optional custom domain with workers.dev preserved and trusted canonical origin                                               | Separate bounded domain/DNS/route permission and activation approval, only if chosen                                                                    | AC-INST-005                                    |

No billing tier, broader token, public listing, provider-write permission or readiness approval is inferred from this table. Missing access blocks only these provider checks; independent local code/tests proceed. Parent owns independent review, coordinated merge, exact-main proof and final order disposition. WO-33 remains In review after code handoff, not Complete. WO-34 starts only on the parent's next explicit authorization; WO-35 is not taken over.

## Local verification

Run with pinned Node22.23.2/pnpm10.34.9:

```sh
pnpm exec vitest run scripts/delivery/delivery.test.ts
pnpm check
pnpm build
```

Tests use a throwing ambient `fetch`, explicitly injected HTTP fixtures and real disposable local identity files. They exercise request/schema rejection, missing confirmations, cancellation, source/account authorization gates, Cloudflare envelopes/statuses/paths/payloads, create versus bind, retained ID and origin, conflicting Worker bindings, uncertain-create recovery, locked/corrupt/symlinked state, durable-intent failure and non-ready results. They do not run provider CLI commands, execute remote SQL, probe a live workers.dev URL or count skipped checks as provider proof.
