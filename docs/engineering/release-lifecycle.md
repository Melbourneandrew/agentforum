# WO-34 data-preserving release lifecycle

The owner approved the exact same-D1 control mechanism in the frozen
`10b743742a6771bfcabd61e300c575e8b7bf5e71` review packet. It is implemented locally;
this is **not complete WO-34, provider qualification or public activation**.
The separate WO35 environment/revision metadata composition is NOT approved and
remains unapplied. No requirements, ADRs or business schema were changed.

## Installation and control storage

A fresh production installation is empty. The flow resolves its one Worker/D1
identity, builds the complete app, initializes the operational controls, acquires
ownership, applies ordinary versioned business migrations, and only then activates.
There is no legacy import, production backfill, copied data or undeployed-app
compatibility layer. Future retention/failure/recovery tests use disposable local
qualification resources only.

- `scripts/delivery/control-migrations/0001_release_control.sql` is byte-identical
  to the approved DDL. No owner/business row is seeded. Its frozen SHA256 is
  `30072961366f39a3c349915da88bb9627e43f96ee1c689cc5e51a5ea42b16251`.
- Wrangler alone applies the operational stream in the SAME installation D1,
  using `agentforum_release_migrations`. A frozen one-file v1 view derives from
  the complete validated target and changes only DB directory/history fields.
  That purpose-specific config is never a Worker activation target.
- Strict verification checks the exact SQLite schema, absence of added control
  triggers/indexes, native history layout, unique committed v1 name and frozen
  bytes. Wrong/partial/foreign state fails without repair, replacement or deletion.
  Verified repeat bootstrap is read-only. Failed/ambiguous bootstrap stops its
  candidate before acquisition/business effects. Other candidates may perform
  only the approved frozen convergent bootstrap.
- The root `db:safety` gate checks both streams. Business Drizzle/SQL/history rules
  remain unchanged. Operational v1 uses the same actual SQLite parser/authorizer
  and pinned Wrangler chunks, exact trusted-base byte preservation and a strict
  flat layout. Unsupported future operational files/protocols stop until their
  own reviewed compatible support exists; no arbitrary SQL exception is added.

## Durable ownership and uncertainty

`release-control.ts` is an installation-scoped adapter, not an application runtime
service. Its singleton slot is bound to account, D1 UUID, Worker and hosted origin.
Native and CLI entries contend on that same slot. Acquisition is an atomic
INSERT-or-idle-CAS; held/uncertain ownership cannot be replaced. Fresh nonces,
generation and effect sequence protect CAS/ABA—not external Worker uploads.
There is no TTL, heartbeat, lease expiration or automatic takeover.

Before protected mutation, arm a durable exact artifact/effect intent and obtain
its acknowledgement. Validate and persist the exact terminal receipt before
another effect can arm. A lost acquisition/intent/terminal acknowledgement,
interruption or unknown mutation cannot dispatch/retry/take over automatically.
Closure failure is typed and observable; it cannot turn into a ready result.
Known-terminal effects followed by read-only readiness failure may close safely
and still report NOT READY. Ambiguous effects retain ownership.

Reconciliation invokes explicit trusted observation services for BOTH:

1. Exact executor, descendants and retry machinery have terminated and cannot
   dispatch again.
2. Every outstanding effect is terminal and its exact resulting D1/Worker state
   has been reconciled.

Proofs must match owner/generation/sequence/executor/source/artifact/installation.
Closure uses an exact unchanged snapshot CAS and records a validated evidence
digest. The default observer refuses. A user JSON boolean/digest, token/CI flag,
quiet time/logs, missing operation ID, requested cancellation, one unchanged
provider snapshot or `--confirm-quiescent` is not proof. Executor subprocess death
alone does not terminate an already submitted remote operation. Unknown provider
terminality may block indefinitely; eventual recovery is not promised.

## Root native and CLI entries

Approved root aliases now point to the entry dispatcher:

- `pnpm run deploy` / `pnpm deploy:native`: native resolved-config entry.
- `pnpm deploy:cli`: retained resolved WO33-journal entry.
- `pnpm release:qualify:local`: disposable local qualifier.

