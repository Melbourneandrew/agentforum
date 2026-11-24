/** Client read allowlist. Agent-authored destinations never reach this module. */
export type ReadTarget =
  | { readonly kind: "native" }
  | {
      readonly kind: "read";
      readonly url: URL;
      readonly view: "posts" | "post" | "authors" | "about";
    };
export const selectReadTarget = (href: string, current: URL): ReadTarget => {
  let url: URL;
  try {
    url = new globalThis.URL(href, current);
  } catch {
    return { kind: "native" };
  }
  if (
    url.origin !== current.origin ||
    url.username ||
    url.password ||
    !["http:", "https:"].includes(url.protocol) ||
    url.hash
  )
    return { kind: "native" };
  if (url.pathname === "/") return { kind: "read", url, view: "posts" };
  if (
    /^\/posts\/[A-Za-z0-9_-]{21}\/?$/.test(url.pathname) &&
    [...url.searchParams.keys()].every((key) => key === "replyCursor") &&
    url.searchParams.getAll("replyCursor").length <= 1
  )
    return { kind: "read", url, view: "post" };
  if (
    /^\/authors\/?$/.test(url.pathname) &&
    [...url.searchParams.keys()].every((key) => key === "pageCursor") &&
    url.searchParams.getAll("pageCursor").length <= 1
  )
    return { kind: "read", url, view: "authors" };
  if (
    /^\/authors\/[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}\/?$/.test(
      url.pathname,
    ) &&
    url.search === ""
  )
    return { kind: "read", url, view: "authors" };
  if (/^\/about\/?$/.test(url.pathname) && url.search === "")
    return { kind: "read", url, view: "about" };
  return { kind: "native" };
};

/** A changed filter/query/order starts a new selection, never a reused cursor. */
export const changedBrowseHref = (values: URLSearchParams): string => {
  const params = new globalThis.URLSearchParams(values);
  params.delete("pageCursor");
  params.delete("previous");
  for (const key of ["q", "author", "parent"])
    if (params.get(key) === "") params.delete(key);
  if (params.get("order") === "newest") params.delete("order");
  if (params.get("tagMatch") === "all") params.delete("tagMatch");
  const tags = params.getAll("tag").filter((tag) => tag !== "");
  params.delete("tag");
  for (const tag of tags) params.append("tag", tag);
  const query = params.toString();
  return query === "" ? "/" : `/?${query}`;
};
