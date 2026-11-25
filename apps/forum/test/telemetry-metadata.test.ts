import { Option } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  makeDiagnosticWriter,
  requestDiagnostics,
  sanitizeDiagnosticMetadata,
  writeDiagnostic,
  type SafeDiagnostic,
} from "../src/telemetry/diagnostics.js";

const revision = "f61b76772008b5bed1b2a04b7dadd2ece47c0476";
const id = "01234567-89ab-4cde-8fab-0123456789ab";
const base: SafeDiagnostic = {
  "service.name": "agentforum",
  "event.name": "operation.completed",
  "api.version": "v1",
  "http.route": "/v1/search",
  "http.request.method": "GET",
  "http.response.status_code": 200,
  "request.id": id,
  "operation.name": "query",
  "error.type": "none",
  "dependency.category": "none",
  "duration.ms": 0,
};
const secret = "SENSITIVE-not-a-release-or-environment";
const hostile = {
  ...base,
  "deployment.environment.name": secret,
  "service.version": secret,
  environment: secret,
  revision: secret,
  body: secret,
};
afterEach(() => vi.restoreAllMocks());
const capture = () =>
  vi.spyOn(console, "info").mockImplementation(() => undefined);

describe("inactive bounded diagnostic metadata in workerd", () => {
  it("keeps default and explicit NONE output byte-equivalent to the base allowlist", () => {
    expect(navigator.userAgent).toContain("Cloudflare-Workers");
    const log = capture();
    writeDiagnostic(hostile);
    makeDiagnosticWriter()(hostile);
    makeDiagnosticWriter(Option.none())(hostile);
    expect(log.mock.calls).toEqual(
      Array.from({ length: 3 }, () => [JSON.stringify(base)]),
    );
  });
  for (const environment of [
    "local",
    "preview",
    "staging",
    "production",
  ] as const) {
    it(`captures the exact ${environment} pair after base sanitization`, () => {
      const log = capture();
      const metadata = sanitizeDiagnosticMetadata({ environment, revision });
      expect(metadata).toEqual(Option.some({ environment, revision }));
      if (Option.isSome(metadata))
        expect(Object.isFrozen(metadata.value)).toBe(true);
      makeDiagnosticWriter(metadata)(hostile);
      expect(log).toHaveBeenCalledExactlyOnceWith(
        JSON.stringify({
          ...base,
          "deployment.environment.name": environment,
          "service.version": revision,
        }),
      );
      expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
    });
  }
  const invalid: readonly { readonly name: string; readonly input: unknown }[] =
    [
      { name: "missing", input: undefined },
      { name: "null", input: null },
      { name: "empty", input: {} },
      { name: "only environment", input: { environment: "production" } },
      { name: "only revision", input: { revision } },
      {
        name: "undefined half",
        input: { environment: "local", revision: undefined },
      },
      { name: "null half", input: { environment: null, revision } },
      { name: "unknown environment", input: { environment: secret, revision } },
      {
        name: "uppercase environment",
        input: { environment: "PRODUCTION", revision },
      },
      {
        name: "whitespace environment",
        input: { environment: " local", revision },
      },
      { name: "numeric environment", input: { environment: 1, revision } },
      {
        name: "numeric revision",
        input: { environment: "local", revision: 1 },
      },
      {
        name: "uppercase revision",
        input: { environment: "local", revision: revision.toUpperCase() },
      },
      {
        name: "short revision",
        input: { environment: "local", revision: revision.slice(1) },
      },
      {
        name: "long revision",
        input: { environment: "local", revision: revision + "a" },
      },
      {
        name: "nonhex revision",
        input: { environment: "local", revision: "z".repeat(40) },
      },
      {
        name: "whitespace revision",
        input: { environment: "local", revision: revision + " " },
      },
      {
        name: "newline revision",
        input: { environment: "local", revision: revision + "\n" },
      },
      {
        name: "NUL revision",
        input: { environment: "local", revision: revision + "\0" },
      },
      {
        name: "oversized revision",
        input: { environment: "local", revision: "a".repeat(10_000) },
      },
      {
        name: "excess property",
        input: { environment: "local", revision, authorized: true },
      },
      { name: "array", input: [{ environment: "local", revision }] },
      {
        name: "arbitrary JSON string",
        input: JSON.stringify({ environment: "local", revision }),
      },
    ];
  for (const fixture of invalid) {
    it(`omits both malformed metadata fields but retains the base: ${fixture.name}`, () => {
      const log = capture();
      const metadata = sanitizeDiagnosticMetadata(fixture.input);
      expect(Option.isNone(metadata)).toBe(true);
      makeDiagnosticWriter(metadata)(hostile);
      expect(log).toHaveBeenCalledExactlyOnceWith(JSON.stringify(base));
    });
  }
  it("revalidates structurally typed metadata at writer construction", () => {
    const log = capture();
    makeDiagnosticWriter(
      Option.some({ environment: "local", revision: secret }),
    )(hostile);
    const extra = { environment: "local", revision, authorized: true } as const;
    makeDiagnosticWriter(Option.some(extra))(hostile);
    expect(log.mock.calls).toEqual([
      [JSON.stringify(base)],
      [JSON.stringify(base)],
    ]);
  });
  it("snapshots caller metadata and does not retain mutable input", () => {
    const log = capture();
    const input: { environment: "local" | "production"; revision: string } = {
      environment: "local",
      revision,
    };
    const decoded = sanitizeDiagnosticMetadata(input);
    const writer = makeDiagnosticWriter(Option.some(input));
    input.environment = "production";
    input.revision = "0".repeat(40);
    expect(decoded).toEqual(Option.some({ environment: "local", revision }));
    writer(base);
    expect(log).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({
        ...base,
        "deployment.environment.name": "local",
        "service.version": revision,
      }),
    );
  });
  it("still rejects an invalid base even when metadata is valid", () => {
    const log = capture();
    const writer = makeDiagnosticWriter(
      sanitizeDiagnosticMetadata({ environment: "local", revision }),
    );
    writer({ ...base, "request.id": secret });
    writer({ ...base, "duration.ms": 300_001 });
    writer({ ...base, "http.response.status_code": 600 });
    expect(log).not.toHaveBeenCalled();
  });
  it("keeps request completion once-only and ignores hostile request metadata", () => {
    const log = capture();
    vi.spyOn(performance, "now").mockReturnValue(0);
    const writer = makeDiagnosticWriter(
      sanitizeDiagnosticMetadata({ environment: "staging", revision }),
    );
    const complete = requestDiagnostics(
      new Request(`https://${secret}.example/v1/search?q=${secret}`, {
        headers: {
          "deployment.environment.name": secret,
          "service.version": secret,
          "X-Release": secret,
          Authorization: secret,
          Cookie: secret,
        },
      }),
      id,
      writer,
    );
    complete(200);
    complete(500);
    expect(log).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({
        ...base,
        "deployment.environment.name": "staging",
        "service.version": revision,
      }),
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
  });
  it("keeps default request diagnostics inactive and byte-equivalent", () => {
    const log = capture();
    vi.spyOn(performance, "now").mockReturnValue(0);
    requestDiagnostics(
      new Request("https://example.com/v1/search", {
        headers: { "X-Environment": "production", "X-Revision": revision },
      }),
      id,
    )(200);
    expect(log).toHaveBeenCalledExactlyOnceWith(JSON.stringify(base));
  });
  it("contains sink failures with valid metadata", () => {
    vi.spyOn(console, "info").mockImplementation(() => {
      throw new Error(secret);
    });
    const writer = makeDiagnosticWriter(
      sanitizeDiagnosticMetadata({ environment: "preview", revision }),
    );
    expect(() => {
      writer(base);
    }).not.toThrow();
    expect(() => {
      requestDiagnostics(new Request("https://example.com/"), id, writer)(200);
    }).not.toThrow();
  });
});
