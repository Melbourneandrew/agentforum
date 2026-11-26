// Admission negatives only. A genuine witness/real clean A is covered by the
// complete workerd/native-D1 test; fabricated unit evidence cannot qualify it.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Effect, Either, Schema } from "effect";
import { expect, it } from "vitest";
import {
  ParentExecution,
  deniedParentExecution,
  ownerReleaseCommand,
  type OwnerScope,
} from "./owner-executor.js";
import { Identity, failure } from "./model.js";
import { type RecoverySelection } from "./release-recovery.js";
const exec = promisify(execFile);
const identity = Schema.decodeUnknownSync(Identity)({
  version: 1,
  accountId: "a".repeat(32),
  workerName: "recovery-unit-forum",
  databaseName: "recovery-unit-db",
  databaseId: "11111111-1111-1111-1111-111111111111",
  defaultOrigin: "https://recovery-unit-forum.owner.workers.dev",
});
it.each(["update", "recover"] as const)(
  "denied %s parent cannot read recovery DATA or credentials",
  async (operation) => {
    let reads = 0,
      credentials = 0;
    const parent = {
      ...deniedParentExecution,
      recovery: Effect.suspend(() => {
        reads++;
        return Effect.fail(failure("build", "data-must-not-open"));
      }),
      credential: Effect.suspend(() => {
        credentials++;
        return Effect.fail(
          failure("authorization", "credential-must-not-open"),
        );
      }),
    };
    const result = await Effect.runPromise(
      Effect.either(
        ownerReleaseCommand([
          "cli",
          "--identity",
          "/not-opened/identity.json",
          "--operation",
          operation,
        ]).pipe(Effect.provideService(ParentExecution, parent)),
      ),
    );
    expect(Either.isLeft(result) && result.left.code).toBe(
      "owner-execution-authorization-unconfigured",
    );
    expect(reads).toBe(0);
    expect(credentials).toBe(0);
  },
);
it.each([
  "stale",
  "dirty",
  "symlink",
  "missing-helper",
  "journal-foreign-uuid",
])("%s denies before recovery DATA and credential access", async (problem) => {
  const state = await mkdtemp(join(tmpdir(), "wo34-owner-negative-"));
  const root = join(state, "application"),
    journal = join(state, "identity.json");
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: state,
    XDG_CONFIG_HOME: state,
  };
  try {
    await mkdir(root);
    await exec("git", ["init", "-q"], { cwd: root, env });
    await writeFile(join(root, "source.txt"), "source");
    await exec("git", ["add", "."], { cwd: root, env });
    await exec(
      "git",
      [
        "-c",
        "user.name=NativeFixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-qm",
        "fixture",
      ],
      { cwd: root, env },
    );
    const revision = (
      await exec("git", ["rev-parse", "HEAD"], { cwd: root, env })
    ).stdout.trim();
    await writeFile(
      journal,
      JSON.stringify({
        state: "resolved",
        identity:
          problem === "journal-foreign-uuid"
            ? {
                ...identity,
                databaseId: "22222222-2222-2222-2222-222222222222",
              }
            : identity,
      }),
      { mode: 0o600 },
    );
    if (problem === "dirty")
      await writeFile(join(root, "source.txt"), "changed");
    if (problem === "symlink") await symlink(root, join(state, "linked"));
    const context: OwnerScope = {
      repository: problem === "symlink" ? join(state, "linked") : root,
      journalPath: journal,
      identity,
      sourceRevision: problem === "stale" ? "a".repeat(40) : revision,
      executorRef: "trusted-parent:recovery-negative",
      operation: "recover",
      grants: ["d1:read", "d1:write", "worker:read", "worker:deploy"],
    };
    let reads = 0,
      credentials = 0;
    const recovery: Effect.Effect<
      RecoverySelection,
      ReturnType<typeof failure>
    > = Effect.suspend(() => {
      reads++;
      return Effect.fail(failure("build", "must-not-open"));
    });
    const result = await Effect.runPromise(
      Effect.either(
        ownerReleaseCommand([
          "cli",
          "--identity",
          journal,
          "--operation",
          "recover",
        ]).pipe(
          Effect.provideService(ParentExecution, {
            authorize: () => Effect.succeed(context),
            recovery,
            credential: Effect.suspend(() => {
              credentials++;
              return Effect.fail(failure("authorization", "must-not-open"));
            }),
          }),
        ),
      ),
    );
    expect(Either.isLeft(result)).toBe(true);
    expect(reads).toBe(0);
    expect(credentials).toBe(0);
  } finally {
    await rm(state, { recursive: true, force: true });
  }
});
