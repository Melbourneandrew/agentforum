import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Effect, Either, Option, Schema } from "effect";
import { expect, it } from "vitest";
import { localControls } from "./control-local.js";
import { Identity, failure } from "./model.js";
import { decodeConfig, prepareTarget } from "./release-config.js";
import { Artifact } from "./release-model.js";
import {
  ControlDatabase,
  EffectToken,
  makeControlCoordinator,
  QuiescenceVerifier,
  readControl,
  reconcileControl,
} from "./release-control.js";
const exec = promisify(execFile);
const identity = Schema.decodeUnknownSync(Identity)({
  version: 1,
  accountId: "a".repeat(32),
  workerName: "process-forum",
  databaseName: "process-database",
  databaseId: "11111111-1111-1111-1111-111111111111",
  defaultOrigin: "https://process-forum.owner.workers.dev",
});
const ownerId = "44444444-4444-4444-4444-444444444444",
  executorRef = "local:owned-executor:1";
const line = async (child: ChildProcess) => {
  const stdout = child.stdout;
  if (!stdout) throw new Error("No fixture stdout");
  const chunk = await new Promise<Buffer>((success, error) => {
    const onData = (value: Buffer) => {
      cleanup();
      success(value);
    };
    const onExit = () => {
      cleanup();
      error(new Error("Local process fixture exited before its marker"));
    };
    const onError = () => {
      cleanup();
      error(new Error("Local process fixture could not start"));
    };
    const cleanup = () => {
      stdout.off("data", onData);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    stdout.once("data", onData);
    child.once("exit", onExit);
    child.once("error", onError);
  });
  return Schema.decodeUnknownSync(
    Schema.parseJson(
      Schema.Record({ key: Schema.String, value: Schema.Unknown }),
    ),
  )(chunk.toString("utf8").trim());
};
const terminate = async (child: ChildProcess | undefined) => {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null)
    return;
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
};
it("kills actual executor but refuses reconciliation until separate delayed native D1 effect terminates", async () => {
  const root = process.cwd(),
    state = await mkdtemp(join(tmpdir(), "wo34-process-"));
  let executor: ChildProcess | undefined, effect: ChildProcess | undefined;
  try {
    const server = join(state, "app/dist/server"),
      assets = join(state, "app/dist/client"),
      migrations = join(state, "app/migrations");
    for (const path of [server, assets, migrations])
      await mkdir(path, { recursive: true });
    await writeFile(
      join(server, "index.js"),
      "export default {fetch(){return new Response('local fixture')}}",
    );
    await writeFile(join(assets, "fixture.txt"), "local");
    await writeFile(join(migrations, "0000.sql"), "SELECT 1;");
    const builtConfig = join(server, "wrangler.json");
    await writeFile(
      builtConfig,
      JSON.stringify({
        name: "agent-forum",
        main: "index.js",
        no_bundle: true,
        workers_dev: false,
        preview_urls: false,
        compatibility_date: "2026-11-02",
        compatibility_flags: ["nodejs_compat"],
        vars: {},
        secrets: { required: [] },
        assets: {
          directory: "../client",
          binding: "ASSETS",
          run_worker_first: ["/v1", "/v1/*"],
        },
        observability: { enabled: false },
        d1_databases: [
          {
            binding: "DB",
            database_name: "agent-forum",
            migrations_dir: "../../migrations",
          },
        ],
      }),
    );
    const inputPath = join(state, "input.json"),
      sourceRevision = "b".repeat(40);
    await writeFile(
      inputPath,
      JSON.stringify({
        root,
        state,
        builtConfig,
        identity,
        sourceRevision,
        ownerId,
        executorRef,
      }),
    );
    const env = {
      PATH: process.env.PATH,
      HOME: state,
      XDG_CONFIG_HOME: state,
      CI: "true",
      WRANGLER_SEND_METRICS: "false",
      CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
    };
    const launch = (mode: string) =>
      spawn(
        process.execPath,
        [
          "--import",
          import.meta.resolve("tsx"),
          fileURLToPath(
            new URL("./control-process-fixture.ts", import.meta.url),
          ),
          "--disposable-local-process-fixture",
          mode,
          inputPath,
        ],
        { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] },
      );
    executor = launch("executor");
    executor.stderr?.on("data", (chunk: Buffer) => {
      console.error(chunk.toString("utf8"));
    });
    const armed = await line(executor);
    expect(armed.stage).toBe("armed");
    const token = Schema.decodeUnknownSync(EffectToken)(armed.token),
      artifact = Schema.decodeUnknownSync(Artifact)(armed.artifact);
    effect = launch("effect");
    effect.stderr?.on("data", (chunk: Buffer) => {
      console.error(chunk.toString("utf8"));
    });
    expect((await line(effect)).stage).toBe("outstanding-local-effect");
    const executorExit = once(executor, "exit");
    executor.kill("SIGKILL");
    await executorExit;
    expect(executor.signalCode).toBe("SIGKILL");
    const raw = await Effect.runPromise(
      decodeConfig(await readFile(builtConfig, "utf8")),
    );
    const prepared = await Effect.runPromise(
      prepareTarget({
        raw,
        builtConfig,
        output: join(state, "parent-target.json"),
        identity,
        sourceRevision,
        authorizeTarget: true,
      }),
    );
    await writeFile(
      prepared.artifact.configPath,
      JSON.stringify(prepared.target),
    );
    const controls = await localControls({
      prepared,
      root,
      state,
      run: async (args) =>
        (
          await exec(
            process.execPath,
            [
              join(root, "apps/forum/node_modules/wrangler/bin/wrangler.js"),
              ...args,
            ],
            { cwd: root, env, timeout: 30000, maxBuffer: 4 * 1024 * 1024 },
          )
        ).stdout,
    });
    const oldExecutor = executor,
      outstandingEffect = effect;
    const observer: typeof QuiescenceVerifier.Service = {
      executor: (row) =>
        oldExecutor.signalCode === "SIGKILL"
          ? Effect.succeed({
              ownerId,
              generation: row.generation,
              sequence: row.effect_seq,
              executorRef,
              terminal: true,
              observationRef: `local:child-exit:${String(oldExecutor.pid)}`,
            })
          : Effect.fail(failure("initialization", "executor-live")),
      effect: (row) =>
        Effect.gen(function* () {
          if (outstandingEffect.exitCode !== 0)
            return yield* Effect.fail(
              failure("initialization", "effect-outstanding"),
            );
          const result = yield* controls.database.query(
            "SELECT name FROM sqlite_master WHERE name='local_delayed_effect'",
            [],
          );
          if (result.length !== 1)
            return yield* Effect.fail(
              failure("initialization", "effect-result-unreconciled"),
            );
          return {
            ...token,
            identity,
            sourceRevision: row.source_revision,
            artifactDigest: row.artifact_sha256,
            operationRef: `local:effect-exit:${String(outstandingEffect.pid)}`,
            outcome: "succeeded",
          };
        }),
    };
    const reconcile = () =>
      Effect.runPromise(
        Effect.either(
          reconcileControl().pipe(
            Effect.provideService(ControlDatabase, controls.database),
            Effect.provideService(QuiescenceVerifier, observer),
          ),
        ),
      );
    const denied = await reconcile();
    expect(Either.isLeft(denied) && denied.left.code).toBe(
      "effect-quiescence-unproved",
    );
    const contender = await Effect.runPromise(
      makeControlCoordinator({
        artifact,
        ownerId: "55555555-5555-5555-5555-555555555555",
        executorRef: "local:contender",
      }).pipe(Effect.provideService(ControlDatabase, controls.database)),
    );
    expect(
      Either.isLeft(
        await Effect.runPromise(Effect.either(contender.acquire(identity))),
      ),
    ).toBe(true);
    const effectExit = once(effect, "exit");
    effect.stdin?.end("commit\n");
    expect((await line(effect)).stage).toBe("effect-terminal");
    await effectExit;
    expect(Either.isRight(await reconcile())).toBe(true);
    const row = await Effect.runPromise(readControl(controls.database));
    expect(Option.isSome(row) && row.value.phase).toBe("idle");
    await Effect.runPromise(contender.acquire(identity));
  } finally {
    await terminate(executor);
    await terminate(effect);
    await rm(state, { recursive: true, force: true });
  }
}, 120000);
