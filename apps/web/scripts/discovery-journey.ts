import Ajv2020 from "ajv/dist/2020.js";
import assert from "node:assert/strict";
import { Option, Redacted, Schema } from "effect";
import { PostRecord, SearchResult } from "@agentforum/contracts";

const record = Schema.Record({ key: Schema.String, value: Schema.Unknown });
const Recipe = Schema.Struct({
  api: Schema.String,
  openapi: Schema.String,
  post_schema: Schema.String,
  transports: Schema.Array(Schema.Literal("POST", "GET")),
  steps: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      operation: Schema.String,
      input: record,
      authorizationFrom: Schema.optional(Schema.String),
    }),
  ),
});
const Operation = Schema.Struct({
  security: Schema.Array(
    Schema.Record({ key: Schema.String, value: Schema.Array(Schema.String) }),
  ),
  responses: record,
});
const Spec = Schema.Struct({
  openapi: Schema.Literal("3.1.0"),
  paths: Schema.Record({
    key: Schema.String,
    value: Schema.Record({ key: Schema.String, value: Operation }),
  }),
  "x-input-budgets": record,
});
const PostSchema = Schema.Struct({
  $id: Schema.String,
  "x-schema-version": Schema.Literal("v1"),
  "x-input-budgets": record,
});
const field = (
  reference: string,
  results: ReadonlyMap<string, Readonly<Record<string, unknown>>>,
) => {
  const match = /^\$([a-z]+)\.([a-z_]+)$/.exec(reference);
  assert.ok(match?.[1] && match[2], "Invalid documented result reference");
  const result = results.get(match[1]);
  assert.ok(
    result && Object.hasOwn(result, match[2]),
    "Documented reference did not resolve",
  );
  return result[match[2]];
};
// Generic client of the public HTTP guide/recipe and raw contracts. It imports
// no API business handlers, services, private examples, credentials or seed data.
// Canonical public origins are mapped ONLY to the already-owned local API.
export const runDiscoveryJourney = async (apiOrigin: string) => {
  const get = async (path: string) => {
    const response = await fetch(new URL(path, apiOrigin), {
      redirect: "manual",
    });
    assert.equal(response.status, 200, "Discovered public read failed");
    return response;
  };
  const guide = await (await get("/llms.txt")).text();
  assert.equal(await (await get("/skill.md")).text(), guide);
  const block = /```json\n([\s\S]*?)\n```/.exec(guide);
  assert.ok(block?.[1], "Guide has no executable discovery example");
  const recipe = Schema.decodeUnknownSync(Recipe)(JSON.parse(block[1]));
  assert.deepEqual(recipe.transports, ["POST", "GET"]);
  const canonical = new URL(recipe.api);
  assert.equal(canonical.origin, "https://api.agentforum.site");
  const local = (href: string) => {
    const url = new URL(href, recipe.api);
    assert.equal(
      url.origin,
      canonical.origin,
      "Guide tried to send credentials outside its API",
    );
    assert.equal(url.username + url.password + url.hash, "");
    return url.pathname + url.search;
  };
  for (const href of [recipe.openapi, recipe.post_schema]) {
    assert.ok(
      guide.includes("](" + href + ")"),
      "Missing direct authoritative contract link",
    );
  }
  const spec = Schema.decodeUnknownSync(Spec)(
    await (await get(local(recipe.openapi))).json(),
  );
  const postDocument: unknown = await (
    await get(local(recipe.post_schema))
  ).json();
  const post = Schema.decodeUnknownSync(PostSchema)(postDocument);
  const validator = new Ajv2020({ strict: true });
  // These are declared annotation keywords, not disabled schema checking.
  for (const keyword of ["x-schema-version", "x-openapi", "x-compatibility"])
    validator.addKeyword({ keyword, schemaType: "string", valid: true });
  for (const keyword of [
    "x-authoritative-requirements",
    "x-server-established",
    "x-metadata-conventions",
    "x-input-budgets",
  ])
    validator.addKeyword({ keyword, schemaType: "object", valid: true });
  validator.addFormat("uuid", {
    type: "string",
    validate: Schema.is(Schema.UUID),
  });
  validator.addSchema(Schema.decodeUnknownSync(record)(postDocument));
  const published = validator.getSchema(post.$id + "#/$defs/PublishedPost");
  assert.ok(published, "Exposed published Post schema did not compile");

  assert.equal(post.$id, recipe.post_schema);
  const budgets = Object.fromEntries(
    Object.entries(post["x-input-budgets"]).filter(
      ([, value]) => typeof value === "number",
    ),
  );
  assert.deepEqual(spec["x-input-budgets"], budgets);
  for (const [key, value] of Object.entries(budgets)) {
    const rows = guide
      .split("\n")
      .filter((line) => line.startsWith("| " + key + " |"));
    assert.deepEqual(
      rows,
      ["| " + key + " | " + String(value) + " |"],
      "Guide budget drifted from runtime-derived schema",
    );
  }
  for (const match of guide.matchAll(/\]\((https?:\/\/[^)]+)\)/g)) {
    const url = new URL(Schema.decodeUnknownSync(Schema.String)(match[1]));
    assert.ok(
      !/\/v1\/(register|publish)$/.test(url.pathname),
      "Guide contains a crawlable mutation URL",
    );
  }
  for (const method of recipe.transports) {
    const results = new Map<string, Readonly<Record<string, unknown>>>();
    for (const step of recipe.steps) {
      assert.ok(!results.has(step.name), "Duplicate example step");
      const path = local(step.operation);
      assert.equal(new URL(step.operation, recipe.api).search, "");
      const operation = spec.paths[path]?.[method.toLowerCase()];
      assert.ok(operation, "Example advertises an undeclared operation/method");
      const needsAuth = operation.security.some(
        (rule) => Object.keys(rule).length > 0,
      );
      assert.equal(
        step.authorizationFrom !== undefined,
        needsAuth,
        "Guide authentication disagrees with OpenAPI",
      );
      const input = Object.fromEntries(
        Object.entries(step.input).map(([key, value]) => {
          const resolved =
            typeof value === "string" && value.startsWith("$")
              ? field(value, results)
              : value;
          assert.ok(
            !Redacted.isRedacted(resolved),
            "Guide attempted to put a credential in payload/URL",
          );
          return [key, resolved];
        }),
      );
      const headers = new Headers({ Accept: "application/json" });
      if (step.authorizationFrom !== undefined) {
        const secret = field(step.authorizationFrom, results);
        assert.ok(
          Redacted.isRedacted(secret),
          "Authentication must refer to a one-time Redacted key",
        );
        headers.set(
          "Authorization",
          "Bearer " +
            Schema.decodeUnknownSync(Schema.String)(Redacted.value(secret)),
        );
      }
      const url = new URL(path, apiOrigin);
      const source = JSON.stringify(input);
      if (method === "GET") url.searchParams.set("payload", source);
      else headers.set("Content-Type", "application/json");
      const response = await fetch(url, {
        method,
        headers,
        redirect: "manual",
        ...(method === "POST" ? { body: source } : {}),
      });
      assert.ok(
        response.ok &&
          Object.hasOwn(operation.responses, String(response.status)),
        "Guide example failed its declared success contract",
      );
      const parsed = Schema.decodeUnknownSync(record)(await response.json());
      const stored = { ...parsed };
      // Determine secret fields from the PUBLIC recipe's later auth references.
      for (const next of recipe.steps)
        if (next.authorizationFrom?.startsWith("$" + step.name + ".")) {
          const key = next.authorizationFrom.slice(step.name.length + 2);
          stored[key] = Schema.decodeUnknownSync(
            Schema.Redacted(Schema.String),
          )(parsed[key]);
        }
      results.set(step.name, stored);
    }
    assert.equal(
      published(results.get("publish")),
      true,
      "Exposed JSON Schema rejected the actual published Post",
    );
    assert.equal(
      published(results.get("reply")),
      true,
      "Exposed JSON Schema rejected the actual reply",
    );
    assert.equal(
      published({ ...results.get("publish"), body: 42 }),
      false,
      "Published schema accepted an invalid body",
    );
    assert.equal(
      published({ ...results.get("publish"), id: "invalid" }),
      false,
      "Published schema accepted an invalid Post ID",
    );
    const parent = Schema.decodeUnknownSync(PostRecord)(results.get("publish"));
    const reply = Schema.decodeUnknownSync(PostRecord)(results.get("reply"));
    const retrieved = Schema.decodeUnknownSync(SearchResult)(
      results.get("retrieve"),
    );
    const resumed = Schema.decodeUnknownSync(SearchResult)(
      results.get("resume"),
    );
    const documented = recipe.steps.find((step) => step.name === "publish");
    assert.ok(documented, "Guide omitted its publication example");
    assert.equal(parent.body, documented.input.body);
    assert.deepEqual(parent.metadata, documented.input.metadata);
    assert.equal(parent.author_id, results.get("register")?.id);
    assert.equal(reply.author_id, parent.author_id);
    assert.deepEqual(
      retrieved.posts,
      [parent],
      "Discovered exact retrieval lost the published Post",
    );
    assert.ok(
      resumed.posts.some((post) => post.id === reply.id),
      "Documented checkpoint failed to resume the new reply",
    );
    assert.equal(Option.getOrThrow(reply.reply_to_id), parent.id);
    assert.deepEqual(reply.metadata, {});
  }
};
