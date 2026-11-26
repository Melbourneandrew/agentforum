// Private owned build IPC carries admitted DATA, never execution authority.
// This module does not import Vite/tooling into the credential-bearing parent.
import { execFile, fork, type ChildProcess } from "node:child_process";
import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Context, Effect, Layer, Option, Schema } from "effect";
import {
  failure,
  type DeliveryError,
} from "../../../scripts/delivery/model.js";

export const DiagnosticEnvironment = Schema.Literal(
  "local",
  "preview",
  "staging",
  "production",
);
const Revision = Schema.String.pipe(
  Schema.minLength(40),
  Schema.maxLength(40),
  Schema.pattern(/^[a-f0-9]{40}$/),
);
const Pair = Schema.Struct({
  environment: DiagnosticEnvironment,
  revision: Revision,
});
export const BuildInput = Schema.Struct({
  version: Schema.Literal(1),
  repository: Schema.NonEmptyString,
  revision: Revision,
  metadata: Schema.NullOr(Pair),
});
export type BuildInput = typeof BuildInput.Type;
const Built = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("built"),
  revision: Revision,
  metadata: Schema.NullOr(Pair),
});
// Reconstruct, never spread, even a caller-supplied environment. No secret key
// is inspected. These are the existing Owner executor's explicit safe fields.
export const safeBuildEnvironment = (
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv => ({
  PATH: env.PATH ?? "",
  HOME: env.HOME ?? "",
  XDG_CONFIG_HOME: env.XDG_CONFIG_HOME ?? "",
  CI: "true",
  CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
  WRANGLER_SEND_METRICS: "false",
  WRANGLER_LOG_PATH: env.WRANGLER_LOG_PATH ?? "",
  WRANGLER_RESOURCES_PROVISION: "false",
});
const invalid = () => failure("build", "owner-build-unverified");
export const decodeBuildInput = (input: unknown) =>
  Schema.decodeUnknown(BuildInput)(input, { onExcessProperty: "error" }).pipe(
    Effect.mapError(invalid),
    Effect.filterOrFail(
      (value) =>
        resolve(value.repository) === value.repository &&
        (value.metadata === null || value.metadata.revision === value.revision),
      invalid,
    ),
    Effect.map((value) =>
      Object.freeze({
        ...value,
        metadata:
          value.metadata === null ? null : Object.freeze({ ...value.metadata }),
      }),
    ),
  );
export class BuildProcess extends Context.Tag("delivery/BuildProcess")<
  BuildProcess,
  {
    readonly start: (
      input: BuildInput,
      env: NodeJS.ProcessEnv,
    ) => Effect.Effect<ChildProcess, DeliveryError>;
  }
>() {}
export const buildProcessLive = Layer.succeed(BuildProcess, {
  start: (input, env) =>
    Effect.try({
      try: () =>
        fork(join(input.repository, "apps/forum/scripts/owner-build.ts"), [], {
          cwd: join(input.repository, "apps/forum"),
          env: safeBuildEnvironment(env),
          execArgv: ["--import", fileURLToPath(import.meta.resolve("tsx"))],
          stdio: ["ignore", "ignore", "ignore", "ipc"],
          detached: true,
        }),
      catch: invalid,
    }),
});
const own = (child: ChildProcess) => {
  // Observe close immediately, including spawn/loader failures. Never forward
  // raw output or exception values. The entire process group is privately owned.
  child.on("error", () => undefined);
  const closed = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((done) => {
    child.once("close", (code, signal) => {
      done({ code, signal });
    });
  });
  return { child, closed };
};
const release = (owned: ReturnType<typeof own>) =>
  Effect.promise(async () => {
    if (owned.child.pid !== undefined) {
      try {
        process.kill(-owned.child.pid, "SIGKILL");
      } catch {
        /* Already closed. */
      }
    }
    await owned.closed;
  });
// Calling/validating this helper grants nothing. Only the existing admitted
// ParentExecution path may compose it with artifact/provider acquisition.
export const ownerBuild = (input: unknown, env: NodeJS.ProcessEnv) =>
  Effect.scoped(
    Effect.gen(function* () {
      const request = yield* decodeBuildInput(input);
      const processService = yield* BuildProcess;
      const owned = yield* Effect.acquireRelease(
        processService
          .start(request, safeBuildEnvironment(env))
          .pipe(Effect.map(own)),
        release,
      );
      yield* Effect.async<undefined, DeliveryError>((resume) => {
        let terminal = false,
          stopped = false;
        const deny = () => {
          if (!stopped) resume(Effect.fail(invalid()));
        };
        const message = (value: unknown) => {
          const result = Schema.decodeUnknownOption(Built)(value, {
            onExcessProperty: "error",
          });
          if (
            terminal ||
            Option.isNone(result) ||
            result.value.revision !== request.revision ||
            JSON.stringify(result.value.metadata) !==
              JSON.stringify(request.metadata)
          ) {
            deny();
            return;
          }
          terminal = true;
        };
        const disconnect = () => {
          if (!terminal) deny();
        };
        owned.child.on("message", message);
        owned.child.on("error", deny);
        owned.child.on("disconnect", disconnect);
        void owned.closed.then(({ code, signal }) => {
          if (!stopped)
            resume(
              terminal && code === 0 && signal === null
                ? Effect.succeed(undefined)
                : Effect.fail(invalid()),
            );
        });
        try {
          owned.child.send(request, (error) => {
            if (error) deny();
          });
        } catch {
          deny();
        }
        return Effect.sync(() => {
          stopped = true;
          owned.child.off("message", message);
          owned.child.off("error", deny);
          owned.child.off("disconnect", disconnect);
        });
      }).pipe(
        Effect.timeoutFail({ duration: "120 seconds", onTimeout: invalid }),
      );
    }),
  );

export class BuildTools extends Context.Tag("delivery/BuildTools")<
  BuildTools,
  {
    readonly source: (input: BuildInput) => Effect.Effect<void, DeliveryError>;
    readonly build: (input: BuildInput) => Effect.Effect<void, DeliveryError>;
  }
>() {}
const git = (args: readonly string[], repository: string) =>
  Effect.tryPromise({
    try: () =>
      new Promise<string>((done, reject) => {
        execFile(
          "git",
          [...args],
          {
            cwd: repository,
            env: safeBuildEnvironment(process.env),
            timeout: 30_000,
            maxBuffer: 1024 * 1024,
            encoding: "utf8",
          },
          (error, stdout) => {
            if (error) reject(invalid());
            else done(stdout);
          },
        );
      }),
    catch: invalid,
  });
export const buildToolsLive = Layer.succeed(BuildTools, {
  source: (input) =>
    Effect.gen(function* () {
      const root = yield* Effect.tryPromise({
        try: () => realpath(input.repository),
        catch: invalid,
      });
      const head = yield* git(["rev-parse", "HEAD"], root);
      const status = yield* git(
        ["status", "--porcelain=v1", "--untracked-files=normal"],
        root,
      );
      if (
        root !== input.repository ||
        head.trim() !== input.revision ||
        status !== ""
      )
        return yield* Effect.fail(invalid());
    }),
  build: (input) =>
    Effect.tryPromise({
      try: async () => {
        // Supported public API. Keep configured RR/CF orchestration and real
        // configFile (RR's child compiler requires it). No internal CLI imports.
        const { createBuilder } = await import("vite");
        const root = join(input.repository, "apps/forum");
        const builder = await createBuilder({
          root,
          configFile: join(root, "vite.config.mjs"),
          mode: "production",
          envDir: false,
          define: { __AGENTFORUM_DEPLOYMENT__: JSON.stringify(input.metadata) },
        });
        await builder.buildApp();
      },
      catch: invalid,
    }),
});
export const buildChild = (input: unknown) =>
  Effect.gen(function* () {
    const request = yield* decodeBuildInput(input);
    const tools = yield* BuildTools;
    yield* tools.source(request);
    yield* tools.build(request);
    yield* tools.source(request);
    return {
      version: 1 as const,
      kind: "built" as const,
      revision: request.revision,
      metadata: request.metadata,
    };
  });
// Not a CLI assertion/grant interface. One message on the parent's owned fork
// channel; duplicate/disconnected input and failure always exit nonzero.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.send || !process.connected) process.exitCode = 1;
  else {
    let received = false;
    const timer = setTimeout(() => {
      process.exit(1);
    }, 120_000);
    process.on("disconnect", () => {
      process.exit(1);
    });
    process.on("message", (input: unknown) => {
      if (received) {
        process.exit(1);
      }
      received = true;
      void Effect.runPromise(
        Effect.either(buildChild(input).pipe(Effect.provide(buildToolsLive))),
      ).then(
        (result) => {
          if (result._tag === "Left" || !process.send) {
            process.exit(1);
          } else
            process.send(result.right, (error) => {
              clearTimeout(timer);
              process.exit(error ? 1 : 0);
            });
        },
        () => {
          process.exit(1);
        },
      );
    });
  }
}
