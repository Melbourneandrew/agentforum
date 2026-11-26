import { fork } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect, Either, Fiber, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  BuildProcess,
  BuildTools,
  buildChild,
  buildToolsLive,
  decodeBuildInput,
  ownerBuild,
  safeBuildEnvironment,
} from "../../apps/forum/scripts/owner-build.js";
import { ParentExecution, ownerReleaseCommand } from "./owner-executor.js";
import { Identity, failure } from "./model.js";
const input = {
  version: 1,
  repository: process.cwd(),
  revision: "a".repeat(40),
  metadata: { environment: "staging", revision: "a".repeat(40) },
};
const invalidInputs: readonly unknown[] = [
  null,
  {},
  { ...input, version: 2 },
  { ...input, repository: "relative" },
  { ...input, revision: "A".repeat(40) },
  { ...input, revision: `${"a".repeat(40)}\n` },
  { ...input, revision: "a".repeat(39) },
  { ...input, revision: "a".repeat(41) },
  { ...input, metadata: {} },
  { ...input, metadata: { environment: "staging" } },
  { ...input, metadata: { revision: input.revision } },
  { ...input, metadata: { environment: "unknown", revision: input.revision } },
  { ...input, metadata: { ...input.metadata, revision: "b".repeat(40) } },
  {
    ...input,
    metadata: { ...input.metadata, credential: "synthetic-private" },
  },
  { ...input, authority: "assertion-is-not-a-grant" },
  { ...input, metadata: undefined },
];
describe("private build DTO is data, not authority", () => {
  it("rejects excess trusted Scope input before source/build/credential", async () => {
    let credentials = 0;
    const identity = Schema.decodeUnknownSync(Identity)({
      version: 1,
      accountId: "a".repeat(32),
      workerName: "scope-forum",
      databaseName: "scope-database",
      databaseId: "11111111-1111-1111-1111-111111111111",
      defaultOrigin: "https://scope-forum.owner.workers.dev",
    });
    const result = await Effect.runPromise(
      Effect.either(
        ownerReleaseCommand([
          "cli",
          "--identity",
          "/not-opened/identity.json",
        ]).pipe(
          Effect.provideService(ParentExecution, {
            authorize: () =>
              Effect.succeed({
                repository: process.cwd(),
                journalPath: "/not-opened/identity.json",
                identity,
                sourceRevision: input.revision,
                diagnosticEnvironment: "staging" as const,
                executorRef: "trusted-parent:scope-unit",
                operation: "update" as const,
                grants: [
                  "d1:read",
                  "d1:write",
                  "worker:read",
                  "worker:deploy",
                ] as const,
                metadataAuthority: "not-a-grant",
              }),
            credential: Effect.sync(() => {
              credentials++;
              return "NEVER-USED-SYNTHETIC";
            }),
          }),
        ),
      ),
    );
    expect(Either.isLeft(result) && result.left.code).toBe(
      "owner-execution-authorization-unconfigured",
    );
    expect(credentials).toBe(0);
  });

  it.each(invalidInputs.map((value, index) => ({ value, index })))(
    "rejects input $index before process/build/credential continuation",
    async ({ value }) => {
      let starts = 0,
        credentials = 0;
      const result = await Effect.runPromise(
        Effect.either(
          ownerBuild(value, {}).pipe(
            Effect.provideService(BuildProcess, {
              start: () => {
                starts++;
                return Effect.fail(failure("build", "must-not-start"));
              },
            }),
            Effect.tap(() =>
              Effect.sync(() => {
                credentials++;
              }),
            ),
          ),
        ),
      );
      expect(Either.isLeft(result)).toBe(true);
      expect(starts).toBe(0);
      expect(credentials).toBe(0);
    },
  );
  it("snapshots valid pair and preserves explicit None", async () => {
    const pair = await Effect.runPromise(decodeBuildInput(input));
    expect(Object.isFrozen(pair)).toBe(true);
    expect(Object.isFrozen(pair.metadata)).toBe(true);
    expect(
      (await Effect.runPromise(decodeBuildInput({ ...input, metadata: null })))
        .metadata,
    ).toBeNull();
  });
  it("reconstructs only the existing safe build environment", () => {
    expect(
      safeBuildEnvironment({
        PATH: "/p",
        HOME: "/h",
        XDG_CONFIG_HOME: "/x",
        WRANGLER_LOG_PATH: "/l",
        EXAMPLE_PRIVATE: "SYNTHETIC",
        NODE_OPTIONS: "bad",
        CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "true",
      }),
    ).toEqual({
      PATH: "/p",
      HOME: "/h",
      XDG_CONFIG_HOME: "/x",
      WRANGLER_LOG_PATH: "/l",
      CI: "true",
      CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
      WRANGLER_SEND_METRICS: "false",
      WRANGLER_RESOURCES_PROVISION: "false",
    });
  });
  it("source-build-source order precedes terminal readback", async () => {
    const order: string[] = [];
    const reply = await Effect.runPromise(
      buildChild(input).pipe(
        Effect.provideService(BuildTools, {
          source: () =>
            Effect.sync(() => {
              order.push("source");
            }),
          build: () =>
            Effect.sync(() => {
              order.push("configured-build");
            }),
        }),
      ),
    );
    expect(order).toEqual(["source", "configured-build", "source"]);
    expect(reply).toEqual({
      version: 1,
      kind: "built",
      revision: input.revision,
      metadata: input.metadata,
    });
  });
  it.each(["before", "build", "after"])(
    "failure at %s has no terminal",
    async (stage) => {
      let sources = 0,
        builds = 0;
      const result = await Effect.runPromise(
        Effect.either(
          buildChild(input).pipe(
            Effect.provideService(BuildTools, {
              source: () =>
                Effect.suspend(() => {
                  sources++;
                  return stage === "before" ||
                    (stage === "after" && sources === 2)
                    ? Effect.fail(failure("build", "source-unverified"))
                    : Effect.void;
                }),
              build: () =>
                Effect.suspend(() => {
                  builds++;
                  return stage === "build"
                    ? Effect.fail(failure("build", "build-unverified"))
                    : Effect.void;
                }),
            }),
          ),
        ),
      );
      expect(Either.isLeft(result)).toBe(true);
      expect(builds).toBe(stage === "before" ? 0 : 1);
    },
  );
  it("real wrong/stale source cannot reach Vite", async () => {
    const result = await Effect.runPromise(
      Effect.either(buildChild(input).pipe(Effect.provide(buildToolsLive))),
    );
    expect(Either.isLeft(result)).toBe(true);
  });
});
const goodReply =
  'const reply = { version: 1, kind: "built", revision: input.revision, metadata: input.metadata };';
