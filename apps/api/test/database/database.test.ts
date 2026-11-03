import { env } from "node:process";
import { Redacted, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { ProbeResult } from "../fixtures/transaction-probe.js";
import { ConnectionInfo } from "../fixtures/database-schema.js";
const Environment = Schema.Struct({
  DATABASE_SMOKE_TOKEN: Schema.Redacted(Schema.NonEmptyString),
  DATABASE_TEST_ORIGIN: Schema.String,
});
const parsed = Schema.decodeUnknownEither(Environment)(env);
if (parsed._tag === "Left")
  throw new Error("Database fixture environment is missing");
const authorization = `Bearer ${Redacted.value(parsed.right.DATABASE_SMOKE_TOKEN)}`;
const fetchProbe = (path: string) =>
  fetch(`${parsed.right.DATABASE_TEST_ORIGIN}${path}`, {
    headers: { Authorization: authorization },
  });

describe("real PostgreSQL adapter in workerd", () => {
  it("selects the real direct and cache-tolerant bindings independently", async () => {
    for (const [path, database] of [
      ["/direct", "agentforum_direct"],
      ["/cached", "agentforum_cached"],
    ] as const) {
      const response = await fetchProbe(path);
      expect(response.status).toBe(200);
      const value = Schema.decodeUnknownSync(ConnectionInfo)(
        await response.json(),
      );
      expect(value.database).toBe(database);
    }
  });
  it("creates fresh clients across actual incoming fetch events", async () => {
    const first = await fetchProbe("/direct");
    expect(first.status).toBe(200);
    const a = Schema.decodeUnknownSync(ConnectionInfo)(await first.json());
    const second = await fetchProbe("/direct");
    expect(second.status).toBe(200);
    const b = Schema.decodeUnknownSync(ConnectionInfo)(await second.json());
    expect(a.pid).not.toBe(b.pid);
  });
  it("keeps verification access private and HEAD/OPTIONS acquisition-free", async () => {
    const denied = await fetch(`${parsed.right.DATABASE_TEST_ORIGIN}/direct`);
    expect(denied.status).toBe(401);
    for (const method of ["HEAD", "OPTIONS"]) {
      const response = await fetch(
        `${parsed.right.DATABASE_TEST_ORIGIN}/direct`,
        { method },
      );
      expect(response.status).toBe(method === "HEAD" ? 200 : 204);
      expect(await response.text()).toBe("");
    }
  });
});

describe("deployable transaction probes over actual HTTP", () => {
  for (const mode of ["commit", "rollback", "interrupt"] as const) {
    it(`proves ${mode} and closes its scopes before responding`, async () => {
      const response = await fetch(
        `${parsed.right.DATABASE_TEST_ORIGIN}/transaction`,
        {
          method: "POST",
          headers: {
            Authorization: authorization,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ mode, marker: crypto.randomUUID() }),
        },
      );
      expect(response.status).toBe(200);
      const value = Schema.decodeUnknownSync(ProbeResult)(
        await response.json(),
      );
      expect(value).toEqual({
        mode,
        persisted: mode === "commit",
        transactionCleared: true,
        sleepObserved: mode === "interrupt",
        interrupted: mode === "interrupt",
        scopeClosed: true,
      });
    });
  }
  it("refuses unauthenticated and malformed probe requests without diagnostics", async () => {
    const denied = await fetch(
      `${parsed.right.DATABASE_TEST_ORIGIN}/transaction`,
      { method: "POST", body: "{}" },
    );
    expect(denied.status).toBe(401);
    const malformed = await fetch(
      `${parsed.right.DATABASE_TEST_ORIGIN}/transaction`,
      {
        method: "POST",
        headers: { Authorization: authorization },
        body: "x".repeat(4096),
      },
    );
    expect(malformed.status).toBe(500);
    expect(await malformed.text()).not.toContain("DatabaseProbe");
  });
});
