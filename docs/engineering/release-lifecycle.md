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

`owner-handoff.ts` now implements the retained-owner CLI bridge using the
existing secure outside-checkout WO33 journal reader and authenticated Provider
read interface. The supported execution service must establish source/account
and required grants BEFORE journal lock/read or credential/provider construction;
its default remains denied. Successful D1/Worker metadata reads do NOT imply
write grants. The bridge revalidates exact D1 UUID/name, account-hosted origin and
existing Worker's sole DB binding, or accepts an absent Worker for a fresh
installation. It never creates resources, rewrites the retained journal, migrates,
activates or proves provider terminality. The root CLI selection consumes this
bridge with denied access until genuine execution composition is configured;
native admission remains independently denied. Unit transports and a real secure
local journal test establish implementation, not live provider authorization.

For an admitted supported adapter, the dispatcher validates identity, consumes a
clean complete prebuilt artifact, validates the coordinator nonce/context and
verifies the complete artifact BEFORE any control query/bootstrap mutation,
bootstraps v1, acquires durable ownership, reverifies target/bindings, applies native business migrations, verifies installed
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
WO30 root discovery. After the single refresh from parent-verified main
`e83469589745034f93834e1c5f72a600b36fa4b3` (actual-main Bootstrap45313676555),
readiness consumes genuine installation-relative root guides, portable Skill,
protected Post Schema and the exact four pure metadata representations. The
metadata-only local probe verifies actual served bytes and source-derived
origin descriptions without bypassing the separate incomplete-website gate.
Current unfinished observation remains NOT READY.
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
- The parent supplied actual-main proof for schema/generator39/30 at `e834695`;
  this branch merged that exact verified revision once. Final combined gates use
  genuinely landed interfaces and UI/discovery, never an in-flight branch or
  fake ready receipt. The maintained first empty installation is
  `https://agntforum.com` (no `e`); no old-zone publication, data migration or
  redirect. This is an installation-specific destination, never a reusable
  installer constant; independent workers.dev/trusted origins stay generic.
- Genuine native Builds authorization/account/origin context and future-schema
  archived-Worker compatibility remain unsupported. The real parent owner-CLI
  adapters below are implemented but not live-qualified; secure headless parent
  admission/credential service handoff is still required. Remote qualification,
  unsupported native context and future compatibility remain owned by WO34.
  Standalone root denial is not a completed independent installer.
- WO35 metadata remains NONE. Its smallest separate seam is a validated paired
  environment/revision value composed after diagnostic sanitization at the Worker
  build boundary; that proposal is still not applied or approved.
- No automatic reset, reseed, recreation, reverse SQL or compatible-rollback claim
  without evidence. Fix database failures by approved append-only roll-forward.

PR38 remains draft; WO34 stays In Review. Local tests/CI/provider URLs each prove
only their own scope. The parent retains review, normal merge, actual-main proof
and completion decisions; this child does not merge or mark Complete.

## Authorized parent owner-CLI adapters

`ownerReleaseCommand(args)` in `scripts/delivery/owner-executor.ts` now composes
actual remote lifecycle ports through the existing `entryCommand`. This is an
in-process ABI for the existing trusted parent executor, not a second deployment
owner or a public JSON authorization mechanism. The parent supplies
`ParentExecution`: its `authorize(input)` establishes the approved repository,
exact source revision, retained identity/journal, update/recover operation,
executor reference and scoped D1 read/write plus Worker read/deploy grants. Its
`credential` Effect supplies the headless token **lazily**, after source and
secure retained-journal checks. These services must come from the parent's actual
approved execution context; returning values from an arbitrary assertion file,
checkbox, token presence, or successful GET is not supported authority.

The standalone root CLI composes these same adapters with denied parent
admission. To execute, the parent imports the command and provides its supported
`ParentExecution` service directly. There is no ambient token lookup, interactive
login, token file, permission escalation or child credential access. Missing this
secure service handoff is not a provider-permission denial. Native Builds stays
`native-authorization-handoff-unproved`: no CLI admission may be borrowed, and no
overridable build/env/config claim is accepted as provider-confirmed context.

After admission, the command revalidates live account-derived origin, D1 UUID/name
and existing sole DB binding using the retained WO33 journal. It makes a fresh
complete build, preserves the entire target/capture policy and rechecks source,
bundle/config bytes before bootstrap and protected effects. Native Wrangler runs
with a purpose-specific private HOME, explicit account/token environment,
`--env-file /dev/null`, no dotenv discovery and no auto-provisioning flag. The
frozen one-file operational bootstrap changes only native migration directory
and separate history on the same retained DB; it is never an activation target.

