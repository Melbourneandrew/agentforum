// Real clean disposable checkout + secure journal, injected local build only.
// Credential effect intentionally stops successful admission before any provider.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Either, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { Identity, failure } from "./model.js";
import {
  ownerReleaseCommand,
  ParentExecution,
  type OwnerScope,
} from "./owner-executor.js";
const zoneId = "a".repeat(32),
  hostname = "forum.example.com";
const grant = { action: "zone:attach", zoneId, hostname } as const;
const identity = Schema.decodeUnknownSync(Identity)({
  version: 1,
  accountId: "b".repeat(32),
  workerName: "fixture-forum",
  databaseName: "fixture-db",
  databaseId: "11111111-1111-1111-1111-111111111111",
  defaultOrigin: "https://fixture-forum.owner.workers.dev",
});
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const fixture = (attachments: Record<string, unknown>) => {
  const directory = mkdtempSync(join(tmpdir(), "wo34-zone-admission-"));
  roots.push(directory);
  const root = join(directory, "source");
  execFileSync("git", [
    "clone",
    "--quiet",
    "--no-hardlinks",
    process.cwd(),
    root,
  ]);
  const journalPath = join(directory, "identity.json");
  writeFileSync(journalPath, JSON.stringify({ state: "resolved", identity }), {
    mode: 0o600,
  });
  const config = {
    name: "agent-forum",
    main: "index.js",
    no_bundle: true,
    workers_dev: false,
    preview_urls: false,
    compatibility_date: "2026-11-02",
    compatibility_flags: ["nodejs_compat"],
    vars: {},
    secrets: { required: [] },
    assets: {
      directory: "../client",
      binding: "ASSETS",
      run_worker_first: ["/v1", "/v1/*"],
    },
    observability: { enabled: false },
    d1_databases: [
      {
        binding: "DB",
        database_name: "agent-forum",
        migrations_dir: "../../migrations",
      },
    ],
    ...attachments,
  };
  // Inject a private local IPC build fixture, not PATH/CLI grant flags.
  // Parent still owns the fork, validates readback/clean exit and checks exact
  // clean source on both sides. This synthetic artifact is NOT readiness proof.
  const entry = "apps/forum/scripts/owner-build.ts";
  writeFileSync(
    join(root, entry),
    `import fs from "node:fs"; import p from "node:path";
process.once("message", input => {
  const base=p.join(process.cwd(),"dist");
  fs.mkdirSync(p.join(base,"server"),{recursive:true}); fs.mkdirSync(p.join(base,"client"),{recursive:true});
  fs.writeFileSync(p.join(base,"server/index.js"),'export default {fetch(){return new Response("unit fixture")}}');
  fs.writeFileSync(p.join(base,"client/fixture.txt"),"not readiness evidence");
  fs.writeFileSync(p.join(base,"server/wrangler.json"),${JSON.stringify(JSON.stringify(config))});
  process.send({version:1,kind:"built",revision:input.revision,metadata:input.metadata}, () => process.exit(0));
});`,
  );
  execFileSync("git", ["add", entry], { cwd: root });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=LocalFixture",
      "-c",
      "user.email=fixture@invalid",
      "commit",
      "--quiet",
      "-m",
      "test: private local build fixture",
    ],
    { cwd: root },
  );
  const revision = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const scope: OwnerScope = {
    repository: root,
    journalPath,
    identity,
    sourceRevision: revision,
    executorRef: "trusted-parent:zone-unit",
    operation: "update",
    grants: ["d1:read", "d1:write", "worker:read", "worker:deploy"],
  };
  return scope;
};
const invoke = async (scope: OwnerScope) => {
  let credentials = 0;
  const result = await Effect.runPromise(
    Effect.either(
      ownerReleaseCommand(["cli", "--identity", scope.journalPath]).pipe(
        Effect.provideService(ParentExecution, {
          authorize: () => Effect.succeed(scope),
          credential: Effect.suspend(() => {
            credentials++;
            return Effect.fail(
              failure("authorization", "unit-stop-before-provider"),
            );
          }),
        }),
      ),
    ),
  );
  return { result, credentials };
};
describe("zone guard is before real owner credential boundary", () => {
  it.each([
    "missing",
    "wrong-zone",
    "wrong-host",
    "extra",
    "duplicate",
  ] as const)(
    "Worker+D1 grants cannot permit %s zone authority",
    async (mode) => {
      const scope = fixture({
        routes: [{ pattern: `${hostname}/*`, zone_id: zoneId }],
      });
      const zoneGrants =
        mode === "missing"
          ? []
          : mode === "wrong-zone"
            ? [{ ...grant, zoneId: "c".repeat(32) }]
            : mode === "wrong-host"
              ? [{ ...grant, hostname: "other.example.com" }]
              : mode === "extra"
                ? [grant, { ...grant, hostname: "other.example.com" }]
                : [grant, grant];
      const { result, credentials } = await invoke({ ...scope, zoneGrants });
      expect(Either.isLeft(result) && result.left.code).toBe(
        "zone-attachment-authority-mismatch",
      );
      expect(credentials).toBe(0);
    },
  );
  it("custom_domains also deny before credential access", async () => {
    const { result, credentials } = await invoke(
      fixture({ custom_domains: [{ hostname, zone_id: zoneId }] }),
    );
    expect(Either.isLeft(result) && result.left.code).toBe(
      "zone-attachment-authority-mismatch",
    );
    expect(credentials).toBe(0);
  });
  it("exact separate route grant reaches only intentional credential stop; no provider/mutation", async () => {
    const scope = fixture({
      routes: [{ pattern: `${hostname}/*`, zone_id: zoneId }],
    });
    const { result, credentials } = await invoke({
      ...scope,
      zoneGrants: [grant],
    });
    expect(Either.isLeft(result) && result.left.code).toBe(
      "unit-stop-before-provider",
    );
    expect(credentials).toBe(1);
  });
  it("generic workers.dev target needs no zone grant or custom-zone architecture", async () => {
    const { result, credentials } = await invoke(fixture({}));
    expect(Either.isLeft(result) && result.left.code).toBe(
      "unit-stop-before-provider",
    );
    expect(credentials).toBe(1);
  });
  it("approved canonical label without attachment needs NO zone grant", async () => {
    const scope = fixture({});
    const { result, credentials } = await invoke({
      ...scope,
      canonicalOrigin: "https://forum.example.com",
      zoneGrants: [],
    });
    expect(Either.isLeft(result) && result.left.code).toBe(
      "unit-stop-before-provider",
    );
    expect(credentials).toBe(1);
  });
  it.each([undefined, "https://approved.example.com"])(
    "unapproved/conflicting raw canonical %j denies before credential",
    async (canonicalOrigin) => {
      const scope = fixture({
        vars: { CANONICAL_ORIGIN: "https://hostile.example.com" },
      });
      const { result, credentials } = await invoke({
        ...scope,
        ...(canonicalOrigin === undefined ? {} : { canonicalOrigin }),
      });
      expect(Either.isLeft(result) && result.left.code).toBe(
        "canonical-origin-conflict",
      );
      expect(credentials).toBe(0);
    },
  );
  it("malformed parent canonical denies before build/journal/credentials", async () => {
    const scope = fixture({});
    const { result, credentials } = await invoke({
      ...scope,
      canonicalOrigin: "https://user:pass@forum.example.com/path",
    });
    expect(Either.isLeft(result) && result.left.code).toBe(
      "owner-execution-authorization-unconfigured",
    );
    expect(credentials).toBe(0);
  });
  it("canonical label cannot authorize an actual attachment", async () => {
    const scope = fixture({
      routes: [{ pattern: `${hostname}/*`, zone_id: zoneId }],
    });
    const { result, credentials } = await invoke({
      ...scope,
      canonicalOrigin: `https://${hostname}`,
      zoneGrants: [],
    });
    expect(Either.isLeft(result) && result.left.code).toBe(
      "zone-attachment-authority-mismatch",
    );
    expect(credentials).toBe(0);
  });
  it("unrequested zone grant on a generic target denies before credential", async () => {
    const scope = fixture({});
    const { result, credentials } = await invoke({
      ...scope,
      zoneGrants: [grant],
    });
    expect(Either.isLeft(result) && result.left.code).toBe(
      "zone-attachment-authority-mismatch",
    );
    expect(credentials).toBe(0);
  });
});
