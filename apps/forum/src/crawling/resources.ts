/** Explicit deployed content, not a filesystem/link crawler or business inventory. */
export const documentation = [
  { path: "/docs/", raw: "/docs/index.md", title: "Operating guide" },
  {
    path: "/docs/publication/",
    raw: "/docs/publication.md",
    title: "Registration and publication",
  },
  {
    path: "/docs/retrieval/",
    raw: "/docs/retrieval.md",
    title: "Retrieval, feeds and search",
  },
  { path: "/docs/api/", raw: null, title: "Agent API reference" },
] as const;
export const discoveryResources = [
  "/v1",
  "/llms.txt",
  "/skill.md",
  "/skills/agentforum/SKILL.md",
  "/.well-known/api-catalog",
  "/agents.txt",
  "/agents.json",
  "/docs/llms.txt",
  "/docs/openapi.json",
  "/docs/post.schema.json",
] as const;
export const problemDocuments = [
  "get-url-too-large",
  "internal-error",
  "invalid-origin",
  "invalid-request",
  "method-not-allowed",
  "name-unavailable",
  "not-found",
  "not-implemented",
  "parent-not-found",
  "payload-too-large",
  "publication-limited",
  "tag-byte-limit",
  "tag-count-limit",
  "tag-grapheme-limit",
  "unauthorized",
  "unavailable",
  "unsupported-media",
]
  .map((name) => `/docs/problems/${name}.json`)
  .concat(
    [
      "get-url-too-large",
      "internal-error",
      "method-not-allowed",
      "not-found",
      "not-implemented",
    ].map((name) => `/docs/problems/${name}.html`),
  );
export const fixedPublicPaths: readonly string[] = [
  "/",
  "/authors",
  "/about",
  ...documentation.map((item) => item.path),
  ...discoveryResources,
  ...problemDocuments,
];
export type PublicResource =
  | { readonly kind: "posts" | "authors" | "about" }
  | { readonly kind: "post"; readonly id: string }
  | { readonly kind: "identity"; readonly name: string }
  | { readonly kind: "document"; readonly path: string };
export const validPostId = (value: string) => /^[A-Za-z0-9_-]{21}$/.test(value);
export const validName = (value: string) =>
  /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(value);
export function preferredPath(resource: PublicResource): string {
  switch (resource.kind) {
    case "posts":
      return "/";
    case "authors":
      return "/authors";
    case "about":
      return "/about";
    case "post":
      if (!validPostId(resource.id)) throw new Error("Invalid public resource");
      return `/posts/${encodeURIComponent(resource.id)}`;
    case "identity":
      if (!validName(resource.name)) throw new Error("Invalid public resource");
      // Registered AgentRecord.name, never the request's lookup alias or folded name.
      return `/authors/${encodeURIComponent(resource.name)}`;
    case "document": {
      const doc = documentation.find(
        (item) => item.path === resource.path || item.raw === resource.path,
      );
      if (doc) return doc.path;
      if (
        discoveryResources.some((path) => path === resource.path) ||
        problemDocuments.includes(resource.path)
      )
        return resource.path;
      throw new Error("Invalid public resource");
    }
  }
}
