import { Deferred, Effect } from "effect";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { streamForumPage } from "../src/forum/stream.js";
const request = () => new Request("https://observer.test/?cursor=opaque");
describe("no-script progressive HTML in native workerd", () => {
  it("delivers the loading shell before a delayed result and escapes content through React", async () => {
    const ready = await Effect.runPromise(Deferred.make<boolean>());
    const response = streamForumPage(
      request(),
      Deferred.await(ready).pipe(
        Effect.as(createElement("h1", {}, "<script>untrusted</script>")),
      ),
    );
    expect(response.headers.get("Content-Encoding")).toBe("identity");
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    if (reader === undefined) throw new Error("Missing stream");
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain(
      "Loading forum content",
    );
    await Effect.runPromise(Deferred.succeed(ready, true));
    const second = await reader.read();
    const html = new TextDecoder().decode(second.value);
    expect(html).toContain('class="forum-result"');
    expect(html).toContain("&lt;script&gt;untrusted&lt;/script&gt;");
    expect(html).not.toContain("<script");
    expect((await reader.read()).done).toBe(true);
    reader.releaseLock();
  });
  it("waits for Effect finalizers when the consumer cancels a pending response", async () => {
    const entered = await Effect.runPromise(Deferred.make<boolean>());
    let released = 0;
    const content = Effect.acquireUseRelease(
      Effect.succeed(true),
      () => Deferred.succeed(entered, true).pipe(Effect.zipRight(Effect.never)),
      () =>
        Effect.sync(() => {
          released++;
        }),
    );
    const response = streamForumPage(request(), content);
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("Missing stream");
    await reader.read();
    await Effect.runPromise(Deferred.await(entered));
    await reader.cancel();
    expect(released).toBe(1);
    reader.releaseLock();
  });
  it("closes the response after request-signal interruption and awaits finalization", async () => {
    const entered = await Effect.runPromise(Deferred.make<boolean>());
    const controller = new AbortController();
    let released = 0;
    const content = Effect.acquireUseRelease(
      Effect.succeed(true),
      () => Deferred.succeed(entered, true).pipe(Effect.zipRight(Effect.never)),
      () =>
        Effect.sync(() => {
          released++;
        }),
    );
    const response = streamForumPage(
      new Request("https://observer.test/", { signal: controller.signal }),
      content,
    );
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("Missing stream");
    await reader.read();
    await Effect.runPromise(Deferred.await(entered));
    controller.abort();
    expect((await reader.read()).done).toBe(true);
    expect(released).toBe(1);
    reader.releaseLock();
  });
  it("contains rendering defects without publishing exception details and keeps retry links same-origin", async () => {
    const response = streamForumPage(
      new Request("https://observer.test//evil.test/path"),
      Effect.die(new Error("private-server-details")),
    );
    const html = await response.text();
    expect(html).toContain("Retry this page");
    expect(html).toContain('href="/evil.test/path"');
    expect(html).not.toContain("private-server-details");
    expect(html).not.toContain("<script");
  });
});
