import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  discoveryPaths,
  discoveryResponse,
} from "../src/discovery/responses.js";

// Draft1.0's supported subset: no invented MCP/payment/auth blocks. All URLs
// required by the actual native format are absolute and local; versions are
// declared only where that convention defines a version field.
const Absolute = Schema.String.pipe(Schema.pattern(/^https?:\/\//));
const Agents = Schema.Struct({
  $schema: Schema.Literal(
    "https://agents-txt.com/schema/agents-json/v1.0.json",
  ),
  version: Schema.Literal("1.0"),
  standard: Schema.Literal("https://agents-txt.com"),
  site: Schema.Struct({
    name: Schema.NonEmptyString,
    url: Absolute,
    description: Schema.String,
  }),
  skills: Schema.Array(
    Schema.Struct({ url: Absolute, description: Schema.String }),
  ),
});
const Link = Schema.Struct({
  href: Absolute,
  type: Schema.optional(Schema.String),
});
const Catalog = Schema.Struct({
  linkset: Schema.Array(
    Schema.Struct({
      anchor: Absolute,
      item: Schema.optional(Schema.Array(Link)),
      "service-desc": Schema.optional(Schema.Array(Link)),
      "service-doc": Schema.optional(Schema.Array(Link)),
      describedby: Schema.optional(Schema.Array(Link)),
    }),
  ),
});
describe("pure installation discovery materialization", () => {
  for (const origin of [
    "https://alpha.owner.workers.dev",
    "https://custom.example",
    "http://127.0.0.1:8794",
  ])
    it(`keeps RFC9727 and native draft1.0 declarations local to ${origin}`, async () => {
      const agents = Schema.decodeUnknownSync(Agents)(
        await discoveryResponse("/agents.json", origin).json(),
        { onExcessProperty: "error" },
      );
      expect(agents.site.url).toBe(origin + "/");
      expect(agents.skills).toHaveLength(1);
      expect(agents.skills[0]?.url).toBe(
        origin + "/skills/agentforum/SKILL.md",
      );
      const response = discoveryResponse("/.well-known/api-catalog", origin);
      expect(response.headers.get("Content-Type")).toContain(
        "application/linkset+json",
      );
      expect(response.headers.get("Link")).toBe(
        `<${origin}/.well-known/api-catalog>; rel="api-catalog"`,
      );
      const catalog = Schema.decodeUnknownSync(Catalog)(await response.json(), {
        onExcessProperty: "error",
      });
      expect(catalog.linkset[0]?.item).toEqual([{ href: origin + "/v1" }]);
      expect(catalog.linkset[1]?.["service-desc"]).toEqual([
        { href: origin + "/docs/openapi.json", type: "application/json" },
      ]);
      const text = await discoveryResponse("/agents.txt", origin).text();
      expect(text).toContain("draft version 1.0");
      expect(text).toContain(`Skills: ${origin}/skills/agentforum/SKILL.md`);
      expect(text).toContain(`${origin}/docs/openapi.json`);
      for (const path of discoveryPaths)
        expect(
          discoveryResponse(path, origin).headers.get("Cache-Control"),
        ).toBe("no-store, private");
    });
  it("rejects unknown paths instead of serving a successful generic description", async () => {
    const response = discoveryResponse(
      "/missing.json",
      "https://alpha.owner.workers.dev",
    );
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
  });
});

// Exercise the actual dispatcher and WO-35 outer wrapper, not a mock route.
import { afterEach, vi } from "vitest";
import { makeDispatcher } from "../src/runtime/dispatch.js";
import type { Bindings, Execution } from "../src/runtime/context.js";
const execution: Execution = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
  props: {},
};
const inaccessible: Bindings = {
  get DB(): Bindings["DB"] {
    throw new Error("Discovery accessed D1");
  },
  get ASSETS(): Bindings["ASSETS"] {
    throw new Error("Discovery accessed asset binding");
  },
};
const app = makeDispatcher(() => {
  throw new Error("Discovery invoked renderer");
});
const secret = "synthetic-private-query-cookie-key-cursor";
afterEach(() => vi.restoreAllMocks());
describe("native discovery dispatcher with safe35 wrapper", () => {
  for (const origin of [
    "https://alpha.owner.workers.dev",
    "https://custom.example",
    "http://127.0.0.1:8795",
  ])
    for (const path of discoveryPaths)
      it(`serves ${path} on ${origin} without D1/render/cache or caller reflection`, async () => {
        const log = vi
          .spyOn(console, "info")
          .mockImplementation(() => undefined);
        // Do not spread accessor traps: keep them live even for custom origin.
        const trusted: Bindings =
          origin === "https://custom.example"
            ? {
                get DB(): Bindings["DB"] {
                  return inaccessible.DB;
                },
                get ASSETS(): Bindings["ASSETS"] {
                  return inaccessible.ASSETS;
                },
                CANONICAL_ORIGIN: origin,
              }
            : inaccessible;
        for (const method of ["GET", "HEAD", "OPTIONS"]) {
          const response = await app.fetch(
            new Request(`${origin}${path}?origin=${secret}&payload=${secret}`, {
              method,
              headers: {
                "X-Forwarded-Host": "evil.invalid",
                Forwarded: "host=evil.invalid",
                "X-Request-Id": secret,
                Authorization: `Bearer ${secret}`,
                Cookie: secret,
              },
            }),
            trusted,
            execution,
          );
          expect(response.status).toBe(
            method === "OPTIONS" || (method === "HEAD" && path === "/v1")
              ? 204
              : 200,
          );
          expect(response.headers.get("X-Content-Type-Options")).toBe(
            "nosniff",
          );
          expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
          expect(response.headers.get("Cache-Control")).toBe(
            "no-store, private",
          );
          expect(response.headers.has("Set-Cookie")).toBe(false);
          if (path === "/v1") {
            expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
              "*",
            );
            expect(
              response.headers.has("Access-Control-Allow-Credentials"),
            ).toBe(false);
          } else
            expect(response.headers.get("Content-Security-Policy")).toContain(
              "script-src 'none'",
            );
          const body = await response.text();
          expect(body).not.toContain(secret);
          expect(body).not.toContain("evil.invalid");
          if (method !== "GET") expect(body).toBe("");
          else expect(body).toBe(await discoveryResponse(path, origin).text());
          if (path === "/.well-known/api-catalog" && method !== "OPTIONS")
            expect(response.headers.get("Link")).toContain(
              `${origin}/.well-known/api-catalog`,
            );
        }
        expect(log).toHaveBeenCalledTimes(3);
        const diagnostics = JSON.stringify(log.mock.calls);
        expect(diagnostics).not.toContain(secret);
        expect(diagnostics).not.toContain(origin);
        expect(diagnostics).not.toContain(path);
        for (const call of log.mock.calls) {
          const line: unknown = call[0];
          if (typeof line !== "string") throw new Error("Non-JSON diagnostic");
          const record: unknown = JSON.parse(line);
          expect(record).toMatchObject({
            "http.route": "unmatched",
            "operation.name": "unmatched",
            "dependency.category": "none",
          });
        }
      });
  it("rejects untrusted origins/configuration and mismatched Host before metadata", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    for (const [url, headers] of [
      ["https://evil.invalid/agents.json", {}],
      ["https://alpha.owner.workers.dev/agents.json", { Host: "evil.invalid" }],
    ] as const) {
      const response = await app.fetch(
        new Request(url, { headers }),
        inaccessible,
        execution,
      );
      expect(response.status).toBe(400);
      expect(await response.text()).not.toContain("evil.invalid");
    }
    const invalid: Bindings = {
      get DB(): Bindings["DB"] {
        return inaccessible.DB;
      },
      get ASSETS(): Bindings["ASSETS"] {
        return inaccessible.ASSETS;
      },
      CANONICAL_ORIGIN: "http://invalid.example",
    };
    expect(
      (
        await app.fetch(
          new Request("https://alpha.owner.workers.dev/agents.json"),
          invalid,
          execution,
        )
      ).status,
    ).toBe(500);
  });
  it("does not create method aliases or broaden the four exact metadata paths", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    for (const path of discoveryPaths)
      for (const method of ["PUT", "DELETE", "PATCH"])
        expect(
          (
            await app.fetch(
              new Request("https://alpha.owner.workers.dev" + path, { method }),
              inaccessible,
              execution,
            )
          ).status,
        ).toBe(405);
    for (const path of discoveryPaths.filter((value) => value !== "/v1"))
      expect(
        (
          await app.fetch(
            new Request("https://alpha.owner.workers.dev" + path, {
              method: "POST",
              body: secret,
            }),
            inaccessible,
            execution,
          )
        ).status,
      ).toBe(405);
    for (const path of [
      "/agents.json/extra",
      "/.well-known/missing-catalog",
      "/skills/agentforum/missing.json",
    ])
      expect(
        (
          await app.fetch(
            new Request("https://alpha.owner.workers.dev" + path),
            inaccessible,
            execution,
          )
        ).status,
      ).toBe(404);
  });
  it("preserves all three business safe-method boundaries and the API absolute URL cap", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    for (const path of ["/v1/register", "/v1/publish", "/v1/search"])
      for (const method of ["HEAD", "OPTIONS"]) {
        const response = await app.fetch(
          new Request("https://alpha.owner.workers.dev" + path, { method }),
          inaccessible,
          execution,
        );
        expect(response.status).toBe(204);
        expect(await response.text()).toBe("");
      }
    const large = await app.fetch(
      new Request(
        "https://alpha.owner.workers.dev/v1?payload=" + "x".repeat(14336),
      ),
      inaccessible,
      execution,
    );
    expect(large.status).toBe(413);
  });
});