const cases = [
  {
    name: "valid reply and clean exit",
    code: "process.send(reply, () => process.exit(0));",
    success: true,
  },
  { name: "missing terminal", code: "process.exit(0);", success: false },
  {
    name: "wrong revision",
    code: 'process.send({...reply, revision:"b".repeat(40)}, () => process.exit(0));',
    success: false,
  },
  {
    name: "spoofed pair",
    code: 'process.send({...reply, metadata:{...input.metadata, environment:"production"}}, () => process.exit(0));',
    success: false,
  },
  {
    name: "excess reply",
    code: 'process.send({...reply, private:"SYNTHETIC"}, () => process.exit(0));',
    success: false,
  },
  {
    name: "unknown reply",
    code: 'process.send({kind:"other"}, () => process.exit(0));',
    success: false,
  },
  {
    name: "nonzero exit after reply",
    code: "process.send(reply, () => process.exit(1));",
    success: false,
  },
  {
    name: "duplicate reply",
    code: "process.send(reply, () => process.send(reply, () => process.exit(0)));",
    success: false,
  },
  {
    name: "lost channel",
    code: "process.disconnect(); setInterval(() => {}, 1000);",
    success: false,
  },
  {
    name: "signal after reply",
    code: 'process.send(reply, () => process.kill(process.pid,"SIGTERM"));',
    success: false,
  },
];
const fixture = async (body: string) => {
  const directory = await mkdtemp(join(tmpdir(), "wo35-ipc-"));
  const path = join(directory, "child.mjs");
  await writeFile(
    path,
    `process.once("message", input => { ${goodReply} ${body} });`,
  );
  let pid = 0;
  const service: typeof BuildProcess.Service = {
    start: (_request, env) =>
      Effect.sync(() => {
        const child = fork(path, [], {
          env,
          execArgv: [],
          stdio: ["ignore", "ignore", "ignore", "ipc"],
          detached: true,
        });
        pid = child.pid ?? 0;
        return child;
      }),
  };
  return { directory, service, pid: () => pid };
};
describe("owned fork terminal/exit/lifecycle", () => {
  it.each(cases)("$name", async ({ code, success }) => {
    const child = await fixture(code);
    let credentials = 0;
    try {
      const result = await Effect.runPromise(
        Effect.either(
          ownerBuild(input, {}).pipe(
            Effect.provideService(BuildProcess, child.service),
            Effect.tap(() =>
              Effect.sync(() => {
                credentials++;
              }),
            ),
          ),
        ),
      );
      expect(Either.isRight(result)).toBe(success);
      expect(credentials).toBe(success ? 1 : 0);
      expect(() => process.kill(child.pid(), 0)).toThrow();
      if (Either.isLeft(result))
        expect(result.left.code).toBe("owner-build-unverified");
    } finally {
      await rm(child.directory, { recursive: true, force: true });
    }
  });
  it.each([false, true])(
    "interruption awaits cleanup even with terminal=%s",
    async (terminal) => {
      const child = await fixture(
        `${terminal ? "process.send(reply);" : ""} setInterval(() => {}, 1000);`,
      );
      try {
        const fiber = Effect.runFork(
          ownerBuild(input, {}).pipe(
            Effect.provideService(BuildProcess, child.service),
          ),
        );
        await Effect.runPromise(Effect.sleep("150 millis"));
        const exit = await Effect.runPromise(Fiber.interrupt(fiber));
        expect(exit._tag).toBe("Failure");
        expect(() => process.kill(child.pid(), 0)).toThrow();
      } finally {
        await rm(child.directory, { recursive: true, force: true });
      }
    },
  );
  it("valid terminal without clean exit is not success and timeout cleans up", async () => {
    const child = await fixture(
      "process.send(reply); setInterval(() => {}, 1000);",
    );
    try {
      const result = await Effect.runPromise(
        Effect.either(
          ownerBuild(input, {}).pipe(
            Effect.provideService(BuildProcess, child.service),
            Effect.timeoutFail({
              duration: "250 millis",
              onTimeout: () => failure("build", "test-timeout"),
            }),
          ),
        ),
      );
      expect(Either.isLeft(result)).toBe(true);
      expect(() => process.kill(child.pid(), 0)).toThrow();
    } finally {
      await rm(child.directory, { recursive: true, force: true });
    }
  });
  it("spawn failure is typed and cannot reach continuation", async () => {
    const result = await Effect.runPromise(
      Effect.either(
        ownerBuild(input, {}).pipe(
          Effect.provideService(BuildProcess, {
            start: () =>
              Effect.fail(failure("build", "owner-build-unverified")),
          }),
        ),
      ),
    );
    expect(Either.isLeft(result) && result.left.code).toBe(
      "owner-build-unverified",
    );
  });
});
