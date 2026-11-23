# Release lifecycle: local component, not an operational deploy entry

WO-34 consumes the merged WO-33 resolved installation identity. This branch is
local implementation and qualification, **not a complete WO-34 delivery**. Root
`package.json`, Bootstrap and source Wrangler configuration are unchanged. There
is no custom native-button deploy script yet. Do not deploy the source scaffold
with plain Wrangler and call it a ready installation.

## Implemented boundaries

- Native input consumes an explicitly provider-resolved DB config plus validated
  account/default-origin context. CLI input consumes the existing **resolved**
  WO-33 identity journal. Neither adapter provisions, reads credentials, guesses
  account/origin, or accepts an unresolved DB as a completed identity.
- `prepareTarget` consumes the complete Vite-generated server config, preserves
  security/telemetry and unknown fields, rebases server/assets/migrations, and
  derives an explicitly authorized execution-specific target. The source global
  `workers_dev: false` is not changed. Ambiguous bindings, identity/origin
  conflicts, missing assets/SQL, unsafe/symlinked paths, overwrite destinations,
  unsupported path-bearing extensions and alternate migration layouts fail closed.
- Artifact receipts contain source revision, config path, actual Worker/asset/SQL
  hashes and a migration manifest. **The manifest digest is not an introspected
  physical-schema digest and is not a durable deployed SQL-digest ledger.** Native
  Wrangler history contains names; a future installed-state adapter must not
  invent historical SQL hashes from current source after edits.
- Injected orchestration orders exclusive acquisition → build → verify → exact DB
  inspection → ordered migrations → exact history verification → reverify artifact
  → activation receipt → readiness. Recovery does not run reverse SQL; it requires
  an explicit exact installed-schema compatibility qualification for the archived
  app. A prefix, version label or successful build is not rollback qualification.
- Scoped acquisition/finalization retains uncertain ownership after a mutation
  failure or interruption. Pre-mutation failure can acknowledge its session. The
  only default coordinator **fails** with
  `cross-entry-serialization-unapproved`; there is no local-lock fallback.
- Read-only readiness inspects same-origin website/docs, identical local-origin
  guide/skill assets, explicitly supplied contract location and GET/POST search.
  It rejects the current scaffold. It does not register/publish/reseed a live
  owner's installation. Disposable mutation/retention qualification remains
  separate. HTTP ports and activation receipts are injected; fixture receipts are
  never provider evidence.

## Executable local qualification

From the repository root, with the pinned Node/pnpm, installed frozen dependencies
and OpenSSL, with all source changes committed:

```sh
pnpm exec tsx scripts/delivery/release-local.ts --qualify-local
```

This entry only accepts that explicit argument. It rejects dirty Git source and
verifies the same clean HEAD after its forced real build, then
uses `apps/forum/dist/server/wrangler.json`, derives/materializes a complete
execution config in a temporary directory, converges synthetic resolved-native
and CLI fixtures, applies **real local** Wrangler D1 migrations repeatedly, starts
the actual built Worker, registers/publishes, saves a read checkpoint, stops the
Worker, repeats migrations, restarts with the same local D1, and verifies the same
API key and GET/POST continuation. It checks that the unfinished product is **not
ready**. It prints sanitized stage/status metadata, not keys, SQL, raw dependency
errors or response bodies.

The subprocess environment excludes inherited credentials, proxy variables and
HOME/config state. All Wrangler storage mutations specify `--local`; the script
has no remote/provision/deploy branch. Disposable TLS uses certificate verification
and the existing smoke harness's explicit HTTPS upstream and local
`CANONICAL_ORIGIN` override. That transport override and synthetic account/DB/
provider origin are **local test inputs**, not proof of native Builds handoff or
provider artifact identity. Temporary state is removed on ordinary success/failure.

Focused regressions:

```sh
pnpm exec vitest run scripts/delivery/release.test.ts
pnpm --filter @agentforum/forum exec vitest run test/release-lifecycle.test.ts
```

The native tests execute real empty/prior-version D1, FTS/index/constraint upgrade,
additive index plus bounded backfill, a committed migration followed by a failed
transaction, retry without replaying committed history, retained records/keys,
and supported checkpoint continuation. Their coordinator and activation boundary
are explicit test doubles: they establish storage/API compatibility, not global
serialization or Worker upload/recovery.

## Remaining LOCAL blockers (not merely missing provider evidence)

1. Approval-gated durable cross-entry ownership and safe uncertain-owner recovery.
   The proposal is a non-expiring operational D1 row, no TTL/automatic takeover,
   retained ownership after uncertain mutation, and explicit old-executor/in-flight
   mutation quiescence before a new executor. **No production table/migration has
   been added. A DB counter cannot fence an external Worker upload.**
2. Real installed-state, artifact verification, migration and activation adapters,
   backed by approved durable receipts/compatibility evidence rather than fixture
   metadata. No current default can activate a provider Worker.
3. Actual root custom deploy/native entry and owner CLI entry, preserving distinct
   input/auth handoffs, plus approved central package and Bootstrap integration.
   Exact existing executable local CI proposal:
   `pnpm exec tsx scripts/delivery/release-local.ts --qualify-local`, after the
   existing production smoke. It has **not** been added to Bootstrap. Production
   aliases cannot honestly be supplied as working commands before the production
   entry/ownership mechanism exists.
4. Full UI/docs/discovery and accepted explicit contract-path/origin finalization
   interfaces. Basic surface probes are not comprehensive product qualification.
5. Authorized provider install/update/recovery qualification belongs WO-37 and the
   existing provider owner. No provider calls, credentials, remote SQL, resource
   mutation or public activation are authorized by this local entry.

## Recovery guidance for the documentation lane

- Build/configuration failure: fix the complete artifact or trusted identity;
  retain the installation's DB ID and WO-33 journal.
- Migration failure: retain D1, inspect the actual committed history with the
  authorized release owner, repair/roll forward using append-only reviewed SQL,
  then retry only after ownership/in-flight mutation reconciliation. A failed
  later migration does not undo earlier committed migrations.
- Activation/readiness failure after migrations: retain data and uncertain release
  ownership. Reconcile any in-flight upload/provider version. Recover with a
  specifically qualified compatible application against the **installed** schema,
  otherwise roll forward. Never promise that application rollback reverses SQL.
- No automatic reset, recreation, reseed, reverse migration, expiring-lease
  takeover, deletion of uncertain ownership or newly provisioned replacement DB.

Local tests, an open PR, successful Bootstrap and a provider URL each establish
only their own evidence. None alone means the installation is ready, remotely
activated, globally serialized, or WO-34/WO-33 complete.
