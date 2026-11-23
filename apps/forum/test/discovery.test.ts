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