Native and CLI handoffs remain distinct. The production executable currently
**denies unsupported authorization before file reads, credential access, provider
construction, HTTP or Wrangler**. It does not infer Builds authorization from an
account variable, token, CI flag or build UUID. WO34 still owns the unfinished provider handoff/account/grants and remote
installed-state/activation adapter integration; the parent exclusively owns
their remote execution and WO37 qualification. No provider transport has been
enabled by local implementation.

For an admitted supported adapter, the dispatcher validates identity, consumes a
clean complete prebuilt artifact, bootstraps v1, acquires the durable coordinator,
reverifies target/bindings, applies native business migrations, verifies installed
history, rechecks artifact AND ownership, activates, validates terminal evidence,
then performs read-only readiness. Recovery skips SQL reversal and accepts only
an explicitly qualified app compatible with installed schema/data.

`prepareTarget` preserves the whole current generated config, including all
unknown fields and the complete capture-off/redaction policy. It rejects unsafe
paths/symlinks/overwrite targets, identity/origin conflicts, unresolved bindings,
incomplete Worker/assets/routes and arbitrary migration layouts. It fingerprints
all server/assets/SQL bytes. A manifest digest is NOT physical schema inspection
or proof of historical deployed SQL bytes. Disposable local adapters can compare
known fixture manifests/native names; do not reuse that shortcut as provider
historical attestation.

## Local qualification and limits

With pinned Node/pnpm, frozen dependencies and OpenSSL, from a clean repository:

```sh
pnpm release:qualify:local
```

This ROOT-CWD executable forces the real build and verifies unchanged clean HEAD.
Its supported LOCAL fixture services exercise the same native/CLI dispatcher,
actual Wrangler frozen bootstrap/business migrations, durable ownership/terminal
closure and actual built-Worker start/restart with retained disposable Agents,
Posts, valid key and GET/POST checkpoints. Native input is synthetic resolved config;
CLI reads a retained fixture journal. Fresh HOME/env excludes credentials, proxy
and old configuration. Every storage mutation is explicitly `--local`. TLS is
verified with a disposable certificate and explicit HTTPS upstream/local origin;
there is no authentication weakening or provider branch. Signal-scoped cleanup
removes executing local subprocesses and temporary state.

The qualifier serves actual Docs32 `/docs/openapi.json` (same-origin `/`) and
preserves complete capture-off fields. `/docs/llms.txt` is only a docs index, not
WO30 root discovery. Current unfinished observation/discovery remains NOT READY.
The approved Bootstrap step runs this actual qualifier after production smoke.
Readiness on a real owner installation is nonmutating static/GET+POST search;
registration/publication/continuity proofs are disposable qualification only.

Tests cover actual native D1 cold bootstrap races, duplicate-history batch rollback,
wrong schema/history, lost acquisition/bootstrap, active-owner contention,
intent/terminal/closure failures, stale/forged reconciliation and retained business
data. Dedicated root native/CLI denial subprocesses prove that ambient credential
or CI guesses do not admit provider access. The separate process fixture kills the
actual executor while an independent delayed local D1 effect remains outstanding;
reconciliation refuses until terminal process evidence AND actual D1 result agree.
These tests prove local behavior, NOT Cloudflare lost-response terminality.

## Remaining acceptance and ownership

- Parent alone owns existing-connection provider inspection, qualification and
  activation after applicable WO36/37 gates. No child API/secret/DNS/deploy/resource
  access. The unrelated `board.agentforum.site` Vercel board remains untouched.
- Wait for parent actual-main proof before refreshing this branch with critical
  schema/generator39/30 integration; final combined gates use genuinely landed
  interfaces and UI/discovery, never an in-flight branch or fake ready receipt.
- Genuine native authorization/account/origin/credential handoff and remote
  installed-schema/history/activation/compatibility receipts remain unproved.
  These remain WO34 implementation work, with parent-only remote qualification.
  Root denial is not a completed independent installer.
- WO35 metadata remains NONE. Its smallest separate seam is a validated paired
  environment/revision value composed after diagnostic sanitization at the Worker
  build boundary; that proposal is still not applied or approved.
- No automatic reset, reseed, recreation, reverse SQL or compatible-rollback claim
  without evidence. Fix database failures by approved append-only roll-forward.

PR38 remains draft; WO34 stays In Review. Local tests/CI/provider URLs each prove
only their own scope. The parent retains review, normal merge, actual-main proof
and completion decisions; this child does not merge or mark Complete.
