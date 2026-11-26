import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  encodeTagControl,
  decodeTagControl,
  browseFormValues,
} from "../apps/forum/app/browsing/tag-control";
import { nativeBrowseFormHref } from "../apps/forum/app/browsing/form.server";
import { changedBrowseHref } from "../apps/forum/app/browsing/read-target";
import {
  decodeBrowseState,
  browseHref,
} from "../apps/forum/app/browsing/state";

const origin = "https://tags.owner.workers.dev";
const tags = [
  "a\nb",
  "a\rb",
  "a\r\nb",
  "a\0b",
  "\\n",
  "\\r",
  "\\0",
  "\\\\",
  "\\unknown",
  "%0A",
  "a\\\n\\r\0b",
  '"<& 😀\t ',
];
describe("lossless form-only Tag notation", () => {
  it("reversibly represents controls, backslashes and literal encoded-looking data", () => {
    for (const tag of tags) {
      const text = encodeTagControl(tag);
      expect(text).not.toMatch(/[\r\n\0]/);
      expect(decodeTagControl(text)).toBe(tag);
    }
    expect(decodeTagControl("\\unknown")).toBe("\\unknown");
    expect(decodeTagControl("%0A")).toBe("%0A");
    for (let value = 0; value < 256; value++) {
      const tag = String.fromCharCode(value) + "\\n\0\r\n";
      expect(decodeTagControl(encodeTagControl(tag))).toBe(tag);
    }
  });
  it("enhanced form values become exact raw public tags and reset cursor/history", async () => {
    const form = new URLSearchParams({
      q: "orchard",
      order: "oldest",
      pageCursor: "obsolete",
      previous: "obsolete",
    });
    for (const tag of tags) form.append("tagText", encodeTagControl(tag));
    const url = new URL(changedBrowseHref(form), origin);
    expect(url.searchParams.getAll("tag")).toEqual(tags);
    expect(url.searchParams.has("tagText")).toBe(false);
    expect(url.searchParams.has("pageCursor")).toBe(false);
    expect(url.searchParams.has("previous")).toBe(false);
    const state = await Effect.runPromise(decodeBrowseState(url));
    expect(state.selection.tags).toEqual(tags);
    expect(
      new URL(browseHref(state), origin).searchParams.getAll("tag"),
    ).toEqual(tags);
  });
  it("native form boundary validates and yields the same raw URL, without public escape aliases", async () => {
    const form = new URLSearchParams({ order: "oldest", tagMatch: "any" });
    for (const tag of tags) form.append("tagText", encodeTagControl(tag));
    const location = await Effect.runPromise(
      nativeBrowseFormHref(new URL("/?" + form.toString(), origin)),
    );
    expect(Option.isSome(location)).toBe(true);
    if (Option.isNone(location)) throw new Error("Expected valid native form");
    expect(new URL(location.value, origin).searchParams.getAll("tag")).toEqual(
      tags,
    );
    for (const tag of tags) {
      const raw = new URL(
        "/?" + new URLSearchParams({ tag }).toString(),
        origin,
      );
      expect(
        Option.isNone(await Effect.runPromise(nativeBrowseFormHref(raw))),
      ).toBe(true);
      expect(
        (await Effect.runPromise(decodeBrowseState(raw))).selection.tags,
      ).toEqual([tag]);
    }
  });
  it("keeps mixed, unknown, duplicate, malformed, over-limit and cursor form states invalid", async () => {
    const bad = [
      "tag=a&tagText=b",
      "tagText=a&unknown=x",
      "tagText=a&order=oldest&order=newest",
      "tagText=%XX",
      "tagText=a&pageCursor=x",
      "tagText=a&previous=",
      "tagText=" + "a".repeat(65536),
      Array.from({ length: 33 }, (_, i) => "tagText=" + String(i)).join("&"),
    ];
    for (const query of bad) {
      const url = new URL("/?" + query, origin);
      expect(
        Option.isNone(await Effect.runPromise(nativeBrowseFormHref(url))),
      ).toBe(true);
      expect(
        await Effect.runPromiseExit(decodeBrowseState(url)),
      ).toHaveProperty("_tag", "Failure");
    }
    const mixed = new URLSearchParams("tag=%5Cn&tagText=x");
    expect(browseFormValues(mixed).get("tag")).toBe("\\n");
    expect(browseFormValues(mixed).has("tagText")).toBe(true);
  });
});
