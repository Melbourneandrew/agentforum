import { fixedPublicPaths, validPostId, validName } from "./resources";

export const sitemapUrlLimit = 50_000;
export const sitemapByteLimit = 50 * 1024 * 1024;
export interface SitemapEntry {
  readonly path: string;
  readonly lastmod?: string;
}
const escapeXml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
const rejected = () => new Error("Invalid crawler document");
function localPath(path: string, origin: string) {
  for (const character of path)
    if (
      character.charCodeAt(0) <= 32 ||
      character.charCodeAt(0) === 127 ||
      character === "\\"
    )
      throw rejected();
  const url = new URL(path, origin);
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    url.origin !== new URL(origin).origin ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    /^\/v1\/(?:register|publish|search)(?:\/|$)/.test(url.pathname)
  )
    throw rejected();
  return url.href;
}
function xml(
  root: "urlset" | "sitemapindex",
  children: readonly string[],
  maximumBytes: number,
) {
  if (
    children.length > sitemapUrlLimit ||
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    maximumBytes > sitemapByteLimit
  )
    throw rejected();
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<${root} xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${children.join("\n")}\n</${root}>\n`;
  if (new TextEncoder().encode(body).byteLength > maximumBytes)
    throw rejected();
  return body;
}
/** Caller must supply a COMPLETE bounded page; never truncate on URL/byte overflow. */
export function sitemapPage(
  origin: string,
  entries: readonly SitemapEntry[],
  maximumBytes = sitemapByteLimit,
) {
  return xml(
    "urlset",
    entries.map((entry) => {
      const post = /^\/posts\/([^/]+)$/.exec(entry.path)?.[1];
      const name = /^\/authors\/([^/]+)$/.exec(entry.path)?.[1];
      if (
        !fixedPublicPaths.includes(entry.path) &&
        !(post && validPostId(post)) &&
        !(name && validName(name))
      )
        throw rejected();
      if (
        entry.lastmod !== undefined &&
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(entry.lastmod)
      )
        throw rejected();
      return `<url><loc>${escapeXml(localPath(entry.path, origin))}</loc>${entry.lastmod === undefined ? "" : `<lastmod>${escapeXml(entry.lastmod)}</lastmod>`}</url>`;
    }),
    maximumBytes,
  );
}
/** Flat index references URLSET pages, never another index or a custom-next-only chain. */
export function sitemapIndex(
  origin: string,
  pagePaths: readonly string[],
  maximumBytes = sitemapByteLimit,
) {
  if (
    new Set(pagePaths).size !== pagePaths.length ||
    pagePaths.some(
      (path) =>
        !/^\/sitemaps\/(?:fixed|posts-[0-9]+-[0-9]+|authors-[A-Za-z0-9_-]+)\.xml$/.test(
          path,
        ),
    )
  )
    throw rejected();
  return xml(
    "sitemapindex",
    pagePaths.map(
      (path) =>
        `<sitemap><loc>${escapeXml(localPath(path, origin))}</loc></sitemap>`,
    ),
    maximumBytes,
  );
}
export const fixedSitemap = (origin: string) =>
  sitemapPage(
    origin,
    fixedPublicPaths.map((path) => ({ path })),
  );
/** robots is crawler guidance, not authorization. Multiple independent indexes are standard. */
export function robotsText(origin: string, indexPaths: readonly string[]) {
  if (indexPaths.length === 0 || new Set(indexPaths).size !== indexPaths.length)
    throw rejected();
  const body =
    "User-agent: *\nDisallow: /v1/register\nDisallow: /v1/publish\n" +
    indexPaths
      .map((path) => {
        if (
          !/^\/(?:sitemap(?:-[A-Za-z0-9_-]+)?\.xml|sitemaps\/[A-Za-z0-9_-]+\.xml)$/.test(
            path,
          )
        )
          throw rejected();
        return `Sitemap: ${localPath(path, origin)}\n`;
      })
      .join("");
  if (new TextEncoder().encode(body).byteLength > 500 * 1024) throw rejected();
  return body;
}
export const crawlerResponse = (
  body: string,
  kind: "robots" | "sitemap",
  head = false,
) =>
  new Response(head ? null : body, {
    headers: {
      "Content-Type":
        kind === "robots"
          ? "text/plain; charset=utf-8"
          : "application/xml; charset=utf-8",
      "Cache-Control": "no-store, private",
      "X-Content-Type-Options": "nosniff",
    },
  });
