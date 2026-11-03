import { createServer } from "node:net";
import { readFile, stat } from "node:fs/promises";
import {
  Data,
  Effect,
  Exit,
  Layer,
  Option,
  Redacted,
  Schedule,
  Schema,
} from "effect";
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  DirectDatabase,
  directDatabaseLayer,
  databaseBindingsLayer,
} from "../../src/database/database.js";
import {
  LocalDescriptor,
  ownedLocalDatabaseUrl,
} from "../../scripts/local-postgres.js";
import { localDescriptorPath } from "../../scripts/local-descriptor.js";
import { ownedProcess } from "../../scripts/owned-process.js";
class LocalCliFailure extends Data.TaggedError("LocalCliFailure") {}
const signalTermination = (pid: number) => {
  try {
    process.kill(-pid, "SIGTERM");
  } catch (error) {
    if (!Schema.is(Schema.Struct({ code: Schema.Literal("ESRCH") }))(error))
      throw new LocalCliFailure();
  }
};
const freePort = () =>
  new Promise<number>((done, reject) => {
    const server = createServer();
    server.on("error", () => {
      reject(new LocalCliFailure());
    });
    server.listen(0, "127.0.0.1", () => {
      const address = Schema.decodeUnknownEither(
        Schema.Struct({ port: Schema.Int }),
      )(server.address());
      server.close((error) => {
        if (error || address._tag === "Left") reject(new LocalCliFailure());
        else done(address.right.port);
      });
    });
  });
const reset = (args: readonly string[]) =>
  Effect.scoped(
    Effect.gen(function* () {
      const lease = yield* ownedProcess(
        "pnpm",
        ["exec", "tsx", "scripts/reset-local.ts", ...args],
        {
          output: "capture",
          environment: {
            GITHUB_ACTIONS: "false",
            MIGRATION_DATABASE_URL:
              "postgresql://synthetic:never-print-this@origin.example.invalid:5432/unused",
          },
        },
      );
      const result = yield* Effect.promise(() => lease.completion);
      expect(result.stdout + result.stderr).not.toContain("never-print-this");
      if (result.code === 0) {
        process.stdout.write(result.stdout);
        process.stderr.write(result.stderr);
      }
      return result.code;
    }),
  );
describe("actual owned-local commands", () => {
  it("starts development, rejects remote reset arguments, resets/migrates locally and cleans up on termination", async () => {
    const port = await freePort();
    const origin = `http://127.0.0.1:${String(port)}`;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const lease = yield* ownedProcess(
            "pnpm",
            ["exec", "tsx", "scripts/database-dev.ts"],
            {
              output: "capture",
              environment: {
                LOCAL_API_PORT: String(port),
                WRANGLER_SEND_METRICS: "false",
              },
            },
          );
          yield* Effect.tryPromise({
            try: async (signal) => {
              const response = await fetch(`${origin}/v1/health`, {
                signal: AbortSignal.any([signal, AbortSignal.timeout(500)]),
              });
              await response.arrayBuffer();
              if (response.status !== 200) throw new LocalCliFailure();
            },
            catch: () => new LocalCliFailure(),
          }).pipe(
            Effect.retry({
              times: 250,
              schedule: Schedule.spaced("100 millis"),
            }),
          );
          const descriptor = yield* Effect.tryPromise({
            try: () => readFile(localDescriptorPath, "utf8"),
            catch: () => new LocalCliFailure(),
          }).pipe(
            Effect.flatMap(
              Schema.decodeUnknown(Schema.parseJson(LocalDescriptor)),
            ),
          );
          const mode = yield* Effect.promise(() => stat(localDescriptorPath));
          expect(mode.mode & 0o777).toBe(0o600);
          const url = yield* ownedLocalDatabaseUrl(descriptor);
          const layer = directDatabaseLayer.pipe(
            Layer.provide(
              databaseBindingsLayer({
                HYPERDRIVE_DIRECT: { connectionString: Redacted.value(url) },
                HYPERDRIVE_CACHED: { connectionString: Redacted.value(url) },
              }),
            ),
          );
          const create = Effect.flatMap(DirectDatabase, (database) =>
            database.execute(
              () => sql`CREATE TABLE agentforum_reset_probe (n integer)`,
              Schema.Never,
            ),
          ).pipe(Effect.provide(layer));
          yield* create;
          expect(
            yield* reset([
              "--url",
              "postgresql://synthetic:never-print-this@origin.example.invalid:5432/unused",
            ]),
          ).toBe(1);
          const present = () =>
            Effect.flatMap(DirectDatabase, (database) =>
              database.execute(
                () =>
                  sql`SELECT to_regclass('public.agentforum_reset_probe') IS NOT NULL AS present`,
                Schema.Struct({ present: Schema.Boolean }),
              ),
            ).pipe(Effect.provide(Layer.fresh(layer)));
          expect(yield* present()).toEqual([{ present: true }]);
          expect(yield* reset([])).toBe(0);
          expect(yield* present()).toEqual([{ present: false }]);
          const pid = lease.child.pid;
          yield* Effect.filterOrFail(
            Effect.succeed(pid),
            Schema.is(Schema.Int),
            () => new LocalCliFailure(),
          ).pipe(
            Effect.tap((pid) =>
              Effect.promise(async () => {
                // Exercise duplicate wrapper-forwarded signals during finalization.
                for (let attempt = 0; attempt < 3; attempt++) {
                  signalTermination(pid);
                  await new Promise<void>((done) => {
                    setTimeout(done, 10);
                  });
                }
              }),
            ),
          );
          const stopped = yield* Effect.promise(() => lease.completion).pipe(
            Effect.timeoutFail({
              duration: "10 seconds",
              onTimeout: () => new LocalCliFailure(),
            }),
          );
          process.stdout.write(stopped.stdout);
          process.stderr.write(stopped.stderr);
          expect(
            stopped.code === 0 ||
              stopped.code === 143 ||
              Option.contains(stopped.signal, "SIGTERM"),
          ).toBe(true);
          // pnpm may exit before the CLI finishes asynchronous scope cleanup.
          // Await actual resource release, not wrapper exit as a substitute.
          yield* Effect.exit(ownedLocalDatabaseUrl(descriptor)).pipe(
            Effect.repeat({
              until: Exit.isFailure,
              schedule: Schedule.spaced("20 millis"),
            }),
            Effect.timeoutFail({
              duration: "5 seconds",
              onTimeout: () => new LocalCliFailure(),
            }),
          );
          expect(
            Exit.isFailure(
              yield* Effect.exit(ownedLocalDatabaseUrl(descriptor)),
            ),
          ).toBe(true);
        }),
      ).pipe(
        Effect.timeoutFail({
          duration: "35 seconds",
          onTimeout: () => new LocalCliFailure(),
        }),
      ),
    );
    await expect(readFile(localDescriptorPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  }, 45_000);
});
