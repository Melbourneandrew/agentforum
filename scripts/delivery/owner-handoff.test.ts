// Injected unit transports, not provider/grant/readiness/terminality evidence.
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Either, Option, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { Identity, failure, type Journal } from "./model.js";
import { IdentityStore } from "./provision.js";
import { cloudflare } from "./provider.js";
import {
  deniedOwnerAccess,
  ownerEntryAuthorization,
  OwnerReleaseAccess,
  verifyOwnerHandoff,
} from "./owner-handoff.js";
const identity = Schema.decodeUnknownSync(Identity)({
  version: 1,
  accountId: "a".repeat(32),
  workerName: "owner-forum",
  databaseName: "owner-db",
  databaseId: "11111111-1111-1111-1111-111111111111",
  defaultOrigin: "https://owner-forum.owner.workers.dev",
});
const input = {
  mode: "cli",
  operation: "update",
  inputPath: "/never-opened/unit-journal",
} as const;
const fixture = (
  options: {
    journal?: "missing" | "intent";
    account?: string;
    database?: string;
    origin?: string;
    binding?: string;
    absent?: boolean;
    deny?: boolean;
    status?: number;
  } = {},
) => {
  const calls: string[] = [];
  const journal: Journal =
    options.journal === "intent"
      ? {
          state: "intent",
          target: {
            accountId: identity.accountId,
            workerName: identity.workerName,
            databaseName: identity.databaseName,
          },
        }
      : { state: "resolved", identity };
  const provider = cloudflare((url, init) => {
    if (typeof url !== "string")
      return Promise.reject(new Error("expected fixed provider URL"));
    const path = new URL(url).pathname;
    calls.push(`${init?.method ?? ""} ${path}`);
    if (options.status)
      return Promise.resolve(new Response(null, { status: options.status }));
    if (options.absent && path.endsWith("/settings"))
      return Promise.resolve(new Response(null, { status: 404 }));
    const result = path.includes("/d1/database/")
      ? {
          uuid: options.database ?? identity.databaseId,
          name: identity.databaseName,
        }
      : path.endsWith("/subdomain")
        ? { subdomain: options.origin ?? "owner" }
        : {
            bindings: [
              {
                type: "d1",
                name: "DB",
                id: options.binding ?? identity.databaseId,
              },
            ],
          };
    return Promise.resolve(Response.json({ success: true, result }));
  }, "synthetic-unused-token");
  const access: typeof OwnerReleaseAccess.Service = {
    authorize: () =>
      Effect.gen(function* () {
        calls.push("authorize");
        if (options.deny)
          return yield* Effect.fail(failure("authorization", "denied"));
        return {
          accountId: options.account ?? identity.accountId,
          executorRef: "local:owner-unit",
        };
      }),
    provider: Effect.sync(() => {
      calls.push("provider");
      return provider;
    }),
  };
  const program = verifyOwnerHandoff(input).pipe(
    Effect.provideService(OwnerReleaseAccess, access),
    Effect.provideService(IdentityStore, {
      read: Effect.sync(() => {
        calls.push("journal");
        return options.journal === "missing"
          ? Option.none()
          : Option.some(journal);
      }),
      write: () => Effect.die("must never rewrite journal"),
    }),
  );
  return { program, calls, access };
};
describe("retained-owner handoff implementation", () => {
  for (const absent of [false, true])
    it(`revalidates retained resource/account/origin without writes, worker absent=${String(absent)}`, async () => {
      const h = fixture({ absent });
      const result = await Effect.runPromise(h.program);
      expect(result.identity).toEqual(identity);
      expect(h.calls.slice(0, 3)).toEqual(["authorize", "journal", "provider"]);
      expect(h.calls.slice(3)).toHaveLength(3);
      expect(h.calls.slice(3).every((call) => call.startsWith("GET "))).toBe(
        true,
      );
      expect(
        h.calls
          .slice(3)
          .every((call) => call.includes(`/accounts/${identity.accountId}/`)),
      ).toBe(true);
    });
  for (const options of [
    { deny: true },
    { journal: "missing" },
    { journal: "intent" },
    { account: "b".repeat(32) },
  ] as const)
    it(`rejects authority/journal/account before provider construction ${JSON.stringify(options)}`, async () => {
      const h = fixture(options);
      expect(
        Either.isLeft(await Effect.runPromise(Effect.either(h.program))),
      ).toBe(true);
      expect(h.calls).not.toContain("provider");
      if ("deny" in options) expect(h.calls).toEqual(["authorize"]);
    });
  for (const options of [
    { database: "22222222-2222-2222-2222-222222222222" },
    { origin: "foreign" },
    { binding: "22222222-2222-2222-2222-222222222222" },
  ])
    it(`rejects live identity drift, never substitutes/recreates ${JSON.stringify(options)}`, async () => {
      const h = fixture(options);
      expect(
        Either.isLeft(await Effect.runPromise(Effect.either(h.program))),
      ).toBe(true);
      expect(h.calls.every((call) => !call.startsWith("POST "))).toBe(true);
    });
  it("secure-file wrapper denies before touching unreadable input or credentials; native cannot borrow owner admission", async () => {
    const authorization = ownerEntryAuthorization(
      process.cwd(),
      deniedOwnerAccess,
    );
    for (const mode of ["native", "cli"] as const) {
      const result = await Effect.runPromise(
        Effect.either(authorization.admit({ ...input, mode })),
      );
      expect(Either.isLeft(result) && result.left.stage).toBe("authorization");
    }
  });
  it("keeps actual HTTP authorization failures in authorization stage, without treating read failure as identity success", async () => {
    for (const status of [401, 403]) {
      const h = fixture({ status });
      const result = await Effect.runPromise(Effect.either(h.program));
      expect(Either.isLeft(result) && result.left.stage).toBe("authorization");
      expect(h.calls.slice(3)).toHaveLength(1);
    }
  });
  it("secure journal bridge validates once and never rewrites the retained file or leaves its lock", async () => {
    const state = mkdtempSync(join(tmpdir(), "wo34-owner-journal-"));
    try {
      const path = join(state, "identity.json");
      const text = JSON.stringify({ state: "resolved", identity });
      writeFileSync(path, text, { mode: 0o600 });
      const h = fixture();
      const result = await Effect.runPromise(
        ownerEntryAuthorization(process.cwd(), h.access).admit({
          ...input,
          inputPath: path,
        }),
      );
      expect(result.identity).toEqual(identity);
      expect(h.calls.filter((call) => call === "authorize")).toHaveLength(1);
      expect(readFileSync(path, "utf8")).toBe(text);
      expect(existsSync(`${path}.lock`)).toBe(false);
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  });
});
