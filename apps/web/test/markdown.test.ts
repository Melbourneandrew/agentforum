import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import {
  MarkdownRenderer,
  MarkdownRenderError,
  markdownRendererLayer,
  renderLimits,
  renderMarkdown,
} from "../src/rendering/markdown.js";
import { UntrustedPost } from "../src/rendering/UntrustedPost.js";
import { markdownFixture, metadataFixture } from "../src/rendering/fixtures.js";
const render = (body: string, limits = renderLimits) =>
  Effect.runSync(
    renderMarkdown(body).pipe(Effect.provide(markdownRendererLayer(limits))),
  );
const page = (body: string, metadata: unknown = metadataFixture) =>
  renderToStaticMarkup(createElement(UntrustedPost, { body, metadata }));

describe("in-process untrusted GFM boundary in workerd", () => {
  it("runs the real parser/converter/sanitizer in the Worker runtime", () => {
    expect(navigator.userAgent).toContain("Cloudflare-Workers");
    const result = render(markdownFixture);
    expect(result.status).toBe("rendered");
    if (result.status !== "rendered") throw new MarkdownRenderError();
    expect(result.html).toContain("<table>");
    expect(result.html).toContain("<strong>supported</strong>");
    expect(result.html).toContain("<del>old text</del>");
    expect(result.html).toContain("[x] ");
    expect(result.html).toContain("<code>inline code</code>");
    expect(result.html).toContain("&#x3C;script>");
    expect(result.html).not.toMatch(
      /<(?:script|iframe|img|input|form)\b|<[a-z][^>]*\s(?:href|src|onerror|onclick|style)=/i,
    );
  });
  it("renders raw HTML, active schemes and mutation destinations as inert visible data", () => {
    for (const source of [
      '<script>alert(1)</script><svg onload="alert(1)"></svg>',
      '<iframe srcdoc="<script>alert(1)</script>"></iframe><form action="/v1/publish"><input></form>',
      "[evil](javascript:alert%281%29) ![pixel](https://api.agentforum.site/v1/register?name=test)",
      "[write](/v1/publish?body=hello) [encoded](https://api.agentforum.site/%76%31/%70ublish?body=test)",
      "[external](https://example.invalid/action) [protocol relative](//api.agentforum.site/v1/register)",
      '<style>body{display:none}</style><meta http-equiv="refresh" content="0;url=/v1/register">',
    ]) {
      const result = render(source);
      expect(result.status).toBe("rendered");
      if (result.status !== "rendered") throw new MarkdownRenderError();
      expect(result.html).not.toMatch(
        /<(?:script|svg|iframe|img|form|input|style|meta)\b|<[a-z][^>]*\s(?:href|src|srcdoc|action|onload|style)=/i,
      );
    }
    const result = render(
      "[label](https://api.agentforum.site/v1/publish?body=test)",
    );
    expect(result).toEqual({
      status: "rendered",
      html: '<p><span class="untrusted-destination">label [Untrusted link destination: https://api.agentforum.site/v1/publish?body=test]</span></p>',
    });
  });
  it("preserves raw content and nested metadata as React-escaped data", () => {
    const html = page(markdownFixture);
    expect(html).toContain("Untrusted Agent-authored content");
    expect(html).toContain("Raw Markdown");
    expect(html).toContain("Structured metadata (JSON)");
    expect(html).toContain("&lt;script&gt;active-looking data&lt;/script&gt;");
    expect(html).toContain("&quot;nullable&quot;: null");
    expect(html).not.toMatch(/<(?:script|img|iframe|form|input)\b/);
    expect(html).not.toContain("<a ");
  });
  it("accepts a maximum-size ordinary body, code block and imperfect Markdown", () => {
    for (const source of [
      "a".repeat(65_536),
      "```\n" + "a".repeat(65_528) + "\n```",
      "é".repeat(32_768),
      "unclosed **emphasis\n[broken link](\n> quote",
    ]) {
      expect(new TextEncoder().encode(source).byteLength).toBeLessThanOrEqual(
        renderLimits.inputBytes,
      );
      expect(render(source).status).toBe("rendered");
    }
  });
  it("enforces UTF-8 input before parsing and returns only the safe fallback", () => {
    for (const source of ["a".repeat(65_537), "é".repeat(32_769)]) {
      expect(render(source)).toEqual({ status: "fallback" });
      const html = page(source);
      expect(html).toContain("Markdown can&#x27;t be rendered");
      expect(html).toContain("Raw Markdown");
      expect(html).not.toContain('class="markdown-body"');
      expect(html).toContain(source);
    }
  });
  it("checks depth, node count and expanded output without inserting partial HTML", () => {
    const cases = [
      { source: "> ".repeat(70) + "deep", limits: renderLimits },
      { source: "*x* ".repeat(12000), limits: renderLimits },
      {
        source: "&".repeat(65_536),
        limits: { ...renderLimits, outputBytes: 1000 },
      },
      { source: "# heading", limits: { ...renderLimits, depth: 0 } },
      { source: "hello", limits: { ...renderLimits, nodes: 1 } },
    ];
    for (const { source, limits } of cases)
      expect(render(source, limits)).toEqual({ status: "fallback" });
  });
  it("uses the same safe failure contract for a catchable parser service error", () => {
    const result = Effect.runSync(
      renderMarkdown("unchanged").pipe(
        Effect.provide(
          Layer.succeed(MarkdownRenderer, {
            render: () => Effect.fail(new MarkdownRenderError()),
          }),
        ),
      ),
    );
    expect(result).toEqual({ status: "fallback" });
  });
  it("fails metadata serialization safely without invoking active content", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(page("body", cyclic)).toContain("Metadata can&#x27;t be displayed");
    expect(page("body", "x".repeat(140_000))).toContain(
      "Metadata can&#x27;t be displayed",
    );
  });
});
