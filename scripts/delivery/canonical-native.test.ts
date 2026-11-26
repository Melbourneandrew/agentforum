// Native LOCAL Wrangler/workerd config consumer, not a provider install or full
// UI readiness claim. Both configs preserve one disposable D1 and workers.dev;
// no token/env inheritance, remote command, hostname attachment or root qualifier.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Effect, Schema } from "effect";
import { expect, it } from "vitest";
import { Identity } from "./model.js";
import { prepareTarget } from "./release-config.js";
import { authorizeZoneTarget } from "./zone-authority.js";

it("native default/custom canonical configs retain local D1 and ignore hostile forwarded metadata", async () => {
  const state = await mkdtemp(join(tmpdir(), "wo34-canonical-native-"));
  const server = join(state, "app/dist/server"),
    assets = join(state, "app/dist/client"),
    migrations = join(state, "app/migrations");
  const identity = Schema.decodeUnknownSync(Identity)({
    version: 1,
    accountId: "a".repeat(32),
    workerName: "canonical-local-fixture",
    databaseName: "canonical-local-db",
    databaseId: "11111111-1111-1111-1111-111111111111",
    defaultOrigin: "https://canonical-local-fixture.fixture.workers.dev",
  });
  const canonicalOrigin = "https://forum.example.com";
  const wrangler = resolve("apps/forum/node_modules/wrangler/bin/wrangler.js");
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: state,
    XDG_CONFIG_HOME: state,
    CI: "true",
    CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
    WRANGLER_SEND_METRICS: "false",
    WRANGLER_LOG_PATH: join(state, "wrangler.log"),
    WRANGLER_RESOURCES_PROVISION: "false",
  };
  const persist = join(state, "local-d1");
  let child: ChildProcess | undefined;
  const running = (process: ChildProcess) =>
    process.exitCode === null && process.signalCode === null;
  const stop = async () => {
    const active = child;
    if (!active || !running(active)) {
      child = undefined;
      return;
    }
    const exited = once(active, "exit");
    active.kill("SIGTERM");
    await Promise.race([exited, delay(3000)]);
    if (running(active)) active.kill("SIGKILL");
    await exited;
    child = undefined;
  };
  const run = (config: string, args: string[]) =>
    new Promise<void>((success, reject) => {
      execFile(
        process.execPath,
        [
          wrangler,
          ...args,
          "--config",
          config,
          "--persist-to",
          persist,
          "--env-file",
          "/dev/null",
        ],
        { cwd: state, env, timeout: 30000, maxBuffer: 4 * 1024 * 1024 },
        (error) => {
          if (error) reject(new Error("local-native-failed"));
          else success();
        },
      );
    });
  try {
    for (const path of [server, assets, migrations])
      await mkdir(path, { recursive: true });
    await mkdir(join(state, "source"));
    await writeFile(
      join(state, "source/index.ts"),
      `import { Effect, Either } from ${JSON.stringify(resolve("node_modules/effect/dist/esm/index.js"))};
import { installationOrigin } from ${JSON.stringify(resolve("apps/forum/src/runtime/context.ts"))};
export default { async fetch(request, env) {
  const url = new URL(request.url);
  const origin = url.searchParams.get("origin") || ${JSON.stringify(identity.defaultOrigin)};
  const checked = await Effect.runPromise(Effect.either(installationOrigin(new Request(origin, { headers: { Host: url.searchParams.get("host") || new URL(origin).host, Forwarded: "host=hostile.example.com", "X-Forwarded-Host": "hostile.example.com" } }), env)));
  if (Either.isLeft(checked)) return Response.json({ invalid: true }, { status: 400 });
  const retained = await env.DB.prepare("SELECT value FROM fixture_origin LIMIT 1").first("value");
  return Response.json({ canonicalOrigin: checked.right, retained });
}};`,
    );
    await writeFile(join(assets, "fixture.txt"), "public native fixture");
    await writeFile(
      join(migrations, "0000_fixture.sql"),
      "CREATE TABLE fixture_origin(value TEXT); INSERT INTO fixture_origin VALUES ('retained-local-only');",
    );
    // Bundle the ACTUAL existing runtime origin module with pinned native
    // Wrangler, then consume that complete local Worker through no_bundle target.
    const bundleConfig = join(state, "bundle.json");
    await writeFile(
      bundleConfig,
      JSON.stringify({
        name: identity.workerName,
        main: "source/index.ts",
        compatibility_date: "2026-11-02",
        compatibility_flags: ["nodejs_compat"],
      }),
    );
    await new Promise<void>((success, reject) => {
      execFile(
        process.execPath,
        [
          wrangler,
          "deploy",
          "--dry-run",
          "--config",
          bundleConfig,
          "--outdir",
          server,
          "--env-file",
          "/dev/null",
        ],
        { cwd: state, env, timeout: 30000, maxBuffer: 4 * 1024 * 1024 },
        (error) => {
          if (error) reject(new Error("local-native-bundle-failed"));
          else success();
        },
      );
    });
    const raw = {
      name: "fixture-unbound",
      main: "index.js",
      no_bundle: true,
      workers_dev: false,
      preview_urls: false,
      compatibility_date: "2026-11-02",
      compatibility_flags: ["nodejs_compat"],
      vars: {},
      secrets: { required: [] },
      observability: { enabled: false },
      assets: {
        directory: "../client",
        binding: "ASSETS",
        run_worker_first: ["/v1", "/v1/*"],
      },
      d1_databases: [
        {
          binding: "DB",
          database_name: "fixture-unbound",
          migrations_dir: "../../migrations",
        },
      ],
    };
    const builtConfig = join(server, "wrangler.json");
    await writeFile(builtConfig, JSON.stringify(raw));
    for (const origin of [identity.defaultOrigin, canonicalOrigin]) {
      const output = join(
        state,
        origin === canonicalOrigin ? "custom.json" : "default.json",
      );
      const { target, artifact } = await Effect.runPromise(
        prepareTarget({
          raw,
          builtConfig,
          output,
          identity,
          sourceRevision: "a".repeat(40),
          authorizeTarget: true,
          canonicalOrigin: origin,
        }),
      );
      await Effect.runPromise(authorizeZoneTarget(target, []));
      expect(target.workers_dev).toBe(true);
      expect(artifact.identity).toEqual(identity);
      expect(artifact.canonicalOrigin).toBe(origin);
      await writeFile(output, JSON.stringify(target), { mode: 0o600 });
      await run(output, ["d1", "migrations", "apply", "DB", "--local"]);
      const portServer = createServer();
      portServer.listen(0, "127.0.0.1");
      await once(portServer, "listening");
      const address = portServer.address();
      if (!address || typeof address === "string")
        throw new Error("local-port-unavailable");
      const port = address.port;
      await new Promise<void>((done) =>
        portServer.close(() => {
          done();
        }),
      );
      child = spawn(
        process.execPath,
        [
          wrangler,
          "dev",
          "--local",
          "--ip",
          "127.0.0.1",
          "--port",
          String(port),
          "--inspector-port",
          "0",
          "--config",
          output,
          "--persist-to",
          persist,
          "--env-file",
          "/dev/null",
        ],
        { cwd: state, env, stdio: "ignore" },
      );
      let response: Response | undefined;
      for (let attempt = 0; attempt < 80; attempt++) {
        try {
          response = await fetch(
            `http://127.0.0.1:${String(port)}/v1/fixture`,
            {
              headers: {
                "X-Forwarded-Host": "hostile.example.com",
                Forwarded: "host=hostile.example.com",
              },
              signal: AbortSignal.timeout(1000),
            },
          );
          break;
        } catch {
          await delay(100);
        }
      }
      expect(response?.status).toBe(200);
      const data: unknown = await response?.json();
      expect(data).toEqual({
        canonicalOrigin: origin,
        retained: "retained-local-only",
      });
      const call = (requested: string, host?: string) =>
        fetch(
          `http://127.0.0.1:${String(port)}/v1/fixture?origin=${encodeURIComponent(requested)}${host ? `&host=${encodeURIComponent(host)}` : ""}`,
          { signal: AbortSignal.timeout(3000) },
        );
      if (origin === canonicalOrigin) {
        const customResponse = await call(canonicalOrigin);
        const customData: unknown = await customResponse.json();
        expect(customResponse.status).toBe(200);
        expect(customData).toEqual({
          canonicalOrigin,
          retained: "retained-local-only",
        });
      }
      expect((await call("https://hostile.example.com")).status).toBe(400);
      expect(
        (await call(identity.defaultOrigin, "hostile.example.com")).status,
      ).toBe(400);
      await stop();
    }
  } finally {
    await stop();
    await rm(state, { recursive: true, force: true });
  }
}, 90000);
