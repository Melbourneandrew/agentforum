import {
  Context,
  Data,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Option,
  Redacted,
  Schema,
} from "effect";
import { describe, expect, it } from "vitest";
import { InputFailure, parseInputJson, utf8Size } from "../src/input/json.js";
import {
  bearerCredential,
  InputProblem,
  inputTransportLayer,
  InputTransport,
  PublicationInput,
  runOperation,
} from "../src/input/transport.js";

const url = "https://api.agentforum.test/v1/publish";
const post = (text: string, headers: Record<string, string> = {}) =>
  new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: text,
  });
const get = (text: string) =>
  new Request(`${url}?payload=${encodeURIComponent(text)}`);
const decode = (request: Request) =>
  Effect.runPromise(
    Effect.flatMap(InputTransport, (service) =>
      service.decode(request, "publish", PublicationInput),
    ).pipe(Effect.provide(inputTransportLayer), Effect.either),
  );
const reject = async (request: Request, reason = "invalid") => {
  const result = await decode(request);
  expect(result._tag).toBe("Left");
  if (result._tag === "Left") expect(result.left.reason).toBe(reason);
};
const metadataAt = (bytes: number) => {
  const object = {
    a: "x".repeat(4000),
    b: "x".repeat(4000),
    c: "x".repeat(4000),
    d: "x".repeat(4000),
    e: "",
  };
  object.e = "x".repeat(bytes - utf8Size(JSON.stringify(object)));
  return JSON.stringify(object);
};

