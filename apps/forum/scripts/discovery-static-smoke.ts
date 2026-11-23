// Actual built local Worker only. This independent check never sends a business
// GET/POST, nor claims proposal-pending origin-aware routes are live.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { discoveryRoot } from "./discovery.js";

const origin = process.env.DISCOVERY_ORIGIN ?? "http://127.0.0.1:8795";
const url = new URL(origin);
assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
assert.equal(url.origin, origin);
const request = (path: string, method = "GET") =>
  fetch(origin + path, { method, redirect: "manual" });
const representations = [
  ["/llms.txt", "text/plain"],
  ["/skill.md", "text/markdown"],
  ["/skills/agentforum/SKILL.md", "text/markdown"],
  ["/docs/openapi.json", "application/json"],
  ["/docs/post.schema.json", "application/json"],
] as const;
for (const [path, type] of representations) {
  const response = await request(path);
  assert.equal(response.status, 200, path);
  assert.ok(response.headers.get("Content-Type")?.includes(type), path);
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(
    await response.text(),
    await readFile(resolve(discoveryRoot, `public${path}`), "utf8"),
  );
  const head = await request(path, "HEAD");
  assert.equal(head.status, 200, path);
  assert.equal(await head.text(), "");
  assert.equal(
    head.headers.get("Content-Type"),
    response.headers.get("Content-Type"),
  );
  const options = await request(path, "OPTIONS");
  // Static Assets rejects OPTIONS with405; this is not a business operation.
  // Do not force Worker-first routing merely to turn a safe rejection into204.
  assert.equal(options.status, 405, path);
}
assert.equal(
  await (await request("/llms.txt")).text(),
  await (await request("/skill.md")).text(),
);
for (const path of [
  "/missing-discovery.json",
  "/skills/agentforum/missing.json",
  "/.well-known/missing-catalog",
]) {
  const response = await request(path);
  assert.equal(response.status, 404, path);
  assert.ok(!response.headers.get("Content-Type")?.includes("text/html"), path);
}
for (const path of ["/v1/register", "/v1/publish", "/v1/search"])
  for (const method of ["HEAD", "OPTIONS"]) {
    const response = await request(path, method);
    assert.equal(response.status, 204, `${method} ${path}`);
    assert.equal(await response.text(), "");
  }
for (const path of ["/v1/register", "/v1/publish", "/v1/search"])
  for (const method of ["HEAD", "OPTIONS"]) {
    const response = await request(path, method);
    assert.equal(response.status, 204);
    assert.equal(await response.text(), "");
  }
console.log(
  "Actual built-Worker static discovery passed: unauthenticated GET bytes/content types/parity, HEAD/OPTIONS and missing assets; no business GET/POST requests sent. Dynamic discovery registration/schema-guidance exposure remains approval-pending.",
);
