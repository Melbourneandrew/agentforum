// Fixed injected HTTP only; not live provider/permission evidence.
import { Effect, Either, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { Identity } from "./model.js";
import { remoteProvider } from "./remote-provider.js";
export const identity = Schema.decodeUnknownSync(Identity)({
  version: 1,
  accountId: "a".repeat(32),
  workerName: "remote-forum",
  databaseName: "remote-db",
  databaseId: "11111111-1111-1111-1111-111111111111",
  defaultOrigin: "https://remote-forum.owner.workers.dev",
});
const version = "22222222-2222-2222-2222-222222222222";
const deployment = "33333333-3333-3333-3333-333333333333";
const message = "source-artifact-correlation";
const envelope = (result: unknown) => Response.json({ success: true, result });
const fixture = (
  options: {
    percentage?: number;
    binding?: string;
    message?: string;
    changed?: boolean;
  } = {},
) => {
  let reads = 0;
  const calls: string[] = [];
  const provider = remoteProvider(identity, (url) => {
    if (typeof url !== "string")
      return Promise.reject(new Error("fixed URL required"));
    calls.push(url);
    if (url.endsWith("/deployments"))
      return Promise.resolve(
        envelope({
          deployments: [
            {
              id: ++reads === 2 && options.changed ? version : deployment,
              versions: [
                { version_id: version, percentage: options.percentage ?? 100 },
              ],
            },
          ],
        }),
      );
    return Promise.resolve(
      envelope({
        id: version,
        annotations: { "workers/message": options.message ?? message },
        resources: {
          bindings: [
            {
              type: "d1",
              name: "DB",
              id: options.binding ?? identity.databaseId,
            },
          ],
        },
      }),
    );
  });
  return { provider, calls };
};
describe("actual remote provider protocol (injected)", () => {
  it("posts parameterized SQL to exactly the retained account/UUID, no substitution", async () => {
    const queries: unknown[] = [];
    const provider = remoteProvider(identity, (url, init) => {
      expect(url).toBe(
        `https://api.cloudflare.com/client/v4/accounts/${identity.accountId}/d1/database/${identity.databaseId}/query`,
      );
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("error");
      queries.push(
        JSON.parse(typeof init?.body === "string" ? init.body : "null"),
      );
      return Promise.resolve(
        envelope([{ success: true, results: [{ slot: 1 }] }]),
      );
    });
    expect(
      await Effect.runPromise(
        provider.database.query(
          "UPDATE control SET owner=? WHERE slot=? RETURNING slot",
          ["o'wner", 1],
        ),
      ),
    ).toEqual([{ slot: 1 }]);
    expect(queries).toEqual([
      {
        sql: "UPDATE control SET owner=? WHERE slot=? RETURNING slot",
        params: ["o'wner", 1],
      },
    ]);
  });
  it.each([
    [],
    [{ success: false, results: [] }],
    [
      { success: true, results: [] },
      { success: true, results: [] },
    ],
    { results: [] },
  ])("refuses malformed/batch result %j", async (result) => {
    const provider = remoteProvider(identity, () =>
      Promise.resolve(envelope(result)),
    );
    expect(
      Either.isLeft(
        await Effect.runPromise(
          Effect.either(provider.database.query("SELECT 1", [])),
        ),
      ),
    ).toBe(true);
  });
  it.each([401, 403])(
    "preserves provider authorization denial %s",
    async (status) => {
      const provider = remoteProvider(identity, () =>
        Promise.resolve(new Response(null, { status })),
      );
      const result = await Effect.runPromise(
        Effect.either(provider.database.query("SELECT 1", [])),
      );
      expect(Either.isLeft(result) && result.left.stage).toBe("authorization");
    },
  );
  it("lost response remains unknown; never retries SQL", async () => {
    let attempts = 0;
    const provider = remoteProvider(identity, () => {
      attempts++;
      return Promise.reject(new Error("raw token/query must not escape"));
    });
    const result = await Effect.runPromise(
      Effect.either(
        provider.database.query("UPDATE control SET phase=?", ["held"]),
      ),
    );
    expect(Either.isLeft(result) && result.left.code).toBe(
      "remote-response-unknown",
    );
    expect(attempts).toBe(1);
  });
  it("requires current 100% deployment, exact returned version/source/artifact annotation and sole DB binding", async () => {
    const { provider, calls } = fixture();
    expect(await Effect.runPromise(provider.current(version, message))).toBe(
      deployment,
    );
    expect(calls.map((url) => new URL(url).pathname.split("/").at(-1))).toEqual(
      ["deployments", version, "deployments"],
    );
  });
  it.each([
    { percentage: 50 },
    { binding: version },
    { message: "different" },
    { changed: true },
  ])("refuses mismatched live proof %j", async (options) => {
    expect(
      Either.isLeft(
        await Effect.runPromise(
          Effect.either(fixture(options).provider.current(version, message)),
        ),
      ),
    ).toBe(true);
  });
});
