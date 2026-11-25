import { Effect, Option } from "effect";
import {
  browseHref,
  browseUrlByteLimit,
  decodeBrowseState,
  InvalidBrowseState,
} from "./state";
import { browseFormValues, tagControlName } from "./tag-control";

/** Native GET form boundary only. No alias/escape interpretation in public URLs. */
export const nativeBrowseFormHref = (url: URL) => {
  if (!url.searchParams.has(tagControlName))
    return Effect.succeed(Option.none<string>());
  return Effect.gen(function* () {
    yield* Effect.try({
      try: () => decodeURIComponent(url.search),
      catch: () => new InvalidBrowseState(),
    });
    if (
      new TextEncoder().encode(url.href).length > browseUrlByteLimit ||
      [...url.searchParams.keys()].some(
        (key) =>
          ![
            "q",
            "author",
            "parent",
            tagControlName,
            "tagMatch",
            "order",
          ].includes(key),
      )
    )
      return yield* new InvalidBrowseState();
    const target = new URL(url);
    target.search = browseFormValues(url.searchParams).toString();
    const state = yield* decodeBrowseState(target);
    return Option.some(browseHref(state));
  }).pipe(Effect.catchAll(() => Effect.succeed(Option.none<string>())));
};
