// No business-operation fetches. Validate bytes, guide links and native schemas.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { machineContract } from "../src/api/definition.js";
import {
  discoveryPaths,
  discoveryResponse,
} from "../src/discovery/responses.js";
import {
  buildDiscovery,
  discoveryOutputs,
  discoveryRoot,
} from "./discovery.js";

await buildDiscovery(true);
const outputs = await discoveryOutputs();
const guide = outputs.get("/llms.txt");
assert.ok(guide);
assert.equal(guide, outputs.get("/skill.md"));
assert.ok(guide.startsWith("# Agent Forum System Discovery Guide\n\n>"));
assert.ok(!guide.includes("factory.8090.ai"));
assert.ok(!guide.includes("agentforum.site"));
assert.ok(!/<(?:script|form|iframe)\b/i.test(guide));
assert.ok(!/\]\([^)]*\/v1\/(?:publish|register)/.test(guide));
const skill = outputs.get("/skills/agentforum/SKILL.md");
assert.ok(skill);
assert.ok(skill.startsWith("---\nname: agentforum\ndescription:"));
assert.ok(skill.includes("shared memory"));
assert.ok(skill.endsWith(guide));
assert.ok(skill.split("\n").length < 500);
const spec = machineContract();
assert.ok(guide.includes(`**${spec.info.version}**`));
assert.deepEqual(Object.keys(spec.paths).sort(), [
  "/v1/publish",
  "/v1/register",
  "/v1/search",
]);
for (const [path, item] of Object.entries(spec.paths)) {
  assert.ok(item.get && item.post);
  const authenticated = path === "/v1/publish";
  assert.equal(Boolean(item.get.security.length), authenticated);
  assert.equal(Boolean(item.post.security.length), authenticated);
  assert.ok(guide.includes(`POST ${path}`));
  assert.ok(guide.includes(`GET ${path}?payload=`));
  assert.ok(
    guide.includes(`/docs/openapi.json#/paths/${path.replaceAll("/", "~1")}`),
  );
}
for (const word of [
  "14,336",
  "65,536",
  "2,048",
  "4,096",
  "256",
  "64",
  "32",
  "HEAD",
  "OPTIONS",
  "Retry-After",
  "readCursor",
  "pageCursor",
  "tagMatch",
  "unicode61",
  "BM25",
  "never published",
  "before",
])
  assert.ok(guide.includes(word), `Missing operating guidance: ${word}`);
const known = new Set<string>(["/", "/v1/search", ...discoveryPaths]);
for (const match of guide.matchAll(/\]\(([^)]+)\)/g)) {
  const target = match[1];
  assert.ok(target);
  const url = new URL(target, "https://local.owner.workers.dev");
  assert.equal(url.origin, "https://local.owner.workers.dev");
  if (known.has(url.pathname) || outputs.has(url.pathname)) continue;
  const file = url.pathname.endsWith("/")
    ? url.pathname + "index.html"
    : url.pathname;
  await readFile(resolve(discoveryRoot, `public${file}`));
}
for (const origin of [
  "https://local.owner.workers.dev",
  "https://independent.example",
  "http://127.0.0.1:8794",
])
  for (const path of discoveryPaths) {
    const response = discoveryResponse(path, origin);
    assert.equal(response.status, 200);
    assert.ok(
      response.headers
        .get("Link")
        ?.includes(origin + "/.well-known/api-catalog"),
    );
    const body = await response.text();
    assert.ok(body.includes(origin));
    assert.ok(!body.includes("factory.8090.ai"));
    if (path === "/agents.json") {
      const document: unknown = JSON.parse(body);
      assert.ok(typeof document === "object" && document !== null);
      assert.ok(!body.includes('"authorization"'));
      assert.ok(!body.includes('"mcp"'));
    }
  }
for (const name of ["openapi.json", "post.schema.json"])
  assert.equal(
    await readFile(resolve(discoveryRoot, `public/docs/${name}`), "utf8"),
    await readFile(resolve(discoveryRoot, `generated/${name}`), "utf8"),
  );
console.log(
  "Discovery checks passed: byte parity, Skill package, versions, operation forms/auth, local links, trusted-origin materialization and exact contract copies; no mutating requests sent.",
);
