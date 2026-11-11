import { Deferred, Effect, Fiber, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  ForumRead,
  ForumTransport,
  forumReadLayer,
  maxForumResponseBytes,
} from "../src/forum/retrieval.js";
const config = { API_ORIGIN: "https://api.agentforum.test" };
const result = {
  posts: [],
  page_cursor: null,
  read_cursor: "opaque",
  has_more: false,
};
const search = (
  input: unknown,
  transport: (url: string) => Response,
  bindings: unknown = config,
) =>
  Effect.flatMap(ForumRead, (service) => service.search(input)).pipe(
    Effect.provide(
      forumReadLayer(bindings).pipe(
        Layer.provide(
          Layer.succeed(ForumTransport, {
            get: (url) => Effect.sync(() => transport(url)),
          }),
        ),
      ),
    ),
  );
describe("observer shared reader in workerd (injected HTTP transport contract)", () => {
  it("uses the API's exact model with an encoded public search request and nullable cursor decoding", async () => {
    expect(navigator.userAgent).toContain("Cloudflare-Workers");
    const seen: URL[] = [];
    const value = await Effect.runPromise(
      search({}, (url) => {
        seen.push(new URL(url));
        return Response.json(result);
      }),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.origin).toBe(config.API_ORIGIN);
    expect(seen[0]?.pathname).toBe("/v1/search");
    expect(seen[0]?.searchParams.get("payload")).toBe('{"limit":20}');
    expect(value.posts).toEqual([]);
    expect(Option.isNone(value.page_cursor)).toBe(true);
    expect(value.read_cursor).toBe("opaque");
  });
  it("rejects unknown/mutating input and invalid trusted origins before transport I/O", async () => {
    let calls = 0;
    const transport = () => {
      calls++;
      return Response.json(result);
    };
    for (const input of [
      { body: "must not publish" },
      { cursor: "a", read_cursor: "b" },
      { limit: 51 },
    ])
      expect(
        await Effect.runPromise(Effect.either(search(input, transport))),
      ).toMatchObject({ _tag: "Left", left: { kind: "invalid-request" } });
    for (const API_ORIGIN of [
      "javascript:alert(1)",
      "https://user:secret@api.agentforum.test",
      "https://api.agentforum.test/path",
      "https://api.agentforum.test?query=private",
    ])
      expect(
        await Effect.runPromise(
          Effect.either(search({}, transport, { API_ORIGIN })),
        ),
      ).toMatchObject({ _tag: "Left", left: { kind: "configuration" } });
    expect(calls).toBe(0);
  });
  it("contains status/media/schema failures without reading or publishing dependency details", async () => {
    for (const [status, kind] of [
      [400, "invalid-request"],
      [404, "not-found"],
      [500, "unavailable"],
    ] as const) {
      const value = await Effect.runPromise(
        Effect.either(
          search(
            {},
            () => new Response("private-provider-details", { status }),
          ),
        ),
      );
      expect(value).toMatchObject({ _tag: "Left", left: { kind } });
      expect(JSON.stringify(value)).not.toContain("private-provider-details");
    }
    for (const response of [
      new Response("private-markup"),
      Response.json({ invalid: true }),
      new Response("{", { headers: { "Content-Type": "application/json" } }),
    ])
      expect(
        await Effect.runPromise(Effect.either(search({}, () => response))),
      ).toMatchObject({ _tag: "Left", left: { kind: "invalid-response" } });
  });
  it("bounds actual bytes despite a dishonest Content-Length and closes the stream", async () => {
    let cancelled = 0;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(maxForumResponseBytes + 1));
      },
      cancel() {
        cancelled++;
      },
    });
    const value = await Effect.runPromise(
      Effect.either(
        search(
          {},
          () =>
            new Response(body, {
              headers: {
                "Content-Type": "application/json",
                "Content-Length": "1",
              },
            }),
        ),
      ),
    );
    expect(value).toMatchObject({
      _tag: "Left",
      left: { kind: "invalid-response" },
    });
    expect(cancelled).toBe(1);
    expect(body.locked).toBe(false);
  });
  it("awaits owned reader cancellation and releases its lock on interruption during a stalled read", async () => {
    const entered = await Effect.runPromise(Deferred.make<boolean>());
    let cancelled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull() {
        Effect.runSync(Deferred.succeed(entered, true));
      },
      cancel() {
        cancelled++;
      },
    });
    const fiber = Effect.runFork(
      search(
        {},
        () =>
          new Response(body, {
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );
    await Effect.runPromise(Deferred.await(entered));
    // Pull can be scheduled before the reader is acquired. Yield until the
    // real response stream is locked, rather than cancelling an unstarted test.
    await Effect.runPromise(Effect.yieldNow());
    expect(body.locked).toBe(true);
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(cancelled).toBe(1);
    expect(body.locked).toBe(false);
  });
});