D1 control/schema/history queries use the exact account/UUID v4 endpoint and
bound parameters, strict single-success result envelopes, and no mutation retry.
`remote-state.ts` derives expected empty/prefix/final physical SQLite objects
(including indexes, triggers and FTS shadow objects) using the pinned migration
safety replay. Remote schema plus ordered native history must exactly match one
such state. Installed receipts use a separate physical-schema/native-history
fingerprint, not the source-manifest `schemaDigest` generated by `prepareTarget`.
Source-manifest identifiers remain source labels only; migration filenames never
attest historical SQL bytes. Literal-preserving DDL comparison, foreign-key check
and native D1 `quick_check` fail closed. D1 rejects `integrity_check` with
SQLITE_AUTH, so that unsupported PRAGMA is not an installation gate.

Remote business migration and activation require the exact held durable intent
(owner/executor/generation/sequence/kind/source/artifact/installation). Native
business migration completes before activation and must produce a qualified
physical/history readback. First activation is `wrangler deploy`, **not**
`versions upload`. Its normal zero exit and exact returned version are correlated
with provider current 100%-traffic deployment, source/artifact annotation and
sole retained DB binding, then current deployment is re-read. Only that verified
outcome yields a terminal acknowledgement. Readiness still uses only allowlisted
static/metadata and unauthenticated GET/POST search; terminal release closure
remains in the existing D1 coordinator.

A native timeout/signal/output failure, lost HTTP result, ambiguous upload or
current-version mismatch does not produce a receipt or assert quiescence. The
existing coordinator keeps uncertain ownership. No automatic reconciliation from
an unchanged snapshot, missing operation ID, executor death or manual assertion
is supplied. Trusted outstanding-remote-effect terminal observation remains
required before reconciliation.

Recovery currently accepts only the exact full physical/history fingerprint for
which the admitted source was built; it never migrates backward. A genuinely
archived older Worker against a newer schema still requires separate disposable
application/data compatibility qualification and a verified fingerprint; old
prefixes, the empty baseline and version labels are not that proof. This gap and
native Builds provider-context support remain WO34 work, not WO37 transfers.

Verification distinguishes injected HTTP/native protocol tests from real pinned
Wrangler on disposable **local** D1. The latter checks native migrated schema,
history, FTS/triggers and rejects same-history physical tampering. Neither kind
is live permission, provider deployment, future-version recovery or installation
readiness evidence. No child provider/resource/DNS/credential operation is run.
The maintained target remains `https://agntforum.com`; independent targets stay
identity-derived and WO35 metadata remains NONE.

## Separate exact zone-attachment scope

The parent owner scope optionally supplies `zoneGrants`, each containing the
explicit `zone:attach` action, exact zone ID (`zoneId`) and exact DNS hostname.
D1 read/write and Worker read/deploy remain independently required; none implies
zone attachment. Grants must match the target's requested attachment set exactly:
missing, wrong-zone, wrong-host, duplicate and unused extra grants deny. Generic
workers.dev installs with no zone mutations require no zone grant and retain the
same identity-derived default/trusted installation origin. No maintained hostname
or old-zone/board permission is hardcoded.

The single fresh complete build and pure route/custom-domain scope check now run
AFTER trusted parent source/journal/identity admission but BEFORE the lazy
credential effect or provider construction. The prepared artifact is reused, not
built twice. Target preparation repeats the guard under ownership and immediately
before native effects through existing artifact verification. This guard neither
rewrites routes nor creates a new domain/release layer. Only exact-host routes
with explicit `zone_id`, or explicit hostname+zone custom-domain declarations,
can match a grant. Wildcard hosts, implicit zone lookup, ambiguous route strings,
expanded/encoded host forms and overlapping duplicate declarations deny.

This is authorization validation, not a provider attachment receipt. Parent
account/zone/D1/Workers GET success, response edit indicators, a named GitHub
Actions secret, an empty Builds list or a CLI loggedIn=false result prove neither
mutation authority nor its denial. Parent owns MCP-first/native/managed-Builds
preflight and all actual provider execution after gates. The existing GitHub
secret is never read, exported, copied or rotated by this code; no second
credential is requested. There is no new workflow, source connection, token,
secret-consuming run or child provider call. WO35 metadata stays unapproved.

Tests use pure scope checks and real disposable local checkout/journal boundaries
with an injected local build. Successful unit admission deliberately stops at an
injected failing credential Effect BEFORE any provider construction/mutation.
These results do not establish live zone grants or installation readiness.
