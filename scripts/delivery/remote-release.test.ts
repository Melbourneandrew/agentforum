// Injected native/provider transports only. Normal exit is required; rejected or
// lost executor outcomes never produce terminal receipts. No provider calls.
import { Effect, Either, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { Identity, failure } from "./model.js";
import { Artifact } from "./release-model.js";
import { schemaDigest } from "./release-config.js";
import { remotePorts } from "./remote-release.js";
import { BUSINESS_MASTER } from "./remote-state.js";
import type { EffectToken } from "./release-control.js";
const identity = Schema.decodeUnknownSync(Identity)({
  version: 1,
  accountId: "a".repeat(32),
  workerName: "remote-forum",
  databaseName: "remote-db",
  databaseId: "11111111-1111-1111-1111-111111111111",
  defaultOrigin: "https://remote-forum.owner.workers.dev",
});
const artifact = Schema.decodeUnknownSync(Artifact)({
  identity,
  sourceRevision: "a".repeat(40),
  configPath: "/parent/config.json",
  artifactDigest: "b".repeat(64),
  schemaDigest: schemaDigest([]),
  migrations: [],
  compatibleSchemas: [],
});
const owner = "11111111-1111-1111-1111-111111111111";
const version = "22222222-2222-2222-2222-222222222222";
const fixture = (
  kind: "business-migrate" | "activate",
  options: {
    lost?: boolean;
    mismatch?: boolean;
    noIntent?: boolean;
    readiness?: boolean;
    badVersion?: boolean;
  } = {},
) => {
  const token: EffectToken = {
    ownerId: owner,
    generation: 1,
    sequence: 1,
    kind,
  };
  const mutableCalls: string[][] = [];
  let reads = 0;
  const row = {
    slot: 1,
    protocol: 1,
    account_id: identity.accountId,
    database_id: identity.databaseId,
    worker_name: identity.workerName,
    default_origin: identity.defaultOrigin,
    generation: 1,
    phase: "held",
    owner_id: owner,
    executor_ref: "parent:unit",
    source_revision: artifact.sourceRevision,
    artifact_sha256: artifact.artifactDigest,
    effect_seq: 1,
    effect_kind: kind,
    effect_state: options.noIntent ? "acked" : "intent",
    effect_ref: null,
    effect_receipt_json: null,
    last_release_receipt_json: null,
    reconciliation_sha256: null,
  };
  const ports = remotePorts({
    artifact,
    executorRef: "parent:unit",
    states: [
      {
        inventory: artifact.schemaDigest,
        history: [],
        master: [],
        physicalDigest: artifact.schemaDigest,
      },
    ],
    provider: {
      database: {
        identity,
        query: (sql) =>
          Effect.succeed(
            sql.includes("SELECT * FROM agentforum_release_control")
              ? [row]
              : sql === BUSINESS_MASTER
                ? []
                : sql === "PRAGMA quick_check"
                  ? [{ quick_check: "ok" }]
                  : [],
          ),
      },
      current: (id, message) => {
        reads++;
        expect(id).toBe(version);
        expect(message).toBe(
          `agentforum:${artifact.sourceRevision}:${artifact.artifactDigest}`,
        );
        return options.mismatch
          ? Effect.fail(failure("deployment", "current-version-mismatch"))
          : Effect.succeed(owner);
      },
    },
    verify: Effect.void,
    native: (args) => {
      mutableCalls.push([...args]);
      return options.lost
        ? Effect.fail(failure("deployment", "executor-outcome-unknown"))
        : Effect.succeed({
            stdout: options.badVersion
              ? "uploaded candidate"
              : `Current Version ID: ${version}\n`,
            operationRef: "native:unit",
          });
    },
    readiness: {
      request: () =>
        Effect.succeed(
          new Response(
            options.readiness ? "<main>Local D1 binding available</main>" : "",
            { status: 200 },
          ),
        ),
    },
  });
  return { ports, token, calls: mutableCalls, reads: () => reads };
};
describe("real remote lifecycle commands (injected execution)", () => {
  it("first Worker activation uses deploy, correlates current provider version before receipt", async () => {
    const { ports, token, calls, reads } = fixture("activate");
    const result = await Effect.runPromise(ports.activate(artifact, token));
    expect(calls[0]?.[0]).toBe("deploy");
    expect(calls[0]).not.toContain("upload");
    expect(calls[0]).toContain("/dev/null");
    expect(result.activation.version).toBe(version);
    expect(result.receipt.kind).toBe("activate");
    expect(reads()).toBe(1);
  });
  it("remote business migration is native, exact DB/config, physically verified before receipt", async () => {
    const { ports, token, calls } = fixture("business-migrate");
    const receipt = await Effect.runPromise(ports.migrate(artifact, token));
    expect(calls[0]).toEqual([
      "d1",
      "migrations",
      "apply",
      "DB",
      "--remote",
      "--config",
      artifact.configPath,
      "--env-file",
      "/dev/null",
    ]);
    expect(receipt.operationRef).toBe("native:unit");
    expect(receipt.outcome).toBe("succeeded");
  });
  it.each(["activate", "business-migrate"] as const)(
    "no acknowledged durable intent means no native %s",
    async (kind) => {
      const { ports, token, calls } = fixture(kind, { noIntent: true });
      const result = await Effect.runPromise(
        Effect.either(
          kind === "activate"
            ? ports.activate(artifact, token).pipe(Effect.asVoid)
            : ports.migrate(artifact, token).pipe(Effect.asVoid),
        ),
      );
      expect(Either.isLeft(result) && result.left.code).toBe(
        "remote-intent-not-held",
      );
      expect(calls).toEqual([]);
    },
  );
  it.each(["activate", "business-migrate"] as const)(
    "lost native %s outcome is unknown, not a receipt/retry",
    async (kind) => {
      const { ports, token, calls, reads } = fixture(kind, { lost: true });
      const result = await Effect.runPromise(
        Effect.either(
          kind === "activate"
            ? ports.activate(artifact, token).pipe(Effect.asVoid)
            : ports.migrate(artifact, token).pipe(Effect.asVoid),
        ),
      );
      expect(Either.isLeft(result) && result.left.code).toBe(
        "executor-outcome-unknown",
      );
      expect(calls).toHaveLength(1);
      expect(reads()).toBe(0);
    },
  );
  it.each([{ mismatch: true }, { badVersion: true }])(
    "does not acknowledge mere upload or current mismatch %j",
    async (options) => {
      const { ports, token } = fixture("activate", options);
      expect(
        Either.isLeft(
          await Effect.runPromise(
            Effect.either(ports.activate(artifact, token)),
          ),
        ),
      ).toBe(true);
    },
  );
  it("canonical relabeling after artifact preparation cannot bypass exact native intent/receipt", async () => {
    const { ports, token, calls, reads } = fixture("activate");
    const result = await Effect.runPromise(
      Effect.either(
        ports.activate(
          { ...artifact, canonicalOrigin: "https://forum.example.com" },
          token,
        ),
      ),
    );
    expect(Either.isLeft(result) && result.left.code).toBe(
      "remote-artifact-mismatch",
    );
    expect(calls).toEqual([]);
    expect(reads()).toBe(0);
  });
  it("scaffold readiness cannot declare installation complete", async () => {
    const { ports } = fixture("activate", { readiness: true });
    const result = await Effect.runPromise(
      Effect.either(
        ports.readiness(artifact, {
          sourceRevision: artifact.sourceRevision,
          artifactDigest: artifact.artifactDigest,
          version,
        }),
      ),
    );
    expect(Either.isLeft(result) && result.left.code).toBe(
      "incomplete-observation-or-docs",
    );
  });
});
