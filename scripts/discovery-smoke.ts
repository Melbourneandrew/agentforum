import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { verifyDiscoveryParity } from "../packages/discovery-assets/scripts/parity.js";
import { discoverySha256 } from "../packages/discovery-assets/scripts/prepare.js";

const args = process.argv.slice(2);
if (args.length > 0) {
  let bases: URL[];
  try {
    bases = args.map((argument) => new URL(argument));
  } catch {
    throw new Error("Expected three credential-free application HTTP origins");
  }
  await verifyDiscoveryParity(bases);
} else {
  const applications = [
    {
      app: "api",
      port: 8800,
      artifact: "dist/worker.js",
      args: ["dev", "dist/worker.js"],
    },
    {
      app: "web",
      port: 8801,
      artifact: "dist/ssr/wrangler.json",
      args: ["dev", "--config", "dist/ssr/wrangler.json"],
    },
    {
      app: "docs",
      port: 8802,
      artifact: "dist/worker.js",
      args: ["dev", "dist/worker.js"],
    },
  ];
  for (const app of applications)
    await access(`apps/${app.app}/${app.artifact}`);
  const servers = applications.map((app) => {
    const child = spawn(
      "pnpm",
      [
        "exec",
        "wrangler",
        ...app.args,
        "--no-bundle",
        "--local",
        "--ip",
        "127.0.0.1",
        "--port",
        String(app.port),
        "--inspector-port",
        String(app.port + 100),
      ],
      {
        cwd: `apps/${app.app}`,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
      },
    );
    let log = "";
    child.stdout.on("data", (chunk: Buffer) => {
      log += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      log += chunk.toString();
    });
    return {
      child,
      base: new URL(`http://127.0.0.1:${String(app.port)}`),
      log: () => log,
    };
  });
  try {
    for (const server of servers) {
      let ready = false;
      for (let attempt = 0; attempt < 150; attempt++) {
        if (server.child.exitCode !== null)
          throw new Error(`Local discovery runtime exited: ${server.log()}`);
        try {
          if (
            (
              await fetch(new URL("/llms.txt", server.base), {
                signal: AbortSignal.timeout(500),
              })
            ).ok
          ) {
            ready = true;
            break;
          }
        } catch {
          /* startup only */
        }
        await setTimeout(100);
      }
      assert.ok(
        ready,
        `Local shared discovery route was not ready: ${server.log()}`,
      );
    }
    await verifyDiscoveryParity(servers.map((server) => server.base));
  } finally {
    await Promise.all(
      servers.map(async ({ child }) => {
        if (child.pid !== undefined && child.exitCode === null) {
          process.kill(-child.pid, "SIGTERM");
          await once(child, "exit");
        }
      }),
    );
  }
}
console.log(
  `All six unauthenticated shared-guide routes match source SHA-256 ${discoverySha256()}; media types, HEAD and OPTIONS passed`,
);
