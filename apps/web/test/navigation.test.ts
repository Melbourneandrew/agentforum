import { PostRecord, SearchInput } from "@agentforum/contracts";
import { Effect, Layer, Option, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  feedHref,
  locatePrevious,
  previousScanBatch,
} from "../src/forum/navigation.js";
import { ForumRead } from "../src/forum/retrieval.js";
const id = (order: number) => "p" + String(order).padStart(20, "0");
const fixture = (count: number) => {
  const calls: unknown[] = [];
  const posts: Schema.Schema.Type<typeof PostRecord>[] = Array.from(
    { length: count },
    (_, index) => ({
      id: id(count - index),
      author_id: "00000000-0000-4000-8000-000000000001",
      author_name: "FixtureAgent",
      body: "Synthetic navigation algorithm fixture",
      metadata: {},
      reply_to_id: Option.none(),
      publication_order: String(count - index),
      published_at: "2026-11-11T00:00:00.000Z",
    }),
  );
  const layer = Layer.succeed(ForumRead, {
    search: (input) =>
      Schema.decodeUnknown(SearchInput)(input).pipe(
        Effect.orDie,
        Effect.map((query) => {
          calls.push(query);
          const cursor = query.cursor ?? query.read_cursor;
          const boundary =
            cursor === undefined ? count + 1 : Number(cursor.split("-")[1]);
          const ascending = query.read_cursor !== undefined;
          const selected = posts.filter((post) =>
            ascending
              ? Number(post.publication_order) > boundary
              : Number(post.publication_order) < boundary,
          );
          if (ascending) selected.reverse();
          const page = selected.slice(0, query.limit);
          const last = page[page.length - 1];
          return {
            posts: page,
            // Freshly signed token representation differs from original input.
            page_cursor:
              selected.length > query.limit && last !== undefined && !ascending
                ? Option.some("rotated-" + last.publication_order)
                : Option.none<string>(),
            read_cursor:
              "read-" +
              ((ascending
                ? last?.publication_order
                : page[0]?.publication_order) ?? "0"),
            has_more: selected.length > query.limit,
          };
        }),
      ),
  });
  return { calls, layer, posts };
};
describe("Previous navigation algorithm in workerd (injected reader, not API integration)", () => {
  it("returns the fresh first feed from page two and preserves the reply selection", async () => {
    const test = fixture(65);
    const value = await Effect.runPromise(
      locatePrevious({
        reply_to: id(1),
        anchor: "old-46",
        cursor: "old-46",
        scan: "old-46",
      }).pipe(Effect.provide(test.layer)),
    );
    expect(value).toBe("/?reply_to=" + id(1));
    expect(test.calls).toHaveLength(3);
    expect(
      test.calls.every(
        (call) =>
          typeof call === "object" &&
          call !== null &&
          "reply_to" in call &&
          call.reply_to === id(1),
      ),
    ).toBe(true);
  });
  it("locates the exact prior keyset without comparing signatures or assuming global offsets", async () => {
    const test = fixture(65);
    const value = await Effect.runPromise(
      locatePrevious({
        anchor: "old-46",
        cursor: "old-6",
        scan: "old-46",
      }).pipe(Effect.provide(test.layer)),
    );
    expect(value).toBe("/?anchor=old-46&cursor=rotated-26");
    expect(test.calls).toHaveLength(4);
    // New Posts above the retained anchor do not shift this prior page.
    const concurrent = fixture(72);
    expect(
      await Effect.runPromise(
        locatePrevious({
          anchor: "old-46",
          cursor: "old-6",
          scan: "old-46",
        }).pipe(Effect.provide(concurrent.layer)),
      ),
    ).toBe(value);
  });
  it("caps each replay and continues with only three cursors at arbitrary depth", async () => {
    const test = fixture(1000);
    let state = { anchor: "old-981", cursor: "old-21", scan: "old-981" };
    let rounds = 0;
    for (;;) {
      const before = test.calls.length;
      const value = await Effect.runPromise(
        locatePrevious(state).pipe(Effect.provide(test.layer)),
      );
      expect(test.calls.length - before).toBeLessThanOrEqual(
        previousScanBatch + 2,
      );
      const url = new URL(value, "https://observer.test");
      expect([...url.searchParams.keys()].length).toBeLessThanOrEqual(3);
      const scan = url.searchParams.get("scan");
      rounds++;
      if (scan === null) {
        expect(url.searchParams.get("cursor")).toBe("rotated-41");
        break;
      }
      state = { ...state, scan };
      expect(rounds).toBeLessThan(10);
    }
    expect(rounds).toBe(3);
  });
  it("rejects missing state, exhausted scans and non-aligned valid keysets", async () => {
    for (const query of [
      {},
      { anchor: "old-46", cursor: "old-6", scan: "old-5" },
      { anchor: "old-46", cursor: "old-9", scan: "old-46" },
    ]) {
      const test = fixture(65);
      expect(
        await Effect.runPromise(
          Effect.either(locatePrevious(query).pipe(Effect.provide(test.layer))),
        ),
      ).toMatchObject({ _tag: "Left", left: { kind: "invalid-request" } });
    }
  });
  it("builds only same-origin fixed-field URLs", () => {
    expect(feedHref({})).toBe("/");
    expect(
      feedHref({ reply_to: id(1), anchor: "a", cursor: "b", scan: "c" }),
    ).toBe("/?reply_to=" + id(1) + "&anchor=a&cursor=b&scan=c");
  });
});
