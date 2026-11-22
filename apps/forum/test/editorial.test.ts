import { env } from "cloudflare:workers";
import { makeDispatcher } from "../src/runtime/dispatch.js";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  EditorialShell,
  PageState,
  PaginationLinks,
  PublicationFacts,
  SectionHeading,
} from "../app/presentation/editorial";

describe("shared editorial presentation", () => {
  it("allows only same-origin fonts while retaining every existing SSR CSP directive", async () => {
    const app = makeDispatcher(() =>
      Promise.resolve(new Response("Editorial shell")),
    );
    const response = await app.fetch(
      new Request("https://fonts.owner.workers.dev/", {
        headers: { "Cache-Control": "no-cache" },
      }),
      env,
      {
        waitUntil: () => undefined,
        passThroughOnException: () => undefined,
        props: {},
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Security-Policy")).toBe(
      "default-src 'none'; style-src 'self'; img-src 'self'; script-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; font-src 'self'",
    );
    expect(response.headers.has("Access-Control-Allow-Origin")).toBe(false);
  });
  it("keeps unfinished navigation inert and existing docs local", () => {
    const html = renderToStaticMarkup(
      h(EditorialShell, { children: h("main", null, "Foundation") }),
    );
    expect(html).toContain("Agent Forum");
    expect(html).toContain("Public Forum");
    expect(html).toContain("For Agents");
    expect(html).toContain('href="/docs/"');
    for (const view of ["Posts", "Authors", "About"]) {
      expect(html).toContain(`title="Not yet available">${view}</span>`);
    }
    expect(html).not.toMatch(/href="\/(posts|authors|about)/);
    expect(html).not.toMatch(/<script|<form|prefetch|onclick/i);
    expect(html).toContain('href="#forum-content"');
  });
  it("accepts real navigation destinations without inventing page state", () => {
    const html = renderToStaticMarkup(
      h(EditorialShell, {
        navigation: [{ label: "Authors", href: "/authors" }],
        current: "Authors",
        children: h("main", null, "Directory"),
      }),
    );
    expect(html).toContain('href="/authors" aria-current="page"');
  });
  it("escapes facts and preserves exact server-provided values", () => {
    const html = renderToStaticMarkup(
      h(PublicationFacts, {
        facts: [
          { label: "Author", value: '<script>alert("fixture")</script>' },
          { label: "Order", value: "9007199254740993" },
        ],
      }),
    );
    expect(html).toContain('aria-label="Publication facts"');
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("9007199254740993");
  });
  it("distinguishes loading, empty and retryable error presentation", () => {
    const loading = renderToStaticMarkup(
      h(PageState, { kind: "loading", children: "Loading posts…" }),
    );
    const empty = renderToStaticMarkup(
      h(PageState, { kind: "empty", children: "No posts match." }),
    );
    const error = renderToStaticMarkup(
      h(PageState, {
        kind: "error",
        retryHref: "/?q=word",
        children: "Posts could not be loaded.",
      }),
    );
    expect(loading).toContain('role="status" aria-busy="true"');
    expect(empty).toContain('role="status"');
    expect(empty).not.toContain("aria-busy");
    expect(error).toContain('role="alert"');
    expect(error).toContain('href="/?q=word">Try again');
  });
  it("presents supplied cursor URLs without manufacturing cursors or empty links", () => {
    const html = renderToStaticMarkup(
      h(PaginationLinks, {
        next: "/?cursor=opaque%2Bvalue&tag=A",
        label: "Author pages",
      }),
    );
    expect(html).toContain('aria-label="Author pages"');
    expect(html).toContain('aria-disabled="true">Previous');
    expect(html).toContain(
      'href="/?cursor=opaque%2Bvalue&amp;tag=A" rel="next"',
    );
    expect(html).not.toContain('href="#"');
  });
  it("leaves search behavior to the consuming page", () => {
    const html = renderToStaticMarkup(
      h(SectionHeading, {
        children: "Latest posts",
        control: h("input", { type: "search", "aria-label": "Search posts" }),
      }),
    );
    expect(html).toContain("<h2>Latest posts</h2>");
    expect(html).toContain('aria-label="Search posts"');
    expect(html).not.toMatch(/<form|>Go<|dropdown/);
  });
});
