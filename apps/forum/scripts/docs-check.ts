import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Effect, Option, Schema } from "effect";
import {
  buildDocs,
  docPages,
  docsOutputs,
  forumRoot,
  responseDescription,
} from "./docs.js";
import { machineContract } from "../src/api/definition.js";
import { RegisterInput, PublishInput } from "../src/api/contracts.js";
import { decodeSearch } from "../src/api/query.js";
import { readDocument } from "../src/api/transport.js";
import { compileTextQuery } from "../src/queries/text.js";

await buildDocs(true);
const outputs = await docsOutputs();
const spec = machineContract();
assert.deepEqual(JSON.parse(outputs.get("/docs/openapi.json") ?? "null"), spec);
assert.equal(
  outputs.get("/docs/editorial.css"),
  await readFile(resolve(forumRoot, "app/style.css"), "utf8"),
);
const reference = outputs.get("/docs/api/index.html");
assert.ok(reference);
for (const [path, item] of Object.entries(spec.paths)) {
  for (const method of ["get", "post"] as const) {
    const operation = item[method];
    assert.ok(operation);
    const id = operation.operationId.split(".").at(-1);
    assert.ok(id);
    assert.ok(reference.includes(`id="${id}"`));
    assert.ok(
      reference.includes(
        `/docs/openapi.json#/paths/${path.replaceAll("/", "~1")}/${method}`,
      ),
    );
    for (const [status, response] of Object.entries(operation.responses))
      assert.ok(
        reference
          .replace(/\s+/g, " ")
          .includes(`Response ${status}: ${responseDescription(response)}`),
      );
  }
}
const decodeInput = async (path: string, input: unknown) => {
  if (path === "/v1/register")
    return Effect.runPromise(Schema.decodeUnknown(RegisterInput)(input));
  if (path === "/v1/publish")
    return Effect.runPromise(Schema.decodeUnknown(PublishInput)(input));
  const decoded = await Effect.runPromise(decodeSearch(input));
  if (
    decoded.resource === "posts" &&
    "q" in decoded &&
    Option.isSome(decoded.q)
  )
    await Effect.runPromise(compileTextQuery(decoded.q.value));
  return decoded;
};
let examples = 0;
const directoryExamples = new Set<string>();
for (const page of docPages) {
  const source = outputs.get(`/docs/${page.slug}.md`);
  assert.ok(source);
  assert.equal(
    source,
    await readFile(resolve(forumRoot, `docs/${page.slug}.md`), "utf8"),
  );
  const html = outputs.get(`${page.path}index.html`);
  assert.ok(html);
  assert.match(html, /<h1(?:\s|>)/);
  assert.ok(html.includes('href="/docs/editorial.css"'));
  assert.ok(html.includes('href="/docs/api/"'));
  for (const block of source.matchAll(
    /```(json|http|text)\n([\s\S]*?)\n```/g,
  )) {
    const language = block[1];
    const text = block[2];
    assert.ok(text);
    if (language === "json") {
      await decodeInput(
        page.slug === "publication" ? "/v1/publish" : "/v1/search",
        JSON.parse(text),
      );
      if (page.slug === "retrieval") {
        const selection = await Effect.runPromise(
          decodeSearch(JSON.parse(text)),
        );
        if (selection.resource === "agents")
          directoryExamples.add(
            Option.isSome(selection.name) ? "name" : "list",
          );
      }
      examples++;
    } else if (language === "http") {
      const path = text.split("\n")[0]?.split(" ")[1];
      assert.ok(path);
      const json = text.split("\n\n")[1];
      assert.ok(json);
      const input: unknown = JSON.parse(json);
      await decodeInput(path, input);
      examples++;
    } else if (text.startsWith("/v1/")) {
      for (const origin of [
        "https://example.workers.dev",
        "https://forum.owner.example",
      ]) {
        const request = new Request(new URL(text, origin));
        const transport = await Effect.runPromise(readDocument(request));
        await decodeInput(new URL(request.url).pathname, transport);
        assert.ok(new TextEncoder().encode(request.url).length <= 14336);
      }
      examples++;
    }
  }
}
assert.ok(examples >= 14, "Operating examples must remain exercised");
assert.deepEqual([...directoryExamples].sort(), ["list", "name"]);
assert.doesNotMatch(
  reference,
  /historical|still return501|currently return501/,
);
assert.ok(outputs.get("/docs/retrieval.md")?.includes("Unicode 6.1"));
assert.ok(outputs.get("/docs/retrieval.md")?.includes("latestPublishingTime"));
for (const [path, content] of outputs) {
  if (!path.endsWith(".html")) continue;
  assert.doesNotMatch(
    content,
    /<script|<form|<iframe|<button|\bonclick=|rel="(?:prefetch|preload)"/i,
  );
  assert.doesNotMatch(content, /href="[^"\n]*\/v1\/(register|publish)/);
  assert.doesNotMatch(
    content,
    /href="https?:|src="https?:|factory\.8090\.ai|api\.agentforum\.site/,
  );
  assert.match(content, /<main>/);
  const navigation =
    /<nav\b[^>]*aria-label="Main navigation"[\s\S]*?<\/nav>/.exec(content)?.[0];
  assert.ok(navigation, `Missing public navigation: ${path}`);
  assert.deepEqual(
    Array.from(navigation.matchAll(/href="([^"]+)"/g), (match) => match[1]),
    ["/", "/authors", "/about", "/docs/"],
    `Only implemented public destinations may be advertised: ${path}`,
  );
  assert.match(navigation, /<a\s+href="\/">\s*Posts\s*<\/a>/);
  assert.doesNotMatch(navigation, /aria-disabled|data-forum-navigation/);
  for (const match of content.matchAll(/href="([^"]+)"/g)) {
    const href = match[1];
    assert.ok(href);
    const url = new URL(
      href.replaceAll("&amp;", "&"),
      "https://example.workers.dev" + path,
    );
    assert.equal(url.origin, "https://example.workers.dev");
    const key = url.pathname.endsWith("/")
      ? `${url.pathname}index.html`
      : url.pathname;
    // These exact public SSR destinations exist on the combined WO-28 base.
    // No filter/detail route is admitted as a documentation target.
    if (["/", "/authors", "/about"].includes(url.pathname)) {
      assert.equal(url.search, "");
      assert.equal(url.hash, "");
      continue;
    }
    const target = outputs.get(key);
    assert.ok(target !== undefined, `Broken local documentation link: ${href}`);
    if (url.hash && key.endsWith(".html"))
      assert.ok(
        target.includes(`id="${url.hash.slice(1)}"`),
        `Missing fragment: ${href}`,
      );
    if (url.hash.startsWith("#/")) {
      let value: unknown = JSON.parse(target);
      for (const token of url.hash.slice(2).split("/")) {
        assert.ok(typeof value === "object" && value !== null);
        const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
        assert.ok(key in value, `Missing OpenAPI pointer: ${href}`);
        value = Object.getOwnPropertyDescriptor(value, key)?.value;
      }
    }
  }
}
console.log(
  `Documentation checks passed: ${String(outputs.size)} deterministic outputs; ${String(examples)} logical/transport examples; all local links/fragments and generated operations/responses; no active mutations.`,
);
