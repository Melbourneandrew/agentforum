import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Effect, Either, Option, Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { command } from "./cli.js";
import { withIdentityFile } from "./identity-file.js";
import { Journal, Request, failure, recovery } from "./model.js";
import { cloudflare } from "./provider.js";
import { IdentityStore } from "./provision.js";

// Deliberately fake provider identities. All provider traffic uses the injected
// transport below; no account lookup, token discovery or live API is performed.
const account = "a".repeat(32);
const databaseId = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";
const request: Request = {
  accountId: account,
  workerName: "fixture-forum",
  databaseName: "fixture-forum-data",
  storage: { mode: "create" },
};
const database = { uuid: databaseId, name: request.databaseName };
const root = resolve(import.meta.dirname, "../..");
const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0))
    rmSync(path, { recursive: true, force: true });
  vi.unstubAllGlobals();
});
const directory = () => {
  const path = mkdtempSync(join(tmpdir(), "forum-delivery-"));
  temporary.push(path);
  return path;
};
interface Reply {
  readonly method: string;
  readonly path: string;
  readonly status?: number;
  readonly result?: unknown;
  readonly raw?: unknown;
  readonly throws?: boolean;
  readonly text?: string;
  readonly after?: () => void;
}
const subdomain: Reply = {
  method: "GET",
  path: "/workers/subdomain",
  result: { subdomain: "fixture-owner" },
};
const missingWorker: Reply = {
  method: "GET",
  path: `/workers/scripts/${request.workerName}/settings`,
  status: 404,
};
const create: Reply = {
  method: "POST",
  path: "/d1/database",
  result: database,
};
const lookup: Reply = {
  method: "GET",
  path: `/d1/database/${databaseId}`,
  result: database,
};
const authorized = [
  "provision",
  "--request",
  "fixture.json",
  "--allow-provider",
  "--source-authorized",
  "--confirm",
];
const fixture = (
  replies: readonly Reply[],
  input: unknown = request,
  savedPath?: string,
) => {
  const path = savedPath ?? join(directory(), "identity.json");
  const pending = [...replies];
  const output: string[] = [];
  // A stray global fetch would fail; only explicit fixture adapters are usable.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("live transport forbidden");
    }),
  );
  const transport = vi.fn<typeof fetch>(async (url, init) => {
    const address =
      typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    const reply = pending.shift();
    expect(reply, `unexpected provider call ${address}`).toBeDefined();
    if (!reply) throw new Error("unexpected call");
    expect(address).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${account}${reply.path}`,
    );
    expect(init?.method).toBe(reply.method);
    expect(init?.redirect).toBe("error");
    expect(init?.headers).toEqual({
      Authorization: "Bearer fixture-only-not-a-credential",
      "Content-Type": "application/json",
    });
    if (reply.method === "POST")
      expect(init?.body).toBe(JSON.stringify({ name: request.databaseName }));
    if (reply.throws)
      throw new Error("fixture dependency payload MUST NOT ESCAPE");
    reply.after?.();
    if (reply.text !== undefined)
      return new Response(reply.text, { status: reply.status ?? 200 });
    return await Promise.resolve(
      Response.json(reply.raw ?? { success: true, result: reply.result }, {
        status: reply.status ?? 200,
      }),
    );
  });
  const readRequest = vi.fn(() =>
    Schema.decodeUnknown(Request)(input, { onExcessProperty: "error" }).pipe(
      Effect.mapError(() => failure("configuration", "invalid-request")),
    ),
  );
  // Real CLI orchestration + real durable file store + real provider decoder.
  const run = (args = authorized) =>
    Effect.runPromise(
      command([...args, "--identity", path], {
        readRequest,
        provider: Effect.sync(() =>
          cloudflare(transport, "fixture-only-not-a-credential"),
        ),
        withIdentity: (file, use) => withIdentityFile(file, root, use),
        output: (text) => output.push(text),
      }).pipe(Effect.either),
    );
  const journal = () =>
    Schema.decodeUnknownSync(Schema.parseJson(Journal))(
      readFileSync(path, "utf8"),
    );
  return { path, run, journal, pending, transport, output, readRequest };
};
const errorCode = (
  result: Awaited<ReturnType<ReturnType<typeof fixture>["run"]>>,
) => (Either.isLeft(result) ? result.left.code : "unexpected-success");

describe("authorized CLI with explicit Cloudflare API fixtures (not provider execution)", () => {
  it("creates D1, retains exact identity and hands one complete-Worker target to release tooling without claiming readiness", async () => {
    const f = fixture([subdomain, missingWorker, create]);
    expect(Either.isRight(await f.run())).toBe(true);
    expect(f.pending).toHaveLength(0);
    expect(f.journal()).toEqual({
      state: "resolved",
      identity: {
        version: 1,
        ...{
          accountId: account,
          workerName: request.workerName,
          databaseName: request.databaseName,
        },
        databaseId,
        defaultOrigin: "https://fixture-forum.fixture-owner.workers.dev",
      },
    });
    const result: unknown = JSON.parse(f.output[0] ?? "null");
    expect(result).toMatchObject({
      status: "provisioned-not-ready",
      binding: {
        binding: "DB",
        database_id: databaseId,
        migrations_dir: "apps/forum/migrations",
      },
      worker: {
        workers_dev: true,
        vars: {
          CANONICAL_ORIGIN: "https://fixture-forum.fixture-owner.workers.dev",
        },
      },
      stages: {
        build: "not-run",
        initialization: "not-run",
        deployment: "not-run",
        readiness: "not-run",
      },
    });
    expect(existsSync(`${f.path}.lock`)).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("binds an explicit returned D1 ID without POST or name guessing", async () => {
    const f = fixture([subdomain, missingWorker, lookup], {
      ...request,
      storage: { mode: "bind", databaseId },
    });
    expect(Either.isRight(await f.run())).toBe(true);
    expect(f.transport).toHaveBeenCalledTimes(3);
    expect(f.pending).toHaveLength(0);
  });
  it("reuses retained D1 on retry even if original request says create", async () => {
    const first = fixture([subdomain, missingWorker, create]);
    await first.run();
    const second = fixture(
      [subdomain, missingWorker, lookup],
      request,
      first.path,
    );
    expect(Either.isRight(await second.run())).toBe(true);
    expect(second.pending).toHaveLength(0);
    expect(second.journal()).toEqual(first.journal());
  });
  it("accepts an existing Worker only with exactly the retained D1 binding", async () => {
    const worker = {
      ...missingWorker,
      status: 200,
      result: { bindings: [{ type: "d1", name: "DB", id: databaseId }] },
    };
    const f = fixture([subdomain, worker, lookup], {
      ...request,
      storage: { mode: "bind", databaseId },
    });
    expect(Either.isRight(await f.run())).toBe(true);
  });
  it.each([
    [],
    ["--confirm"],
    ["--allow-provider"],
    ["--source-authorized"],
    ["--confirm", "--allow-provider"],
    ["--confirm", "--source-authorized"],
    ["--allow-provider", "--source-authorized"],
  ])(
    "denies missing owner/source/provider confirmation %j before reads or transport",
    async (...flags) => {
      const f = fixture([]);
      const result = await f.run([
        "provision",
        "--request",
        "fixture.json",
        ...flags,
      ]);
      expect(errorCode(result)).toBe(
        "explicit-provider-source-confirmation-required",
      );
      expect(f.readRequest).not.toHaveBeenCalled();
      expect(f.transport).not.toHaveBeenCalled();
      expect(f.output).toEqual([]);
    },
  );
  it("cancellation performs no reads or provider calls and never reports installation complete", async () => {
    const f = fixture([]);
    expect(errorCode(await f.run([...authorized, "--cancel"]))).toBe(
      "cancelled",
    );
    expect(f.readRequest).not.toHaveBeenCalled();
    expect(f.transport).not.toHaveBeenCalled();
    expect(f.output).toEqual([]);
  });
  it("local plan has no provider traffic, journal or readiness claim", async () => {
    const f = fixture([]);
    expect(
      Either.isRight(await f.run(["plan", "--request", "fixture.json"])),
    ).toBe(true);
    expect(f.transport).not.toHaveBeenCalled();
    expect(existsSync(f.path)).toBe(false);
    expect(f.output[0]).toContain("plan-only-not-installed");
  });
  it.each(["deploy", "--unknown"])(
    "rejects unsupported CLI action %s",
    async (arg) => {
      const f = fixture([]);
      expect(Either.isLeft(await f.run([arg]))).toBe(true);
      expect(f.transport).not.toHaveBeenCalled();
    },
  );
  it.each([401, 403, 429, 500])(
    "fails closed on provider HTTP %i, no D1 creation or completed result",
    async (status) => {
      const f = fixture([
        {
          ...subdomain,
          status,
          raw: { errors: [{ message: "secret fixture payload" }] },
        },
      ]);
      const result = await f.run();
      expect(Either.isLeft(result)).toBe(true);
      expect(JSON.stringify(result)).not.toContain("secret fixture payload");
      expect(f.transport).toHaveBeenCalledTimes(1);
      expect(f.output).toEqual([]);
      expect(existsSync(f.path)).toBe(false);
    },
  );
  it("rejects a non-JSON successful HTTP response without exposing provider output", async () => {
    const f = fixture([{ ...subdomain, text: "private dependency output" }]);
    const result = await f.run();
    expect(errorCode(result)).toBe("provider-invalid-json");
    expect(JSON.stringify(result)).not.toContain("private dependency output");
    expect(f.output).toEqual([]);
  });
  it.each([401, 403])(
    "D1 creation denial %i retains intent and is not readiness",
    async (status) => {
      const f = fixture([
        subdomain,
        missingWorker,
        {
          ...create,
          status,
          raw: {
            success: false,
            errors: [{ message: "untrusted provider body" }],
          },
        },
      ]);
      expect(errorCode(await f.run())).toBe("provider-denied");
      expect(f.journal().state).toBe("intent");
      expect(f.output).toEqual([]);
      expect(f.transport).toHaveBeenCalledTimes(3);
    },
  );
  it("a denied Worker settings read is not mistaken for a missing Worker", async () => {
    const f = fixture([subdomain, { ...missingWorker, status: 403 }]);
    expect(errorCode(await f.run())).toBe("provider-denied");
    expect(f.transport).toHaveBeenCalledTimes(2);
    expect(existsSync(f.path)).toBe(false);
  });
  it("loss of D1 after retained provisioning never creates replacement storage", async () => {
    const first = fixture([subdomain, missingWorker, create]);
    await first.run();
    const original = readFileSync(first.path, "utf8");
    const retry = fixture(
      [subdomain, missingWorker, { ...lookup, status: 404 }],
      request,
      first.path,
    );
    expect(errorCode(await retry.run())).toBe("provider-http-failure");
    expect(retry.transport).toHaveBeenCalledTimes(3);
    expect(readFileSync(first.path, "utf8")).toBe(original);
    expect(retry.output).toEqual([]);
  });
  it("failure recording a returned create identity retains intent and prevents automatic recreation", async () => {
    const path = join(directory(), "identity.json");
    const f = fixture(
      [
        subdomain,
        missingWorker,
        {
          ...create,
          after: () => {
            writeFileSync(`${path}.pending`, "blocked final identity write");
          },
        },
      ],
      request,
      path,
    );
    expect(errorCode(await f.run())).toBe(
      "identity-write-failed-retain-journal",
    );
    expect(f.journal().state).toBe("intent");
    expect(f.output).toEqual([]);
    const retry = fixture([], request, path);
    expect(errorCode(await retry.run())).toBe(
      "uncertain-create-requires-explicit-bind",
    );
    expect(retry.transport).not.toHaveBeenCalled();
  });
  it.each([
    { success: false, result: { subdomain: "fixture-owner" } },
    { success: true, result: {} },
    { success: true, result: { subdomain: "evil.example/escape" } },
  ])("rejects malformed provider response %j", async (raw) => {
    const f = fixture([{ ...subdomain, raw }]);
    expect(errorCode(await f.run())).toBe("provider-invalid-response");
    expect(f.transport).toHaveBeenCalledTimes(1);
  });
  it.each([
    { ...request, accountId: "../wrong" },
    { ...request, workerName: "bad/name" },
    { ...request, storage: { mode: "bind", databaseId: "not-an-id" } },
    { ...request, CANONICAL_ORIGIN: "https://untrusted.example" },
  ])(
    "rejects hostile or surplus installation input %j before transport",
    async (input) => {
      const f = fixture([], input);
      expect(errorCode(await f.run())).toBe("invalid-request");
      expect(f.transport).not.toHaveBeenCalled();
    },
  );
  it("ambiguous create retains intent and blocks another create; explicit bind can recover", async () => {
    const f = fixture([subdomain, missingWorker, { ...create, throws: true }]);
    expect(errorCode(await f.run())).toBe("provider-transport-uncertain");
    expect(f.journal().state).toBe("intent");
    const retry = fixture([], request, f.path);
    expect(errorCode(await retry.run())).toBe(
      "uncertain-create-requires-explicit-bind",
    );
    expect(retry.transport).not.toHaveBeenCalled();
    const bind = fixture(
      [subdomain, missingWorker, lookup],
      { ...request, storage: { mode: "bind", databaseId } },
      f.path,
    );
    expect(Either.isRight(await bind.run())).toBe(true);
    expect(bind.journal().state).toBe("resolved");
  });
  it.each([
    { ...database, uuid: otherId },
    { ...database, name: "another-installation" },
  ])("refuses mismatched D1 identity %j", async (result) => {
    const f = fixture([subdomain, missingWorker, { ...lookup, result }], {
      ...request,
      storage: { mode: "bind", databaseId },
    });
    expect(errorCode(await f.run())).toBe("database-identity-mismatch");
    expect(f.journal().state).toBe("intent");
    expect(f.output).toEqual([]);
  });
  it.each([
    [],
    [{ type: "d1", name: "DB", id: otherId }],
    [{ type: "d1", name: "OTHER", id: databaseId }],
    [
      { type: "d1", name: "DB", id: databaseId },
      { type: "d1", name: "OTHER", id: otherId },
    ],
  ])(
    "refuses an existing Worker with incompatible bindings %j",
    async (...bindings) => {
      const f = fixture(
        [subdomain, { ...missingWorker, status: 200, result: { bindings } }],
        { ...request, storage: { mode: "bind", databaseId } },
      );
      expect(errorCode(await f.run())).toBe("existing-worker-binding-conflict");
      expect(existsSync(f.path)).toBe(false);
    },
  );
  it("does not overwrite an existing Worker on fresh create", async () => {
    const f = fixture([
      subdomain,
      {
        ...missingWorker,
        status: 200,
        result: { bindings: [{ type: "d1", name: "DB", id: databaseId }] },
      },
    ]);
    expect(errorCode(await f.run())).toBe("existing-worker-binding-conflict");
    expect(f.transport).toHaveBeenCalledTimes(2);
  });
  it.each(["account", "worker", "database", "binding", "origin"])(
    "retains identity and refuses changed %s",
    async (field) => {
      const first = fixture([subdomain, missingWorker, create]);
      await first.run();
      const original = readFileSync(first.path, "utf8");
      const input =
        field === "account"
          ? { ...request, accountId: "b".repeat(32) }
          : field === "worker"
            ? { ...request, workerName: "another-worker" }
            : field === "database"
              ? { ...request, databaseName: "another-database" }
              : field === "binding"
                ? { ...request, storage: { mode: "bind", databaseId: otherId } }
                : request;
      const next = fixture(
        field === "origin"
          ? [{ ...subdomain, result: { subdomain: "changed-owner" } }]
          : [],
        input,
        first.path,
      );
      expect(errorCode(await next.run())).toBe(
        field === "origin"
          ? "retained-origin-mismatch"
          : field === "binding"
            ? "retained-database-mismatch"
            : "retained-target-mismatch",
      );
      expect(readFileSync(first.path, "utf8")).toBe(original);
      expect(next.output).toEqual([]);
    },
  );
  it("reports distinct failed lifecycle stages with recovery, never ready", () => {
    for (const stage of [
      "authorization",
      "configuration",
      "provisioning",
      "build",
      "initialization",
      "deployment",
      "readiness",
    ] as const) {
      expect(recovery[stage]).toContain("Installation not completed");
    }
  });
});

describe("real local identity-file safeguards", () => {
  it("fails before provider calls when the identity lock already exists", async () => {
    const f = fixture([]);
    writeFileSync(`${f.path}.lock`, "held");
    expect(errorCode(await f.run())).toBe("identity-path-unsafe-or-locked");
    expect(f.transport).not.toHaveBeenCalled();
    expect(readFileSync(`${f.path}.lock`, "utf8")).toBe("held");
  });
  it.each(["corrupt", "symlink", "public-permissions"])(
    "rejects %s identity without provider calls",
    async (kind) => {
      const f = fixture([]);
      if (kind === "symlink") symlinkSync(join(directory(), "missing"), f.path);
      else {
        writeFileSync(f.path, "corrupt", { mode: 0o600 });
        if (kind === "public-permissions") chmodSync(f.path, 0o644);
      }
      expect(errorCode(await f.run())).toBe("identity-unreadable-or-invalid");
      expect(f.transport).not.toHaveBeenCalled();
    },
  );
  it("rejects a checkout-local identity", async () => {
    const f = fixture([], request, join(root, "forbidden-identity.json"));
    expect(errorCode(await f.run())).toBe("identity-path-unsafe-or-locked");
    expect(f.transport).not.toHaveBeenCalled();
    expect(existsSync(f.path)).toBe(false);
  });
  it("failure to durably record intent prevents D1 creation", async () => {
    const f = fixture([subdomain, missingWorker]);
    writeFileSync(`${f.path}.pending`, "retain uncertain prior write");
    expect(errorCode(await f.run())).toBe(
      "identity-write-failed-retain-journal",
    );
    expect(f.transport).toHaveBeenCalledTimes(2);
    expect(f.output).toEqual([]);
  });
  it("exclusive lock prevents overlapping invocations against one installation", async () => {
    const path = join(directory(), "identity.json");
    const nested = withIdentityFile(path, root, Effect.void).pipe(
      Effect.either,
    );
    const result = await Effect.runPromise(
      withIdentityFile(path, root, nested),
    );
    expect(Either.isLeft(result)).toBe(true);
    expect(existsSync(`${path}.lock`)).toBe(false);
    const empty = await Effect.runPromise(
      withIdentityFile(
        path,
        root,
        Effect.gen(function* () {
          const store = yield* IdentityStore;
          return yield* store.read;
        }),
      ),
    );
    expect(Option.isNone(empty)).toBe(true);
  });
});

describe("actual CLI executable, local-only paths with explicitly isolated environment", () => {
  const execute = (args: readonly string[]) =>
    spawnSync(
      process.execPath,
      ["node_modules/tsx/dist/cli.mjs", "scripts/delivery/main.ts", ...args],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 10_000,
        // Never inherit real credentials or a provider login directory.
        env: {
          PATH: process.env.PATH ?? "",
          HOME: directory(),
          CLOUDFLARE_API_TOKEN: "fixture-only-not-a-credential",
          WRANGLER_SEND_METRICS: "false",
        },
      },
    );
  it("runs local plan without touching provider/identity even with a fake token supplied", () => {
    const folder = directory();
    const path = join(folder, "request.json");
    writeFileSync(path, JSON.stringify(request));
    const result = execute(["plan", "--request", path]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const output: unknown = JSON.parse(result.stdout);
    expect(output).toMatchObject({
      status: "plan-only-not-installed",
      providerExecution: "not-run",
    });
    expect(result.stdout).not.toContain("fixture-only-not-a-credential");
  });
  it("missing authorization exits before reading a nonexistent request or attempting provider access", () => {
    const result = execute([
      "provision",
      "--request",
      "/nonexistent-fixture-request",
    ]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    const output: unknown = JSON.parse(result.stderr);
    expect(output).toMatchObject({
      status: "not-installed",
      stage: "authorization",
      code: "explicit-provider-source-confirmation-required",
    });
    expect(result.stderr).not.toContain("fixture-only-not-a-credential");
  });
  it("cancellation reports installation not completed and exits unsuccessfully", () => {
    const result = execute(["--cancel"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain('"code":"cancelled"');
    expect(result.stderr).toContain("Installation not completed");
  });
});
