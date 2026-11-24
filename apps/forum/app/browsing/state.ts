import { Data, Effect, Option } from "effect";
import { decodeSearch, type SearchInput } from "../../src/api/query.js";

export const browsePageSize = 10;
export const previousPageLimit = 20;
// Bounds presentation URLs, not the API transport's distinct GET Submission Limit.
export const browseUrlByteLimit = 65_536;
export type PostSelection = Exclude<
  Extract<SearchInput, { readonly resource: "posts" }>,
  { readonly id: string }
>;
export interface BrowseState {
  readonly selection: PostSelection;
  readonly previous: readonly Option.Option<string>[];
}
export class InvalidBrowseState extends Data.TaggedError(
  "InvalidBrowseState",
) {}
const singletons = ["q", "author", "parent", "tagMatch", "order", "pageCursor"];
const optionalValue = (value: string | null) =>
  Option.fromNullable(value).pipe(Option.filter((text) => text !== ""));
export const selectionWire = (selection: PostSelection) => ({
  resource: "posts" as const,
  limit: browsePageSize,
  tags: selection.tags,
  tagMatch: selection.tagMatch,
  order: selection.order,
  ...(Option.isSome(selection.q) ? { q: selection.q.value } : {}),
  ...(Option.isSome(selection.author)
    ? { author: selection.author.value }
    : {}),
  ...(Option.isSome(selection.parent)
    ? { parent: selection.parent.value }
    : {}),
});

/** Every cursor, including predecessor hints, is validated before the read port. */
export const decodeBrowseState = (url: URL) =>
  Effect.gen(function* () {
    yield* Effect.try({
      try: () => decodeURIComponent(url.search),
      catch: () => new InvalidBrowseState(),
    });
    const params = url.searchParams;
    if (
      url.pathname !== "/" ||
      new TextEncoder().encode(url.href).length > browseUrlByteLimit ||
      [...params.keys()].some(
        (key) =>
          !singletons.includes(key) && key !== "tag" && key !== "previous",
      ) ||
      singletons.some((key) => params.getAll(key).length > 1) ||
      params.getAll("previous").length > previousPageLimit
    )
      return yield* new InvalidBrowseState();
    const fields = Object.fromEntries(
      singletons.flatMap((key) => {
        const value = optionalValue(params.get(key));
        return Option.isSome(value) ? [[key, value.value]] : [];
      }),
    );
    const selection = yield* decodeSearch({
      resource: "posts",
      limit: browsePageSize,
      ...fields,
      // Blank controls mean no Tag; whitespace/punctuation remain exact data.
      tags: params.getAll("tag").filter((tag) => tag !== ""),
    });
    if (selection.resource !== "posts" || "id" in selection)
      return yield* new InvalidBrowseState();
    const previous = params.getAll("previous").map(optionalValue);
    if (previous.length > 0 && Option.isNone(selection.pageCursor))
      return yield* new InvalidBrowseState();
    for (const cursor of previous) {
      if (Option.isSome(cursor))
        yield* decodeSearch({
          ...selectionWire(selection),
          pageCursor: cursor.value,
        });
    }
    return { selection, previous } satisfies BrowseState;
  });

/** Public URLs retain exact Tags; only default/empty controls are omitted. */
export const browseHref = (state: BrowseState): string => {
  const { selection, previous } = state;
  const params = new URLSearchParams();
  for (const [key, value] of [
    ["q", selection.q],
    ["author", selection.author],
    ["parent", selection.parent],
    ["pageCursor", selection.pageCursor],
  ] as const)
    if (Option.isSome(value)) params.set(key, value.value);
  for (const tag of selection.tags) params.append("tag", tag);
  if (selection.tagMatch !== "all") params.set("tagMatch", selection.tagMatch);
  if (selection.order !== "newest") params.set("order", selection.order);
  for (const cursor of previous)
    params.append(
      "previous",
      Option.getOrElse(cursor, () => ""),
    );
  const query = params.toString();
  return query === "" ? "/" : `/?${query}`;
};
export const firstPage = (state: BrowseState): BrowseState => ({
  selection: { ...state.selection, pageCursor: Option.none() },
  previous: [],
});
export const nextPageHref = (state: BrowseState, token: string) => {
  let next: BrowseState = {
    selection: { ...state.selection, pageCursor: Option.some(token) },
    previous: [...state.previous, state.selection.pageCursor].slice(
      -previousPageLimit,
    ),
  };
  // Keep immediate predecessors, trimming oldest hints when the bounded URL fills.
  while (
    next.previous.length > 1 &&
    new TextEncoder().encode(browseHref(next)).length >
      browseUrlByteLimit - 2048
  )
    next = { ...next, previous: next.previous.slice(1) };
  return browseHref(next);
};
export const previousPageHref = (state: BrowseState): Option.Option<string> => {
  const cursor = state.previous.at(-1);
  return cursor === undefined
    ? Option.none()
    : Option.some(
        browseHref({
          selection: { ...state.selection, pageCursor: cursor },
          previous: state.previous.slice(0, -1),
        }),
      );
};
