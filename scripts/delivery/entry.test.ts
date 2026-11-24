import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Effect, Either, Schema } from "effect";
import { readFileSync } from "node:fs";
import { Identity, failure } from "./model.js";
import { Artifact } from "./release-model.js";
import { describe, expect, it } from "vitest";
import {
  deniedEntry,
  entryCommand,
  EntryAdapters,
  EntryAuthorization,
} from "./release-entry-command.js";
const denied = (args: readonly string[]) =>
  Effect.runPromise(
    Effect.either(
      entryCommand(args).pipe(
        Effect.provideService(EntryAuthorization, deniedEntry),
        Effect.provideService(EntryAdapters, {
          prepare: () =>
            Effect.die("must not construct provider/DB/subprocess"),
        }),
      ),
    ),
  );
describe("actual root release admission (no provider authority inferred)", () => {
  for (const mode of ["native", "cli"])
    it(`denies ${mode} before adapter access`, async () => {
      const result = await denied([
        mode,
        mode === "native" ? "--resolved-config" : "--identity",
        "/unreadable/never-read",
      ]);
      expect(Either.isLeft(result) && result.left.stage).toBe("authorization");
    });
  for (const args of [
    ["--confirm-quiescent"],
    ["native", "--identity", "foreign"],
    ["cli", "--resolved-config", "foreign"],
    ["native", "--operation", "reset"],
    ["--remote"],
  ])
    it(`rejects unsupported or recovery-bypass arguments ${JSON.stringify(args)}`, async () => {
      const result = await denied(args);
      expect(Either.isLeft(result) && result.left.code).toBe(
        "release-entry-arguments-invalid",
      );
    });
  it("real root native/CLI subprocesses ignore ambient credential/CI guesses and emit only sanitized denial", () => {
    for (const mode of ["native", "cli"]) {
      const output = spawnSync(
        process.execPath,
        [
          "--import",
          import.meta.resolve("tsx"),
          fileURLToPath(new URL("./release-entry.ts", import.meta.url)),
          mode,
          mode === "native" ? "--resolved-config" : "--identity",
          "/no-such-file",
        ],
        {
          cwd: process.cwd(),
          env: {
            PATH: process.env.PATH,
            CI: "true",
            WORKERS_CI: "1",
            CLOUDFLARE_API_TOKEN: "sensitive-sentinel-never-read",
            CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
          },
          encoding: "utf8",
          timeout: 10000,
        },
      );
      expect(output.status).toBe(1);
      expect(output.stdout).toBe("");
      expect(output.stderr).not.toContain("sensitive-sentinel");
      expect(JSON.parse(output.stderr)).toMatchObject({
        status: "installation-not-completed",
        stage: "authorization",
        provider: "not-run",
      });
    }
  });
});

// Boundary/order regressions ONLY: explicit synthetic admission and a bootstrap
// adapter that always fails. No SQL is executed and no terminality is simulated.
describe("admitted native/CLI preflight before control storage", () => {
  const identity = Schema.decodeUnknownSync(Identity)({
    version: 1,
    accountId: "a".repeat(32),
    workerName: "preflight-forum",
    databaseName: "preflight-db",
    databaseId: "11111111-1111-1111-1111-111111111111",
    defaultOrigin: "https://preflight-forum.fixture.workers.dev",
  });
  const artifact = Schema.decodeUnknownSync(Artifact)({
    identity,
    sourceRevision: "b".repeat(40),
    configPath: "/never-opened/prebuilt.json",
    artifactDigest: "c".repeat(64),
    schemaDigest: "d".repeat(64),
    migrations: [],
    compatibleSchemas: [],
  });
  const probe = (
    mode: string,
    options: { invalidOwner?: boolean; failVerify?: boolean } = {},
  ) => {
    const calls: string[] = [];
    const program = entryCommand([
      mode,
      mode === "native" ? "--resolved-config" : "--identity",
      "/never-opened/input",
    ]).pipe(
      Effect.provideService(EntryAuthorization, {
        admit: () =>
          Effect.succeed({ identity, executorRef: "local:preflight:fixture" }),
      }),
      Effect.provideService(EntryAdapters, {
        prepare: () =>
          Effect.succeed({
            artifact,
            ownerId: options.invalidOwner
              ? "invalid-owner"
              : "22222222-2222-2222-2222-222222222222",
            database: {
              identity,
              query: () =>
                Effect.sync(() => {
                  calls.push("control-read");
                  return [];
                }),
            },
            bootstrap: {
              v1: readFileSync(
                "scripts/delivery/control-migrations/0001_release_control.sql",
                "utf8",
              ),
              applyV1: Effect.gen(function* () {
                calls.push("bootstrap");
                return yield* Effect.fail(
                  failure("initialization", "fixture-bootstrap-stop"),
                );
              }),
            },
            ports: {
              build: () => Effect.die("unexpected build"),
              verify: () =>
                Effect.gen(function* () {
                  calls.push("verify");
                  if (options.failVerify)
                    return yield* Effect.fail(
                      failure("build", "candidate-artifact-changed"),
                    );
                }),
              installed: () => Effect.die("unexpected installed-state read"),
              migrate: () => Effect.die("unexpected business effect"),
              activate: () => Effect.die("unexpected activation effect"),
              readiness: () => Effect.die("unexpected readiness"),
            },
          }),
      }),
    );
    return { program, calls };
  };
  for (const mode of ["native", "cli"]) {
    it(`${mode} rejects a changed complete artifact before any control read/write`, async () => {
      const h = probe(mode, { failVerify: true });
      const result = await Effect.runPromise(Effect.either(h.program));
      expect(Either.isLeft(result) && result.left.code).toBe(
        "candidate-artifact-changed",
      );
      expect(h.calls).toEqual(["verify"]);
    });
    it(`${mode} rejects an invalid coordinator nonce before any control read/write`, async () => {
      const h = probe(mode, { invalidOwner: true });
      const result = await Effect.runPromise(Effect.either(h.program));
      expect(Either.isLeft(result) && result.left.code).toBe(
        "control-owner-invalid",
      );
      expect(h.calls).toEqual([]);
    });
    it(`${mode} verifies before frozen bootstrap and stops on its failure without protected effects`, async () => {
      const h = probe(mode);
      const result = await Effect.runPromise(Effect.either(h.program));
      expect(Either.isLeft(result) && result.left.code).toBe(
        "control-bootstrap-unknown-stop",
      );
      expect(h.calls).toEqual(["verify", "control-read", "bootstrap"]);
    });
  }
});
