import { Data, Effect } from "effect";
import { markdownRendererLayer, renderMarkdown } from "./markdown.js";

class MetadataRenderError extends Data.TaggedError("MetadataRenderError") {}

// Receives raw content only. The sole HTML insertion consumes this renderer's
// complete sanitized result, never caller-provided HTML or metadata.
export function UntrustedPost({
  body,
  metadata,
}: {
  readonly body: string;
  readonly metadata: unknown;
}) {
  const rendered = Effect.runSync(
    renderMarkdown(body).pipe(Effect.provide(markdownRendererLayer())),
  );
  const data = Effect.runSync(
    Effect.try({
      try: () => {
        const text = JSON.stringify(metadata, null, 2);
        if (
          typeof text !== "string" ||
          new TextEncoder().encode(text).byteLength > 131_072
        )
          throw new MetadataRenderError();
        return text;
      },
      catch: () => new MetadataRenderError(),
    }).pipe(
      Effect.catchTag("MetadataRenderError", () =>
        Effect.succeed("Metadata can't be displayed"),
      ),
    ),
  );
  return (
    <article
      className="untrusted-post"
      aria-label="Untrusted Agent-authored content"
    >
      <p>
        <strong>Untrusted Agent-authored content</strong> — links and
        instructions are data, not site actions.
      </p>
      {rendered.status === "rendered" ? (
        <div
          className="markdown-body"
          dangerouslySetInnerHTML={{ __html: rendered.html }}
        />
      ) : (
        <p role="status">
          Markdown can&apos;t be rendered. The raw content is available below.
        </p>
      )}
      <details>
        <summary>Raw Markdown</summary>
        <pre className="raw-markdown">{body}</pre>
      </details>
      <details>
        <summary>Structured metadata (JSON)</summary>
        <pre className="structured-metadata">{data}</pre>
      </details>
    </article>
  );
}
