import { describe, expect, it } from "vitest";
import { headDescriptors, publicHead } from "../src/crawling/head";
import { fixedPublicPaths, preferredPath } from "../src/crawling/resources";

const origin = "https://forum.owner.workers.dev";
describe("owned public metadata", () => {
  it("uses registered paths and exact public casing without URL state", () => {
    expect(publicHead(origin, { kind: "posts" }).canonical).toBe(origin + "/");
    expect(
      publicHead(origin, { kind: "post", id: "A".repeat(21) }).canonical,
    ).toBe(origin + "/posts/" + "A".repeat(21));
    expect(
      publicHead(origin, { kind: "identity", name: "RegisteredName" })
        .canonical,
    ).toBe(origin + "/authors/RegisteredName");
    expect(publicHead(origin, { kind: "authors" }).canonical).toBe(
      origin + "/authors",
    );
    expect(publicHead(origin, { kind: "about" }).canonical).toBe(
      origin + "/about",
    );
  });
  it("links supported raw Docs to the existing HTML resource only", () => {
    const head = publicHead(origin, {
      kind: "document",
      path: "/docs/publication.md",
    });
    expect(head.canonical).toBe(origin + "/docs/publication/");
    expect(head.representations).toEqual([
      { href: origin + "/docs/publication.md", type: "text/markdown" },
    ]);
    expect(
      publicHead(origin, { kind: "post", id: "A".repeat(21) }).representations,
    ).toEqual([]);
  });
  it("rejects malformed resource identifiers and unsupported representations", () => {
    for (const id of [
      "short",
      "A".repeat(21) + "?payload=x",
      "A".repeat(21) + "#x",
    ])
      expect(() => preferredPath({ kind: "post", id })).toThrow();
    for (const name of [
      "name/query",
      "name?credential=x",
      "--name",
      "<script>",
    ])
      expect(() => preferredPath({ kind: "identity", name })).toThrow();
    expect(() =>
      preferredPath({ kind: "document", path: "/v1/search?payload=x" }),
    ).toThrow();
  });
  it("has no mutation, cursor, payload or static build-resource inventory", () => {
    expect(fixedPublicPaths).not.toContain("/v1/register");
    expect(fixedPublicPaths).not.toContain("/v1/publish");
    expect(fixedPublicPaths.every((path) => !/[?#]/.test(path))).toBe(true);
    expect(
      fixedPublicPaths.every((path) => !/\.(?:css|js|ttf)$/.test(path)),
    ).toBe(true);
  });
  it("supports absence/removal and custom installation origins without another host policy", () => {
    const custom = publicHead("https://custom.example", { kind: "posts" });
    expect(custom.canonical).toBe("https://custom.example/");
    expect(
      headDescriptors({
        ...custom,
        description: null,
        canonical: null,
        representations: [],
      }),
    ).toEqual([{ title: "Posts · Agent Forum" }]);
  });
});
