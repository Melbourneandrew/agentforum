import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deferred, Effect, Either, Fiber, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { Identity, failure } from "./model.js";
import {
  cliIdentity,
  decodeConfig,
  nativeIdentity,
  prepareTarget,
} from "./release-config.js";
import { Artifact, ReleaseCoordinator, ReleasePorts } from "./release-model.js";
import { release, unconfiguredCoordinator } from "./release.js";
import { inspectReadiness, ReadinessHttp } from "./release-readiness.js";

const identity = Schema.decodeUnknownSync(Identity)({
  version: 1,
  accountId: "a".repeat(32),
  workerName: "fixture-forum",
  databaseName: "fixture-database",
  databaseId: "11111111-1111-1111-1111-111111111111",
  defaultOrigin: "https://fixture-forum.owner.workers.dev",
});
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "wo34-config-"));
  roots.push(root);
  const server = join(root, "app/dist/server"),
    assets = join(root, "app/dist/client"),
    migrations = join(root, "app/migrations"),
    output = join(root, "release.json");
  for (const path of [server, assets, migrations])
    mkdirSync(path, { recursive: true });
  writeFileSync(
    join(server, "index.js"),
    "export default {fetch(){return new Response('fixture')}}",
  );
  writeFileSync(join(assets, "llms.txt"), "not readiness proof");
  writeFileSync(join(migrations, "0000.sql"), "SELECT 1;");
  const raw = {
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
      html_handling: "none",
    },
    observability: {
      enabled: true,
      logs: { enabled: true, invocation_logs: false },
    },
    d1_databases: [
      {
        binding: "DB",
        database_name: "agent-forum",
        migrations_dir: "../../migrations",
      },
    ],
    rules: [{ type: "ESModule", globs: ["**/*.js"] }],
    future_security_field: { enabled: true },
  };
  const builtConfig = join(server, "wrangler.json");
  writeFileSync(builtConfig, JSON.stringify(raw));
  const input = {
    raw,
    builtConfig,
    output,
    identity,
    sourceRevision: "b".repeat(40),
    authorizeTarget: true,
  };
  return { root, server, assets, migrations, raw, input };
};
const outcome = <A, E>(program: Effect.Effect<A, E>) =>
  Effect.runPromise(Effect.either(program));
const code = <A>(result: Either.Either<A, { readonly code: string }>) =>
  Either.isLeft(result) ? result.left.code : "unexpected-success";

