// Actual local admission/source/journal boundary; NEVER supplies credentials or
// calls a provider. Native mutation protocol is separately injected below.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Either, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { Identity, failure } from "./model.js";
import {
  ParentExecution,
  ownerReleaseCommand,
  type OwnerScope,
} from "./owner-executor.js";
const identity = Schema.decodeUnknownSync(Identity)({
  version: 1,
  accountId: "a".repeat(32),
  workerName: "remote-forum",
  databaseName: "remote-db",
  databaseId: "11111111-1111-1111-1111-111111111111",
  defaultOrigin: "https://remote-forum.owner.workers.dev",
});
const repository = process.cwd();
const revision = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const run = async (
  authorize: typeof ParentExecution.Service.authorize,
  mode = "cli",
) => {
  let credentials = 0;
  const result = await Effect.runPromise(
    Effect.either(
      ownerReleaseCommand([
        mode,
        "--identity",
        "/not-opened/retained.json",
      ]).pipe(
        Effect.provideService(ParentExecution, {
          authorize,
          credential: Effect.sync(() => {
            credentials++;
            return "NEVER-USED-TEST-CREDENTIAL";
          }),
        }),
      ),
    ),
  );
  return { result, credentials };
};
const scope: OwnerScope = {
  repository,
  journalPath: "/not-opened/retained.json",
  identity,
  sourceRevision: revision,
  executorRef: "trusted-parent:unit",
  operation: "update",
  grants: ["d1:read", "d1:write", "worker:read", "worker:deploy"],
};
describe("secure supported parent CLI boundary", () => {
  it("no parent authority means no credential access", async () => {
    const { result, credentials } = await run(() =>
      Effect.fail(failure("authorization", "denied")),
    );
    expect(Either.isLeft(result) && result.left.code).toBe(
      "owner-execution-authorization-unconfigured",
    );
    expect(credentials).toBe(0);
  });
  it.each([
    { ...scope, operation: "recover" as const },
    { ...scope, journalPath: "/different/journal" },
    { ...scope, grants: [] },
  ])(
    "rejects wrong operation/journal/grants before credentials %j",
    async (context) => {
      const { result, credentials } = await run(() => Effect.succeed(context));
      expect(Either.isLeft(result) && result.left.code).toBe(
        "parent-execution-scope-mismatch",
      );
      expect(credentials).toBe(0);
    },
  );
  it.each(["d1:read", "d1:write", "worker:read", "worker:deploy"] as const)(
    "each grant is independently required: missing %s",
    async (missing) => {
      const { result, credentials } = await run(() =>
        Effect.succeed({
          ...scope,
          grants: scope.grants.filter((grant) => grant !== missing),
        }),
      );
      expect(Either.isLeft(result) && result.left.code).toBe(
        "parent-execution-scope-mismatch",
      );
      expect(credentials).toBe(0);
    },
  );
  it("native cannot borrow parent CLI authority", async () => {
    let authorizations = 0;
    const result = await Effect.runPromise(
      Effect.either(
        ownerReleaseCommand([
          "native",
          "--resolved-config",
          "/not-opened/config",
        ]).pipe(
          Effect.provideService(ParentExecution, {
            authorize: () => {
              authorizations++;
              return Effect.succeed(scope);
            },
            credential: Effect.die("must never read"),
          }),
        ),
      ),
    );
    expect(Either.isLeft(result) && result.left.code).toBe(
      "native-authorization-handoff-unproved",
    );
    expect(authorizations).toBe(0);
  });
  it("actual wrong source revision fails before journal/provider/credential", async () => {
    const { result, credentials } = await run(() =>
      Effect.succeed({ ...scope, sourceRevision: "f".repeat(40) }),
    );
    expect(Either.isLeft(result) && result.left.code).toBe(
      "parent-source-context-mismatch",
    );
    expect(credentials).toBe(0);
  });
  it("missing journal in clean disposable checkout fails before credential", async () => {
    const directory = mkdtempSync(join(tmpdir(), "wo34-source-unit-"));
    const root = join(directory, "source");
    try {
      execFileSync("git", [
        "clone",
        "--quiet",
        "--no-hardlinks",
        repository,
        root,
      ]);
      const path = join(directory, "identity.json");
      const result = await Effect.runPromise(
        Effect.either(
          ownerReleaseCommand(["cli", "--identity", path]).pipe(
            Effect.provideService(ParentExecution, {
              authorize: () =>
                Effect.succeed({
                  ...scope,
                  repository: root,
                  journalPath: path,
                }),
              credential: Effect.die("must never read"),
            }),
          ),
        ),
      );
      expect(Either.isLeft(result) && result.left.code).toBe(
        "retained-identity-required",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("journal identity differing from authorized parent identity fails before credential", async () => {
    const directory = mkdtempSync(join(tmpdir(), "wo34-source-unit-"));
    const root = join(directory, "source");
    try {
      execFileSync("git", [
        "clone",
        "--quiet",
        "--no-hardlinks",
        repository,
        root,
      ]);
      const path = join(directory, "identity.json");
      writeFileSync(
        path,
        JSON.stringify({
          state: "resolved",
          identity: {
            ...identity,
            databaseId: "22222222-2222-2222-2222-222222222222",
          },
        }),
        { mode: 0o600 },
      );
      const result = await Effect.runPromise(
        Effect.either(
          ownerReleaseCommand(["cli", "--identity", path]).pipe(
            Effect.provideService(ParentExecution, {
              authorize: () =>
                Effect.succeed({
                  ...scope,
                  repository: root,
                  journalPath: path,
                }),
              credential: Effect.die("must never read"),
            }),
          ),
        ),
      );
      expect(Either.isLeft(result) && result.left.code).toBe(
        "parent-retained-identity-mismatch",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
