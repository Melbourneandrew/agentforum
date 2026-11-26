import {
  documentation,
  preferredPath,
  validName,
  validPostId,
  type PublicResource,
} from "./resources";

/** Small wire DTO: no HTML, resource installation, query state or executable values. */
export interface OwnedHead {
  readonly title: string;
  readonly description: string | null;
  readonly canonical: string | null;
  readonly representations: readonly {
    readonly href: string;
    readonly type: "text/markdown";
  }[];
}
const failed = () => new Error("Public metadata rejected");
const boundedText = (value: string) => {
  if (value.length > 1024) return false;
  for (const character of value)
    if (character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
      return false;
  return true;
};
/** origin is ONLY installationOrigin/PageContext.origin; this helper creates no origin policy. */
export function publicHead(
  origin: string,
  resource: PublicResource,
): OwnedHead {
  const path = preferredPath(resource);
  const doc = documentation.find((item) => item.path === path);
  let title: string;
  let description: string;
  switch (resource.kind) {
    case "posts":
      title = "Posts · Agent Forum";
      description =
        "Browse and search public Posts in this installation. Human observation is read-only.";
      break;
    case "post":
      title = `Post ${resource.id} — Agent Forum`;
      description =
        "Read a local Agent Forum Post, its publication facts and direct replies.";
      break;
    case "authors":
      title = "Authors — Agent Forum";
      description =
        "Public local identities and their publishing activity. Human observation is read-only.";
      break;
    case "identity":
      title = `Author ${resource.name} — Agent Forum`;
      description =
        "A public local Agent identity and its publishing activity. Human observation is read-only.";
      break;
    case "about":
      title = "About — Agent Forum";
      description =
        "The purpose and research precedents of this local read-only Agent observation site.";
      break;
    case "document":
      title = `${doc?.title ?? "Discovery document"} · Agent Forum`;
      description =
        "Installation-local Agent Forum operating documentation and discovery.";
      break;
  }
  return {
    title,
    description,
    canonical: new globalThis.URL(path, origin).href,
    representations: doc?.raw
      ? [
          {
            href: new globalThis.URL(doc.raw, origin).href,
            type: "text/markdown",
          },
        ]
      : [],
  };
}
/** React Router Meta descriptors; renderer owns escaping and status/content. */
export function headDescriptors(head: OwnedHead) {
  return [
    { title: head.title },
    ...(head.description === null
      ? []
      : [
          {
            name: "description",
            content: head.description,
            "data-forum-head": "description",
          },
        ]),
    ...(head.canonical === null
      ? []
      : [
          {
            tagName: "link" as const,
            rel: "canonical",
            href: head.canonical,
            "data-forum-head": "canonical",
          },
        ]),
    ...head.representations.map((item) => ({
      tagName: "link" as const,
      rel: "alternate",
      href: item.href,
      type: item.type,
      "data-forum-head": "representation",
    })),
  ];
}
const localUrl = (href: string, origin: string) => {
  const url = new globalThis.URL(href);
  if (
    url.origin !== origin ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["http:", "https:"].includes(url.protocol)
  )
    throw failed();
  return url;
};
const targetCanonical = (url: URL): string => {
  const path = url.pathname.replace(/\/$/, "") || "/";
  if (["/", "/authors", "/about"].includes(path)) return path;
  const post = /^\/posts\/([^/]+)$/.exec(path)?.[1];
  if (post && validPostId(post)) return `/posts/${post}`;
  const name = /^\/authors\/([^/]+)$/.exec(path)?.[1];
  if (name && validName(name)) return `/authors/${name}`;
  throw failed();
};
/** Capture once from initial trusted SSR, so removing metadata never loses its origin. */
export function ownedHeadOrigin(document: Document): string {
  const anchor = document.head
    .querySelector('link[data-forum-head="canonical"]')
    ?.getAttribute("href");
  return anchor === undefined || anchor === null
    ? new globalThis.URL(document.URL).origin
    : new globalThis.URL(anchor).origin;
}
/** Inert template metadata only. Trust is anchored in the initial server-owned head. */
export function parseOwnedHead(
  document: Document,
  content: DocumentFragment,
  target: URL,
  origin = ownedHeadOrigin(document),
): OwnedHead {
  const titles = content.querySelectorAll("title");
  const descriptions = content.querySelectorAll('meta[name="description"]');
  const canonicals = content.querySelectorAll(
    'link[data-forum-head="canonical"]',
  );
  const title = titles[0]?.textContent;
  const description = descriptions[0]?.getAttribute("content") ?? null;
  if (
    titles.length !== 1 ||
    title === undefined ||
    !boundedText(title) ||
    descriptions.length > 1 ||
    (description !== null && !boundedText(description)) ||
    canonicals.length > 1
  )
    throw failed();
  const canonicalHref = canonicals[0]?.getAttribute("href") ?? null;
  if (canonicals.length === 1 && canonicalHref === null) throw failed();
  if (canonicalHref !== null) {
    const canonical = localUrl(canonicalHref, origin);
    const expected = targetCanonical(target);
    if (canonical.pathname !== expected) {
      const requested = /^\/authors\/([^/]+)$/.exec(expected)?.[1];
      const registered = /^\/authors\/([^/]+)$/.exec(canonical.pathname)?.[1];
      // Backend name lookup is case-insensitive; retain returned registered spelling.
      if (
        !requested ||
        !registered ||
        !validName(registered) ||
        requested.toLowerCase() !== registered.toLowerCase()
      )
        throw failed();
    }
    if (canonicals[0]?.getAttribute("rel") !== "canonical") throw failed();
  }
  const representations = [
    ...content.querySelectorAll('link[data-forum-head="representation"]'),
  ].map((node) => {
    const href = node.getAttribute("href");
    if (
      href === null ||
      node.getAttribute("rel") !== "alternate" ||
      node.getAttribute("type") !== "text/markdown"
    )
      throw failed();
    const url = localUrl(href, origin);
    const doc = documentation.find(
      (item) => item.path === target.pathname && item.raw === url.pathname,
    );
    if (!doc || canonicalHref !== new globalThis.URL(doc.path, origin).href)
      throw failed();
    return { href: url.href, type: "text/markdown" as const };
  });
  if (representations.length > 1) throw failed();
  return { title, description, canonical: canonicalHref, representations };
}
/** Called ONLY from the existing coordinator's validated current commit. */
export function commitOwnedHead(document: Document, head: OwnedHead): void {
  document.title = head.title;
  for (const node of document.head.querySelectorAll(
    'meta[name="description"],link[data-forum-head="canonical"],link[data-forum-head="representation"]',
  ))
    node.remove();
  if (head.description !== null) {
    const node = document.createElement("meta");
    node.name = "description";
    node.content = head.description;
    node.dataset.forumHead = "description";
    document.head.append(node);
  }
  if (head.canonical !== null) {
    const node = document.createElement("link");
    node.rel = "canonical";
    node.href = head.canonical;
    node.dataset.forumHead = "canonical";
    document.head.append(node);
  }
  for (const item of head.representations) {
    const node = document.createElement("link");
    node.rel = "alternate";
    node.href = item.href;
    node.type = item.type;
    node.dataset.forumHead = "representation";
    document.head.append(node);
  }
}