describe("shared business input boundary in actual workerd", () => {
  it("runs native Worker primitives and preserves the same decoded document across transports", async () => {
    expect(navigator.userAgent).toContain("Cloudflare-Workers");
    const text =
      '{"body":"# raw\\n😀 + %26","metadata":{"type":1,"nested":[{"a":true,"b":null}],"__proto__":{"safe":true}},"reply_to":"abcdefghijklmnopqrstu"}';
    const a = await decode(post(text));
    const b = await decode(get(text));
    expect(a._tag).toBe("Right");
    expect(b).toEqual(a);
    if (a._tag === "Right")
      expect(a.right.metadata).toHaveProperty("__proto__");
    expect(Object.hasOwn({}, "safe")).toBe(false);
  });
  it("enforces exact full encoded URL boundary before query decoding", async () => {
    const base = `${url}?payload=${encodeURIComponent('{"body":""}')}`;
    const exact = `${url}?payload=${encodeURIComponent(JSON.stringify({ body: "x".repeat(14_336 - utf8Size(base)) }))}`;
    expect(utf8Size(exact)).toBe(14_336);
    expect((await decode(new Request(exact)))._tag).toBe("Right");
    await reject(new Request(exact + "x"), "encoding");
  });
  it("counts raw client JSON whitespace and escapes before server attributes or normalization", async () => {
    const text = JSON.stringify({
      body: "x".repeat(65_536 - utf8Size(JSON.stringify({ body: "" }))),
    });
    expect(utf8Size(text)).toBe(65_536);
    expect((await decode(post(text)))._tag).toBe("Right");
    await reject(post(text + " "), "payload");
    const escaped = '{"body":"' + "\\u0061".repeat(11_000) + '"}';
    await reject(post(escaped), "payload");
  });
  it("counts exact lexical metadata object bytes including whitespace", async () => {
    for (const bytes of [16_384, 16_385]) {
      const metadata = metadataAt(bytes);
      expect(utf8Size(metadata)).toBe(bytes);
      const request = post(`{"body":"ok","metadata":${metadata}}`);
      if (bytes === 16_384) expect((await decode(request))._tag).toBe("Right");
      else await reject(request, "metadata");
    }
    const lexical = metadataAt(16_384).replace('"a":', '"a": ');
    await reject(post(`{"body":"ok","metadata":${lexical}}`), "metadata");
  });
  it("counts UTF-8 bytes rather than UTF-16 code units", async () => {
    const text = JSON.stringify({ body: "😀".repeat(16_381) });
    expect(utf8Size(text)).toBe(65_535);
    expect((await decode(post(text)))._tag).toBe("Right");
    await reject(post(text.replace('"}', 'xx"}')), "payload");
  });
  it.each([
    '{"body":"a","body":"b"}',
    '{"body":"a","metadata":{"a":1,"\\u0061":2}}',
    '{"body":"a","metadata":{"nested":{"x":1,"x":2}}}',
    '{"body":"a",}',
    '{"body":"a"}null',
    '{"body":"a","metadata":[]}',
    '{"body":"\\ud800"}',
    '{"body":"\\udc00"}',
    '{"body":"\\u0000"}',
    '{"body":"x","metadata":{"\\u0000":1}}',
    '{"body":"x","metadata":{"n":1e400}}',
    '{"body":"x","metadata":{"n":1e-400}}',
    '{"body":"x","metadata":{"n":9007199254740993}}',
    '{"body":"x","metadata":{"n":0.10000000000000001}}',
    '{"body":"x","metadata":{"n":01}}',
    '{"body":"x","metadata":{"n":NaN}}',
    '{"body":"x","api_key":"secret"}',
    '{"body":""}',
    "{}",
    "[]",
  ])(
    "rejects malformed/ambiguous/incompatible JSON without reflecting it: %s",
    async (text) => {
      for (const request of [post(text), get(text)]) await reject(request);
    },
  );
  it("accepts equivalent representable JSON numeric spellings and arbitrary conventional fields", async () => {
    const text =
      '{"body":"---\\ntype: ordinary Markdown","metadata":{"a":1.0,"b":1e0,"c":0.1,"d":1e-3,"e":null,"tags":[true,"x"],"custom.name":false}}';
    const result = await decode(post(text));
    expect(result._tag).toBe("Right");
    if (result._tag === "Right") {
      expect(result.right.metadata).toMatchObject({
        a: 1,
        b: 1,
        c: 0.1,
        d: 0.001,
      });
      expect(result.right.metadata).not.toHaveProperty("type");
    }
  });
  it("enforces metadata depth, collection, node, key and scalar budgets", async () => {
    const check = async (metadata: unknown, ok: boolean) => {
      const request = post(JSON.stringify({ body: "x", metadata }));
      if (ok) expect((await decode(request))._tag).toBe("Right");
      else await reject(request);
    };
    const nested = (depth: number): unknown =>
      depth === 1 ? {} : { child: nested(depth - 1) };
    await check(nested(8), true);
    await check(nested(9), false);
    await check({ a: Array.from({ length: 64 }, () => 1) }, true);
    await check({ a: Array.from({ length: 65 }, () => 1) }, false);
    await check(
      Object.fromEntries(Array.from({ length: 64 }, (_, i) => [String(i), i])),
      true,
    );
    await check(
      Object.fromEntries(Array.from({ length: 65 }, (_, i) => [String(i), i])),
      false,
    );
    await check({ ["x".repeat(128)]: 1 }, true);
    await check({ ["x".repeat(129)]: 1 }, false);
    await check({ x: "😀".repeat(1024) }, true);
    await check({ x: "😀".repeat(1025) }, false);
    await check(
      {
        a: Array(64).fill(1),
        b: Array(64).fill(1),
        c: Array(64).fill(1),
        d: Array(59).fill(1),
      },
      true,
    );
    await check(
      {
        a: Array(64).fill(1),
        b: Array(64).fill(1),
        c: Array(64).fill(1),
        d: Array(60).fill(1),
      },
      false,
    );
  });
  it.each([
    "payload=%FF",
    "payload=%",
    "payload=%C0%AF",
    "payload=%ED%A0%80",
    "payload=%257B%257D",
    "payload=%7B%7D&payload=%7B%7D",
    "payload=%7B%7D&api_key=secret",
    "api_key=secret",
    "payload=%7B%7D&",
    "payload",
  ])("strictly decodes once and rejects query ambiguity: %s", async (query) => {
    await reject(new Request(`${url}?${query}`));
  });
  it("rejects invalid UTF-8, BOM and unsupported media/encoding before the callback", async () => {
    await reject(
      new Request(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: new Uint8Array([123, 255, 125]),
      }),
    );
    await reject(post('\uFEFF{"body":"x"}'));
    await reject(
      post('{"body":"x"}', { "Content-Type": "text/plain" }),
      "media",
    );
    await reject(post('{"body":"x"}', { "Content-Encoding": "gzip" }), "media");
    await reject(
      new Request(`${url}?api_key=secret`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: '{"body":"x"}',
      }),
    );
  });
  it("uses header-only redacted Bearer credentials, rejecting malformed headers", async () => {
    expect(
      await Effect.runPromise(bearerCredential(get('{"body":"x"}'))),
    ).toEqual(Option.none());
    const request = new Request(url, {
      headers: { Authorization: "Bearer test-key_secret" },
    });
    const key = await Effect.runPromise(bearerCredential(request));
    expect(Option.map(key, Redacted.value)).toEqual(
      Option.some("test-key_secret"),
    );
    expect(String(key)).not.toContain("test-key_secret");
    await reject(
      post('{"body":"x"}', { Authorization: "Bearer secret, Bearer other" }),
    );
  });
  it("bounds chunked bodies, cancels and unlocks the reader on failure", async () => {
    let canceled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(32_768).fill(32));
      },
      cancel() {
        canceled++;
      },
    });
    await reject(
      new Request(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: stream,
      }),
      "payload",
    );
    expect(canceled).toBe(1);
    expect(stream.locked).toBe(false);
  });
  it("cancels a stalled reader on Effect interruption and on request abort", async () => {
    for (const mode of ["fiber", "request"]) {
      const started = await Effect.runPromise(Deferred.make<undefined>());
      let canceled = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull() {
          Effect.runSync(Deferred.succeed(started, undefined));
        },
        cancel() {
          canceled++;
        },
      });
      const controller = new AbortController();
      const request = new Request(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: stream,
        signal: controller.signal,
      });
      await Effect.runPromise(
        Effect.gen(function* () {
          const transport = yield* InputTransport;
          const fiber = yield* Effect.fork(
            transport
              .decode(request, "publish", PublicationInput)
              .pipe(Effect.either),
          );
          yield* Deferred.await(started);
          yield* Effect.yieldNow();
          if (mode === "request") {
            controller.abort();
            yield* Fiber.join(fiber);
          } else yield* Fiber.interrupt(fiber);
        }).pipe(Effect.provide(inputTransportLayer)),
      );
      expect(canceled).toBe(1);
      expect(stream.locked).toBe(false);
    }
  });
  it("the common adapter never acquires the transport or invokes operations for HEAD/OPTIONS", async () => {
    let acquired = 0;
    let calls = 0;
    const layer = Layer.sync(InputTransport, () => {
      acquired++;
      return { decode: () => Effect.die("must not decode") };
    });
    for (const method of ["HEAD", "OPTIONS"]) {
      const response = await Effect.runPromise(
        runOperation(
          new Request(url, { method }),
          "publish",
          PublicationInput,
          "test",
          () => {
            calls++;
            return Effect.succeed(Response.json({ ok: true }));
          },
          layer,
        ),
      );
      expect(response.status).toBe(method === "HEAD" ? 200 : 204);
      expect(await response.text()).toBe("");
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
      expect(response.headers.get("Cache-Control")).toBe("no-store, private");
    }
    expect(acquired).toBe(0);
    expect(calls).toBe(0);
  });
  it("the fixture callback executes once only for validated GET/POST; safe errors use declared schemas", async () => {
    let calls = 0;
    const execute = (request: Request) =>
      Effect.runPromise(
        runOperation(
          request,
          "publish",
          PublicationInput,
          "fixed-id",
          (input) => {
            calls++;
            return Effect.succeed(Response.json({ body: input.body }));
          },
        ).pipe(Effect.provide(inputTransportLayer)),
      );
    for (const request of [post('{"body":"ok"}'), get('{"body":"ok"}')]) {
      const response = await execute(request);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ body: "ok" });
    }
    for (const request of [
      post('{"body":"secret","unknown":"secret"}'),
      new Request(url, { method: "PUT" }),
      new Request(url + "?payload=" + "x".repeat(14_336)),
    ]) {
      const response = await execute(request);
      expect(response.headers.get("Content-Type")).toBe(
        "application/problem+json",
      );
      const text = await response.text();
      expect(text).not.toContain("secret");
      const error = Schema.decodeUnknownSync(Schema.parseJson(InputProblem))(
        text,
      );
      expect(error.instance).toBe("urn:uuid:fixed-id");
      expect(error.canonical).toBe("/v1/publish");
      if (error.status === 405)
        expect(response.headers.get("Allow")).toContain("POST");
      if (error.status === 413) expect(error.limit).toBe(14_336);
    }
    expect(calls).toBe(2);
  });
  it("preserves endpoint-specific typed failures and caller services without rerunning handlers", async () => {
    class DomainFailure extends Data.TaggedError("DomainFailure") {}
    const failure = new DomainFailure();
    let calls = 0;
    const result = await Effect.runPromise(
      runOperation(
        post('{"body":"x"}'),
        "publish",
        PublicationInput,
        "id",
        () => {
          calls++;
          return Effect.fail(failure);
        },
      ).pipe(Effect.either),
    );
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") expect(result.left).toBe(failure);
    expect(calls).toBe(1);
    const State = Context.GenericTag<string>("fixture-state");
    const response = await Effect.runPromise(
      runOperation(get('{"body":"x"}'), "publish", PublicationInput, "id", () =>
        Effect.map(State, (state) => Response.json({ state })),
      ).pipe(Effect.provideService(State, "same-context")),
    );
    expect(await response.json()).toEqual({ state: "same-context" });
  });
  it("decodes split multibyte UTF-8 incrementally and releases a successful stream", async () => {
    const bytes = new TextEncoder().encode(
      '{"body":"😀","metadata":{"constructor":1,"__proto__":{"nested":true}}}',
    );
    let offset = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset === bytes.length) controller.close();
        else controller.enqueue(bytes.slice(offset, ++offset));
      },
    });
    const result = await decode(
      new Request(url, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=UTF-8" },
        body: stream,
      }),
    );
    expect(result._tag).toBe("Right");
    if (result._tag === "Right") {
      expect(result.right.body).toBe("😀");
      expect(Object.hasOwn(result.right.metadata ?? {}, "__proto__")).toBe(
        true,
      );
    }
    expect(stream.locked).toBe(false);
  });
  it("the parser has a typed safe failure channel even for synthetic invalid UTF-16 source", async () => {
    const result = await Effect.runPromise(
      parseInputJson('{"body":"\ud800"}', true).pipe(Effect.either),
    );
    expect(result._tag).toBe("Left");
    if (result._tag === "Left")
      expect(result.left).toBeInstanceOf(InputFailure);
  });
});