describe("WO-34 complete built target", () => {
  it("converges distinct native and WO-33 inputs without provider I/O", async () => {
    const f = fixture();
    const resolved = {
      ...f.raw,
      name: identity.workerName,
      d1_databases: [
        {
          ...f.raw.d1_databases[0],
          database_name: identity.databaseName,
          database_id: identity.databaseId,
        },
      ],
    };
    expect(
      await Effect.runPromise(
        nativeIdentity(resolved, {
          accountId: identity.accountId,
          defaultOrigin: identity.defaultOrigin,
        }),
      ),
    ).toEqual(identity);
    expect(
      await Effect.runPromise(cliIdentity({ state: "resolved", identity })),
    ).toEqual(identity);
    expect(
      Either.isLeft(
        await outcome(
          nativeIdentity(f.raw, {
            accountId: identity.accountId,
            defaultOrigin: identity.defaultOrigin,
          }),
        ),
      ),
    ).toBe(true);
    expect(Either.isLeft(await outcome(nativeIdentity(resolved, {})))).toBe(
      true,
    );
    expect(
      Either.isLeft(
        await outcome(cliIdentity({ state: "intent", target: identity })),
      ),
    ).toBe(true);
  });
  it("preserves security/telemetry and rebases the complete generated target", async () => {
    const f = fixture();
    const { target, artifact } = await Effect.runPromise(
      prepareTarget(f.input),
    );
    expect(
      Schema.decodeUnknownSync(
        Schema.Record({ key: Schema.String, value: Schema.Unknown }),
      )(target).observability,
    ).toEqual(f.raw.observability);
    expect(
      Schema.decodeUnknownSync(
        Schema.Record({ key: Schema.String, value: Schema.Unknown }),
      )(target).rules,
    ).toEqual(f.raw.rules);
    expect(
      Schema.decodeUnknownSync(
        Schema.Record({ key: Schema.String, value: Schema.Unknown }),
      )(target).future_security_field,
    ).toEqual({ enabled: true });
    expect(target.assets).toEqual({ ...f.raw.assets, directory: f.assets });
    expect(target.main).toBe(join(f.server, "index.js"));
    expect(target.d1_databases[0]).toMatchObject({
      database_id: identity.databaseId,
      database_name: identity.databaseName,
      migrations_dir: f.migrations,
    });
    expect(target.workers_dev).toBe(true);
    expect(f.raw.workers_dev).toBe(false);
    expect(artifact.sourceRevision).toBe(f.input.sourceRevision);
    expect(artifact.compatibleSchemas).toEqual([]);
    const before = artifact.artifactDigest;
    writeFileSync(join(f.assets, "llms.txt"), "changed");
    expect(
      (await Effect.runPromise(prepareTarget(f.input))).artifact.artifactDigest,
    ).not.toBe(before);
  });
  it("fails closed for authorization, unresolved/conflicting targets and incomplete routing", async () => {
    const f = fixture();
    for (const input of [
      { ...f.input, authorizeTarget: false },
      { ...f.input, sourceRevision: "HEAD" },
      { ...f.input, raw: { ...f.raw, account_id: "c".repeat(32) } },
      {
        ...f.input,
        raw: {
          ...f.raw,
          assets: { ...f.raw.assets, run_worker_first: ["/v1/*"] },
        },
      },
      {
        ...f.input,
        raw: {
          ...f.raw,
          vars: { CANONICAL_ORIGIN: "https://foreign.example" },
        },
      },
      { ...f.input, raw: { ...f.raw, no_bundle: false } },
      { ...f.input, raw: { ...f.raw, secrets: { required: ["secret"] } } },
      {
        ...f.input,
        raw: {
          ...f.raw,
          d1_databases: [...f.raw.d1_databases, ...f.raw.d1_databases],
        },
      },
    ])
      expect(Either.isLeft(await outcome(prepareTarget(input)))).toBe(true);
  });
  it("rejects overwrites, ancestor symlinks, descendant symlinks and unsupported paths", async () => {
    const f = fixture();
    expect(
      Either.isLeft(
        await outcome(
          prepareTarget({ ...f.input, output: f.input.builtConfig }),
        ),
      ),
    ).toBe(true);
    symlinkSync(f.assets, join(f.root, "linked"));
    expect(
      Either.isLeft(
        await outcome(
          prepareTarget({
            ...f.input,
            output: join(f.root, "linked", "target.json"),
          }),
        ),
      ),
    ).toBe(true);
    symlinkSync(join(f.server, "index.js"), join(f.assets, "unsafe"));
    expect(code(await outcome(prepareTarget(f.input)))).toBe(
      "complete-artifact-unreadable",
    );
    expect(
      Either.isLeft(
        await outcome(
          prepareTarget({
            ...f.input,
            raw: { ...f.raw, build: { command: "foreign" } },
          }),
        ),
      ),
    ).toBe(true);
  });
  it("parses actual JSONC without echoing invalid content", async () => {
    expect(
      await Effect.runPromise(decodeConfig('{/* source */ "name":"forum",}')),
    ).toEqual({ name: "forum" });
    expect(code(await outcome(decodeConfig("secret={broken")))).toBe(
      "invalid-wrangler-jsonc",
    );
    expect(readFileSync("wrangler.jsonc", "utf8")).toContain(
      '"workers_dev": false',
    );
  });
});

