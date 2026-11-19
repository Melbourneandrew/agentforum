import { Context, Data, Effect, Layer, Schema } from "effect";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeSanitize from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import type { Root, Element, RootContent } from "hast";
import type { Node, Parent } from "unist";

export const renderLimits: RenderLimits = Object.freeze({
  inputBytes: 65_536,
  depth: 64,
  nodes: 20_000,
  outputBytes: 524_288,
});
export interface RenderLimits {
  readonly inputBytes: number;
  readonly depth: number;
  readonly nodes: number;
  readonly outputBytes: number;
}
export class MarkdownRenderError extends Data.TaggedError(
  "MarkdownRenderError",
) {}
const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
const isParent = (node: Node): node is Parent =>
  "children" in node && Array.isArray(node.children);
// This bounds later transforms, not time already spent in synchronous parsing.
const checkTree = (root: Node, limits: RenderLimits) => {
  const stack = [{ node: root, depth: 0 }];
  let count = 0;
  while (stack.length > 0) {
    const entry = stack.pop();
    if (!entry) break;
    if (++count > limits.nodes || entry.depth > limits.depth)
      throw new MarkdownRenderError();
    if (isParent(entry.node)) {
      for (const node of entry.node.children)
        stack.push({ node, depth: entry.depth + 1 });
      if (stack.length > limits.nodes) throw new MarkdownRenderError();
    }
  }
};
const destination = (node: Element): RootContent => {
  const value =
    node.tagName === "img" ? node.properties.src : node.properties.href;
  const url = typeof value === "string" ? value : "";
  const label =
    node.tagName === "img" && typeof node.properties.alt === "string"
      ? [{ type: "text" as const, value: node.properties.alt }]
      : node.children;
  // Destinations remain visible/copyable data, never browser-navigable href/src.
  // Even seemingly safe HTTPS URLs can invoke third-party mutations via GET.
  return {
    type: "element",
    tagName: "span",
    properties: { className: ["untrusted-destination"] },
    children: [
      ...label,
      {
        type: "text",
        value: ` [Untrusted ${node.tagName === "img" ? "image" : "link"} destination: ${url}]`,
      },
    ],
  };
};
const neutralizeDestinations = () => (tree: Root) => {
  const stack: (Root | Element)[] = [tree];
  while (stack.length > 0) {
    const parent = stack.pop();
    if (!parent) break;
    parent.children = parent.children.map((node) => {
      if (node.type !== "element") return node;
      if (node.tagName === "a" || node.tagName === "img")
        return destination(node);
      if (node.tagName === "input")
        return {
          type: "text" as const,
          value: node.properties.checked === true ? "[x] " : "[ ] ",
        };
      return node;
    });
    for (const child of parent.children)
      if (child.type === "element") stack.push(child);
  }
};
// Complete-tree allowlist after conversion; no active elements, resource URLs,
// IDs, event handlers, styles, forms or user-controlled navigation attributes.
const allowlist: NonNullable<Parameters<typeof rehypeSanitize>[0]> = {
  tagNames: [
    "p",
    "br",
    "hr",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "blockquote",
    "ul",
    "ol",
    "li",
    "pre",
    "code",
    "em",
    "strong",
    "del",
    "table",
    "thead",
    "tbody",
    "tr",
    "th",
    "td",
    "span",
    "section",
    "sup",
  ],
  attributes: {
    code: [["className", /^language-[a-zA-Z0-9-]+$/]],
    span: [["className", "untrusted-destination"]],
    ol: ["start"],
    th: [["align", "left", "center", "right"]],
    td: [["align", "left", "center", "right"]],
  },
  protocols: {},
  clobber: ["id", "name"],
  clobberPrefix: "untrusted-",
};
const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype, {
    handlers: {
      html: (_state, node: unknown) => ({
        type: "text",
        value: Schema.decodeUnknownSync(
          Schema.Struct({ value: Schema.String }),
        )(node).value,
      }),
    },
  })
  .use(neutralizeDestinations)
  .use(rehypeSanitize, allowlist)
  .use(rehypeStringify)
  .freeze();

export class MarkdownRenderer extends Context.Tag(
  "@agentforum/web/MarkdownRenderer",
)<
  MarkdownRenderer,
  {
    readonly render: (
      body: string,
    ) => Effect.Effect<string, MarkdownRenderError>;
  }
>() {}
export const markdownRendererLayer = (limits: RenderLimits = renderLimits) =>
  Layer.succeed(MarkdownRenderer, {
    render: (body) =>
      Effect.try({
        try: () => {
          if (
            body.length > limits.inputBytes ||
            bytes(body) > limits.inputBytes
          )
            throw new MarkdownRenderError();
          const parsed = processor.parse(body);
          checkTree(parsed, limits);
          const sanitized = processor.runSync(parsed);
          checkTree(sanitized, limits);
          const html = processor.stringify(sanitized);
          if (bytes(html) > limits.outputBytes) throw new MarkdownRenderError();
          return html;
        },
        catch: () => new MarkdownRenderError(),
      }),
  });
export const renderMarkdown = (body: string) =>
  Effect.flatMap(MarkdownRenderer, (renderer) => renderer.render(body)).pipe(
    Effect.map((html) => ({ status: "rendered" as const, html })),
    Effect.catchTag("MarkdownRenderError", () =>
      Effect.succeed({ status: "fallback" as const }),
    ),
  );
