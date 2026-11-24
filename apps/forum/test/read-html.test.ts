import { describe, expect, it, vi } from "vitest";
import { readHtml } from "../app/browsing/read-html";

const current = new URL("https://forum.test/");
const controller = () => new AbortController();
const html = (value = "<main>Complete SSR page</main>", status = 200) =>
  new Response(value, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
describe("bounded HTML transport — controlled Response unit evidence, not enabled UI acceptance", () => {
  it("performs only a credential-free, nonredirecting, uncached same-origin HTML GET", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(html());
    expect(
      await readHtml(current, current, controller().signal, { request }),
    ).toEqual({ html: "<main>Complete SSR page</main>", status: 200 });
    expect(request).toHaveBeenCalledExactlyOnceWith(
      current.href,
      expect.objectContaining({
        method: "GET",
        mode: "same-origin",
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        headers: { Accept: "text/html" },
      }),
    );
  });
  it("retains complete authoritative400/404/500/503 bodies and status, not empty success", async () => {
    for (const status of [400, 404, 500, 503]) {
      const request = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          html("<main>Safe server error with retry</main>", status),
        );
      expect(
        await readHtml(current, current, controller().signal, { request }),
      ).toEqual({ html: "<main>Safe server error with retry</main>", status });
    }
  });
  it("rejects API/mutation/docs/external/credentials/fragments before requesting", async () => {
    const request = vi.fn<typeof fetch>();
    for (const value of [
      "/v1/search",
      "/v1/publish",
      "/docs/",
      "https://evil.test/",
      "https://user:pass@forum.test/",
      "/#fragment",
    ])
      await expect(
        readHtml(new URL(value, current), current, controller().signal, {
          request,
        }),
      ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it("refuses redirects, unsupported statuses and non-HTML representations", async () => {
    for (const response of [
      Response.redirect(current, 302),
      new Response("json", { headers: { "Content-Type": "application/json" } }),
      html("Unauthorized", 401),
      html("Limited", 429),
    ])
      await expect(
        readHtml(current, current, controller().signal, {
          request: vi.fn<typeof fetch>().mockResolvedValue(response),
        }),
      ).rejects.toThrow();
  });
  it("enforces actual streaming bytes without trusting Content-Length and cancels overflow", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(new TextEncoder().encode("ééé"));
      },
      cancel,
    });
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(body, { headers: { "Content-Type": "text/html" } }),
      );
    await expect(
      readHtml(current, current, controller().signal, {
        request,
        maximumBytes: 5,
      }),
    ).rejects.toThrow();
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it("rejects declared oversized bodies and malformed UTF8 rather than partial content", async () => {
    for (const response of [
      new Response("<main/>", {
        headers: { "Content-Type": "text/html", "Content-Length": "999" },
      }),
      new Response(new Uint8Array([0xc0, 0xaf]), {
        headers: { "Content-Type": "text/html" },
      }),
    ])
      await expect(
        readHtml(current, current, controller().signal, {
          request: vi.fn<typeof fetch>().mockResolvedValue(response),
          maximumBytes: 20,
        }),
      ).rejects.toThrow();
  });
  it("losslessly decodes split multi-byte UTF8, and rejects an interrupted or empty read", async () => {
    const bytes = new TextEncoder().encode("🌱");
    const stream = new ReadableStream<Uint8Array>({
      start(value) {
        value.enqueue(bytes.slice(0, 2));
        value.enqueue(bytes.slice(2));
        value.close();
      },
    });
    expect(
      (
        await readHtml(current, current, controller().signal, {
          request: vi.fn<typeof fetch>().mockResolvedValue(
            new Response(stream, {
              headers: { "Content-Type": "text/html" },
            }),
          ),
        })
      ).html,
    ).toBe("🌱");
    await expect(
      readHtml(current, current, controller().signal, {
        request: vi.fn<typeof fetch>().mockResolvedValue(html("")),
      }),
    ).rejects.toThrow();
    const interrupted = controller();
    interrupted.abort();
    const request = vi.fn<typeof fetch>();
    await expect(
      readHtml(current, current, interrupted.signal, { request }),
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
});
