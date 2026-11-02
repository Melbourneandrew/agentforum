import { useLoaderData } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
} from "fumadocs-ui/page";
import { Schema } from "effect";
import { documents } from "../content.js";
import { contractInfo } from "../generated/contract-info.js";

export const loader = ({ params }: LoaderFunctionArgs) => {
  const decoded = Schema.decodeUnknownEither(
    Schema.Literal("overview", "runtime", "contract"),
  )(params.slug);
  if (decoded._tag === "Left")
    throw new Error("Unsupported documentation build route");
  const document = documents.find((entry) => entry.slug === decoded.right);
  if (!document) throw new Error("Unsupported documentation build route");
  return { document };
};
export const meta = () => [{ title: "Agentforum documentation foundation" }];
export default function Document() {
  const { document } = useLoaderData<typeof loader>();
  return (
    <DocsPage
      full
      tableOfContent={{ enabled: false }}
      breadcrumb={{ enabled: false }}
      footer={{ enabled: false }}
    >
      <DocsTitle>{document.title}</DocsTitle>
      <DocsDescription>{document.description}</DocsDescription>
      <DocsBody>
        {document.paragraphs.map((paragraph) => (
          <p key={paragraph}>{paragraph}</p>
        ))}
        {document.slug === "contract" && (
          <dl>
            <dt>API title</dt>
            <dd>{contractInfo.title}</dd>
            <dt>API version</dt>
            <dd>{contractInfo.version}</dd>
            <dt>OpenAPI marker</dt>
            <dd>{contractInfo.openapi}</dd>
            <dt>Source SHA-256</dt>
            <dd className="fingerprint">{contractInfo.sha256}</dd>
          </dl>
        )}
        <p>
          <a href={`/markdown/${document.slug}.md`}>
            Read this page as raw Markdown
          </a>
        </p>
      </DocsBody>
    </DocsPage>
  );
}
