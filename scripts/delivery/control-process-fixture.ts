// Dedicated disposable-local process fixture, not a deploy entry or provider
// executor/terminality attestation. Only the exact fixture action can be run.
import { execFile } from "node:child_process";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { Effect, Schema } from "effect";
import {
  bootstrapControl,
  NativeControlMigrations,
} from "./control-bootstrap.js";
import { localControls } from "./control-local.js";
import { Identity } from "./model.js";
import { decodeConfig, prepareTarget } from "./release-config.js";
import { ControlDatabase, makeControlCoordinator } from "./release-control.js";
import { Revision } from "./release-model.js";

const Input = Schema.Struct({
  root: Schema.String,
  state: Schema.String,
  builtConfig: Schema.String,
  identity: Identity,
  sourceRevision: Revision,
  ownerId: Schema.String,
  executorRef: Schema.String,
});
let stage = "input";
const fixture = async () => {
  const [flag, mode, path, ...extra] = process.argv.slice(2);
  if (
    flag !== "--disposable-local-process-fixture" ||
    (mode !== "executor" && mode !== "effect") ||
    !path ||
    extra.length
  )
    throw new Error("Unsupported local fixture arguments");
  const input = Schema.decodeUnknownSync(Schema.parseJson(Input))(
    await readFile(path, "utf8"),
  );
  stage = "build-target";
  const raw = await Effect.runPromise(
    decodeConfig(await readFile(input.builtConfig, "utf8")),
  );
  const prepared = await Effect.runPromise(
    prepareTarget({
      raw,
      builtConfig: input.builtConfig,
      output: join(input.state, `target-${mode}.json`),
      identity: input.identity,
      sourceRevision: input.sourceRevision,
      authorizeTarget: true,
    }),
  );
  await writeFile(
    prepared.artifact.configPath,
    JSON.stringify(prepared.target),
    {
      flag: "wx",
    },
  );
  const exec = promisify(execFile);
  stage = "local-controls";
  const controls = await localControls({
    prepared,
    root: input.root,
    state: input.state,
    run: async (args) => {
      const result = await exec(
        process.execPath,
        [
          join(input.root, "apps/forum/node_modules/wrangler/bin/wrangler.js"),
          ...args,
        ],
        {
          env: {
            PATH: process.env.PATH,
            HOME: input.state,
            XDG_CONFIG_HOME: input.state,
            CI: "true",
            WRANGLER_SEND_METRICS: "false",
            CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
          },
          timeout: 30000,
          maxBuffer: 4 * 1024 * 1024,
        },
      );
      return result.stdout;
    },
  });
  if (mode === "executor") {
    stage = "bootstrap";
    await Effect.runPromise(
      bootstrapControl().pipe(
        Effect.provideService(ControlDatabase, controls.database),
        Effect.provideService(NativeControlMigrations, controls.bootstrap),
      ),
    );
    stage = "coordinator";
    const coordinator = await Effect.runPromise(
      makeControlCoordinator({
        artifact: prepared.artifact,
        ownerId: input.ownerId,
        executorRef: input.executorRef,
      }).pipe(Effect.provideService(ControlDatabase, controls.database)),
    );
    stage = "acquire";
    const session = await Effect.runPromise(
      coordinator.acquire(input.identity),
    );
    stage = "intent";
    const token = await Effect.runPromise(
      session.arm("business-migrate", prepared.artifact),
    );
    console.log(
      JSON.stringify({ stage: "armed", token, artifact: prepared.artifact }),
    );
    const timer = setInterval(() => undefined, 1000);
    await once(process, "SIGTERM");
    clearInterval(timer);
    // SIGKILL test never reaches a cleanup/closure path: intent stays durable.
  } else {
    console.log(JSON.stringify({ stage: "outstanding-local-effect" }));
    await once(process.stdin, "data");
    await Effect.runPromise(
      controls.database.query(
        "CREATE TABLE local_delayed_effect(value INTEGER CHECK(value=1))",
        [],
      ),
    );
    console.log(JSON.stringify({ stage: "effect-terminal" }));
  }
};
await fixture().catch(() => {
  console.error(JSON.stringify({ status: "local-fixture-failed", stage }));
  process.exitCode = 1;
});
