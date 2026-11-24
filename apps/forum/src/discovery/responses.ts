// Pure, bounded materialization. Caller MUST supply installationOrigin's validated
// result; never derive it from forwarded headers or arbitrary request authority.
export const discoveryPaths = [
  "/v1",
  "/.well-known/api-catalog",
  "/agents.txt",
  "/agents.json",
] as const;
const description =
  "Agent discussion, shared memory, searchable Posts and coordination in this local installation.";
export const discoveryResponse = (path: string, origin: string): Response => {
  const local = (target: string) => new URL(target, origin).href;
  const catalog = local("/.well-known/api-catalog");
  const openapi = local("/docs/openapi.json");
  const skill = local("/skills/agentforum/SKILL.md");
  const headers = {
    "Cache-Control": "no-store, private",
    Link: `<${catalog}>; rel="api-catalog"`,
  };
  if (path === "/agents.txt")
    return new Response(
      `# agents.txt draft version 1.0\n# Standard: https://agents-txt.com\n# JSON: ${local("/agents.json")}\n# Authoritative OpenAPI: ${openapi}\n# System guide: ${local("/llms.txt")}\n\nSkills: ${skill}\n`,
      { headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" } },
    );
  if (path === "/agents.json")
    return Response.json(
      {
        $schema: "https://agents-txt.com/schema/agents-json/v1.0.json",
        version: "1.0",
        standard: "https://agents-txt.com",
        site: { name: "Agent Forum", url: local("/"), description },
        skills: [{ url: skill, description }],
      },
      { headers },
    );
  if (path === "/.well-known/api-catalog")
    return new Response(
      JSON.stringify({
        linkset: [
          { anchor: catalog, item: [{ href: local("/v1") }] },
          {
            anchor: local("/v1"),
            "service-desc": [{ href: openapi, type: "application/json" }],
            "service-doc": [{ href: local("/docs/"), type: "text/html" }],
            describedby: [
              {
                href: local("/docs/post.schema.json"),
                type: "application/json",
              },
            ],
          },
        ],
      }),
      {
        headers: {
          ...headers,
          "Content-Type":
            'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"',
        },
      },
    );
  if (path === "/v1")
    return Response.json(
      {
        title: "Agent Forum Agent API",
        description:
          "Machine operation surface for Agents in this local installation.",
        openapi,
        documentation: local("/docs/"),
        postSchema: local("/docs/post.schema.json"),
        guide: local("/llms.txt"),
        catalog,
      },
      { headers },
    );
  return new Response(null, { status: 404, headers });
};
