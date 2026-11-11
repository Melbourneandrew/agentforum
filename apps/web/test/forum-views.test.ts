import { PostRecord, SearchResult } from "@agentforum/contracts";
import { Option, Schema } from "effect";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ForumFailure, PostDetail, PostsTable } from "../src/forum/views.js";
const record = (reply: string | null = null) =>
  Schema.decodeUnknownSync(PostRecord)({
    id: "a".repeat(21),
    author_id: "6eae4017-9df1-4bd4-b5c7-f29c58a40d3d",
    author_name: "ActualAuthor",
    body: "# Raw body\n<script>run()</script>\n[mutate](https://api.agentforum.site/v1/publish?payload=untrusted)",
    metadata: {
      title: '<img src="/untrusted" onerror="run()">',
      author: "forged",
      nested: [{ flag: false, count: 3, nil: null }],
    },
    reply_to_id: reply,
    publication_order: "9007199254740993",
    published_at: "2026-11-11T08:00:00.000Z",
  });
const replies = () =>
  Schema.decodeUnknownSync(SearchResult)({
    posts: [],
    page_cursor: null,
    read_cursor: "opaque",
    has_more: false,
  });
describe("shared Post views in genuine workerd (synthetic data, not API integration)", () => {
  it("shows identifying facts and real navigation, not prototype controls, counts or classification", () => {
    const html = renderToStaticMarkup(
      createElement(PostsTable, {
        posts: [record()],
        previous: Option.some("/?cursor=previous"),
        next: Option.some("/?cursor=next"),
        parent: Option.none(),
      }),
    );
    expect(html).toContain("ActualAuthor");
    expect(html).toContain("/posts/" + "a".repeat(21));
    expect(html).toContain('rel="prev"');
    expect(html).toContain('rel="next"');
    expect(html).toContain("1 Post on this page");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<input");
    expect(html).not.toContain("Frontmatter filters");
    expect(html).not.toContain("12 replies");
    expect(html).not.toContain("unclassified");
  });
  it("renders full content and typed nested metadata safely, with separate authoritative facts and parent/reply access", () => {
    const html = renderToStaticMarkup(
      createElement(PostDetail, {
        post: record("b".repeat(21)),
        replies: replies(),
      }),
    );
    expect(html).toContain("Structured metadata (JSON)");
    expect(html).toContain("false");
    expect(html).toContain("null");
    expect(html).toContain("9007199254740993");
    expect(html).toContain("<dd>ActualAuthor</dd>");
    expect(html).toContain("Raw Markdown");
    expect(html).toContain("/posts/" + "b".repeat(21));
    expect(html).toContain("/?reply_to=" + "a".repeat(21));
    expect(html).toContain("No direct replies yet.");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain('href="https://api.agentforum.site/v1/publish');
    expect(html).not.toContain("<iframe");
  });
  it("covers empty feed/reply states with honest unavailable navigation", () => {
    for (const parent of [Option.none<string>(), Option.some("b".repeat(21))]) {
      const html = renderToStaticMarkup(
        createElement(PostsTable, {
          posts: [],
          previous: Option.none(),
          next: Option.none(),
          parent,
        }),
      );
      expect(html).toContain("No Posts to display");
      expect(html).toContain('aria-disabled="true"');
      expect(html).not.toContain('rel="next"');
      expect(html).not.toContain("<button");
    }
  });
  it("distinguishes missing data from failed loading and offers a retry of the same validated page", () => {
    for (const missing of [true, false]) {
      const html = renderToStaticMarkup(
        createElement(ForumFailure, { missing, retry: "/?cursor=opaque" }),
      );
      expect(html).toContain(
        missing ? "Post not found" : "Forum content could not be loaded",
      );
      expect(html).toContain('href="/?cursor=opaque"');
      expect(html).toContain("Retry this page");
    }
  });
});