const artifact = Schema.decodeUnknownSync(Artifact)({
  identity,
  sourceRevision: "b".repeat(40),
  configPath: "/fixture/target.json",
  artifactDigest: "c".repeat(64),
  schemaDigest: "d".repeat(64),
  migrations: [],
  compatibleSchemas: [],
});
const request = {
  identity,
  sourceRevision: artifact.sourceRevision,
  operation: "update",
};
const harness = (overrides: Partial<typeof ReleasePorts.Service> = {}) => {
  const events: string[] = [];
  const ports: typeof ReleasePorts.Service = {
    build: () =>
      Effect.sync(() => {
        events.push("build");
        return artifact;
      }),
    verify: () =>
      Effect.sync(() => {
        events.push("verify");
      }),
    installed: () =>
      Effect.sync(() => {
        events.push("installed");
        return {
          databaseId: identity.databaseId,
          schemaDigest: artifact.schemaDigest,
        };
      }),
    migrate: () =>
      Effect.sync(() => {
        events.push("migrate");
      }),
    activate: () =>
      Effect.sync(() => {
        events.push("activate");
        return { ...artifact, version: "fixture-version" };
      }),
    readiness: () =>
      Effect.fail(failure("readiness", "fixture-is-not-installation-proof")),
    ...overrides,
  };
  const coordinator: typeof ReleaseCoordinator.Service = {
    acquire: () =>
      Effect.succeed({
        assertHeld: Effect.void,
        close: (result) =>
          Effect.sync(() => {
            events.push(result);
          }),
      }),
  };
  const program = (value: unknown = request, guard = coordinator) =>
    release(value).pipe(
      Effect.provideService(ReleasePorts, ports),
      Effect.provideService(ReleaseCoordinator, guard),
    );
  const run = (value: unknown = request, guard = coordinator) =>
    outcome(program(value, guard));
  return { events, run, program };
};
describe("WO-34 fail-closed orchestration contracts (not provider proof)", () => {
  it("does nothing without approved cross-entry serialization", async () => {
    const h = harness();
    expect(code(await h.run(request, unconfiguredCoordinator))).toBe(
      "cross-entry-serialization-unapproved",
    );
    expect(h.events).toEqual([]);
  });
  it("orders verification/migration/activation and never calls a fixture ready", async () => {
    const h = harness();
    expect(code(await h.run())).toBe("installation-not-ready");
    expect(h.events).toEqual([
      "build",
      "verify",
      "installed",
      "migrate",
      "installed",
      "verify",
      "activate",
      "uncertain",
    ]);
  });
  it("never activates after migration failure and retains uncertain ownership", async () => {
    const h = harness({
      migrate: () =>
        Effect.fail(failure("initialization", "fixture-sql-error")),
    });
    expect(code(await h.run())).toBe("fixture-sql-error");
    expect(h.events).not.toContain("activate");
    expect(h.events.at(-1)).toBe("uncertain");
  });
  it("rejects wrong DB and build revision before any mutations", async () => {
    for (const overrides of [
      {
        installed: () =>
          Effect.succeed({
            databaseId: "22222222-2222-2222-2222-222222222222",
            schemaDigest: artifact.schemaDigest,
          }),
      },
      {
        build: () =>
          Effect.succeed({ ...artifact, sourceRevision: "e".repeat(40) }),
      },
    ]) {
      const h = harness(overrides);
      expect(Either.isLeft(await h.run())).toBe(true);
      expect(h.events).not.toContain("migrate");
      expect(h.events.at(-1)).toBe("acknowledged");
    }
  });
  it("retains ownership when interrupted during a migration", async () => {
    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<boolean>();
        const h = harness({
          migrate: () =>
            Deferred.succeed(entered, true).pipe(Effect.zipRight(Effect.never)),
        });
        const fiber = yield* Effect.fork(h.program());
        yield* Deferred.await(entered);
        yield* Fiber.interrupt(fiber);
        return h.events;
      }),
    );
    expect(events.at(-1)).toBe("uncertain");
    expect(events).not.toContain("activate");
  });
  it("refuses unqualified rollback without running SQL", async () => {
    const h = harness();
    expect(code(await h.run({ ...request, operation: "recover" }))).toBe(
      "rollback-schema-compatibility-unproven-roll-forward",
    );
    expect(h.events).not.toContain("migrate");
    expect(h.events).not.toContain("activate");
  });
  it("rejects an activation receipt for another artifact", async () => {
    const h = harness({
      activate: () =>
        Effect.succeed({
          sourceRevision: artifact.sourceRevision,
          artifactDigest: "e".repeat(64),
          version: "other",
        }),
    });
    expect(code(await h.run())).toBe("activated-artifact-mismatch");
    expect(h.events.at(-1)).toBe("uncertain");
  });
  it("rejects scaffold readiness through injected HTTP without ambient fetch", async () => {
    const seen: string[] = [];
    const program = inspectReadiness(
      artifact,
      { ...artifact, version: "fixture" },
      "/accepted-contract.json",
    ).pipe(
      Effect.provideService(ReadinessHttp, {
        request: (req) =>
          Effect.sync(() => {
            seen.push(new URL(req.url).pathname);
            return new Response("<main>Local D1 binding available</main>");
          }),
      }),
    );
    expect(code(await outcome(program))).toBe("incomplete-observation-or-docs");
    expect(seen).toEqual(["/", "/docs/"]);
  });
});
