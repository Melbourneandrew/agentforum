import { env } from "node:process";
import { Effect, Layer, Redacted, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  DirectDatabase,
  directDatabaseLayer,
  databaseBindingsLayer,
} from "../../src/database/database.js";
import { DatabaseConnectionTimeoutProblem } from "../../src/database/problems.js";
const Config = Schema.Struct({
  DATABASE_TEST_ORIGIN: Schema.String,
  DATABASE_TEST_CACHED_URL: Schema.Redacted(Schema.NonEmptyString),
  DATABASE_TEST_SATURATED_URL: Schema.Redacted(Schema.NonEmptyString),
  DATABASE_TEST_STATISTICS_URL: Schema.String,
  DATABASE_SMOKE_TOKEN: Schema.Redacted(Schema.NonEmptyString),
});
const parsed = Schema.decodeUnknownEither(Config)(env);
if (parsed._tag === "Left")
  throw new Error("Backpressure tests require the owned database harness");
const config = parsed.right;
const fetchProbe = (path: string) =>
  fetch(`${config.DATABASE_TEST_ORIGIN}${path}`, {
    headers: {
      Authorization: `Bearer ${Redacted.value(config.DATABASE_SMOKE_TOKEN)}`,
    },
  });
const Statistics = Schema.Struct({
  connections: Schema.Int,
  startupBytes: Schema.Int,
  faulted: Schema.Boolean,
});
const statistics = async () => {
  const response = await fetch(config.DATABASE_TEST_STATISTICS_URL);
  expect(response.status).toBe(200);
  return Schema.decodeUnknownSync(Statistics)(await response.json());
};
const waitForConnections = async (count: number) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const stats = await statistics();
    expect(stats.faulted).toBe(false);
    if (stats.connections === count && (count === 0 || stats.startupBytes > 0))
      return stats;
    await new Promise<void>((done) => {
      setTimeout(done, 10);
    });
  }
  throw new Error(
    "Owned handshake fixture did not reach the expected socket count",
  );
};
const assertTimeout = async (response: Response) => {
  expect(response.status).toBe(503);
  expect(response.headers.get("Retry-After")).toBe("1");
  expect(response.headers.get("Content-Type")).toBe("application/problem+json");
  const body = Schema.decodeUnknownSync(DatabaseConnectionTimeoutProblem)(
    await response.json(),
  );
  expect(body.instance).toMatch(/^urn:uuid:[a-f0-9-]{36}$/);
  expect(body.detail).not.toContain("postgresql:");
};
describe("actual acquisition backpressure", () => {
  it("maps a real PostgreSQL role connection limit to typed 503 and recovers after release", async () => {
    const layer = directDatabaseLayer.pipe(
      Layer.provide(
        databaseBindingsLayer({
          HYPERDRIVE_DIRECT: {
            connectionString: Redacted.value(
              config.DATABASE_TEST_SATURATED_URL,
            ),
          },
          HYPERDRIVE_CACHED: {
            connectionString: Redacted.value(config.DATABASE_TEST_CACHED_URL),
          },
        }),
      ),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* DirectDatabase; // Hold the origin role's sole real connection.
        yield* Effect.promise(async () => {
          await assertTimeout(await fetchProbe("/saturated"));
        });
      }).pipe(Effect.provide(layer)),
    );
    let recovered = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const response = await fetchProbe("/saturated");
      await response.arrayBuffer();
      if (response.status === 200) {
        recovered = true;
        break;
      }
      expect(response.status).toBe(503);
      await new Promise<void>((done) => {
        setTimeout(done, 10);
      });
    }
    expect(recovered).toBe(true);
  });
  it("bounds an actual stalled handshake at five seconds and closes the frontend socket before Worker shutdown", async () => {
    expect((await statistics()).connections).toBe(0);
    const started = Date.now();
    const [response] = await Promise.all([
      fetchProbe("/timeout"),
      waitForConnections(1),
    ]);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(4_800);
    expect(elapsed).toBeLessThan(8_000);
    await assertTimeout(response);
    expect((await waitForConnections(0)).connections).toBe(0);
    const healthy = await fetchProbe("/direct");
    expect(healthy.status).toBe(200);
    await healthy.arrayBuffer();
  });
});
