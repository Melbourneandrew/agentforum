import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { gzipSync } from "node:zlib";
import { Schema } from "effect";
import {
  HealthResponse,
  NotFoundProblem,
  ValidationProblem,
} from "../src/contract.js";
import { InputProblem } from "../src/input/transport.js";
import { AuthenticationProblem } from "../src/publication/contract.js";

// Worker's free-plan compressed script ceiling, not a claim of production capacity.
assert.ok(
  gzipSync(await readFile("dist/worker.js")).byteLength <= 3 * 1024 * 1024,
  "Worker exceeds the 3 MiB compressed bundle limit",
);
const server = spawn(
  "pnpm",
  [
    "exec",
    "wrangler",
    "dev",
    "dist/worker.js",
    "--no-bundle",
    "--local",
    "--ip",
    "127.0.0.1",
    "--port",
    "8790",
  ],
  {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  },
);
let log = "";
server.stdout.on("data", (chunk: Buffer) => {
  log += chunk.toString();
});
server.stderr.on("data", (chunk: Buffer) => {
  log += chunk.toString();
});
const url = "http://127.0.0.1:8790";
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null)
      throw new Error(`Local runtime exited: ${log}`);
    try {
      const response = await fetch(`${url}/v1/health`, {
        signal: AbortSignal.timeout(500),
      });
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      /* The local process may still be starting. */
    }
    await setTimeout(100);
  }
  assert.ok(ready, `Local bundle failed to become ready: ${log}`);
  const response = await fetch(`${url}/v1/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(
    Schema.decodeUnknownSync(HealthResponse)(await response.json()),
    { status: "ok" },
  );
  const invalid = await fetch(`${url}/v1/health?unexpected=secret`);
  assert.equal(invalid.status, 400);
  assert.equal(
    Schema.decodeUnknownSync(ValidationProblem)(await invalid.json()).status,
    400,
  );
  const absent = await fetch(`${url}/v1/publish-not-implemented`);
  assert.equal(absent.status, 404);
  assert.equal(
    Schema.decodeUnknownSync(NotFoundProblem)(await absent.json()).status,
    404,
  );
  const invalidPublication = await fetch(`${url}/v1/publish`);
  assert.equal(invalidPublication.status, 400);
  assert.equal(
    Schema.decodeUnknownSync(InputProblem)(await invalidPublication.json())
      .canonical,
    "/v1/publish",
  );
  const unauthenticated = await fetch(`${url}/v1/publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ body: "Not authorized for publication" }),
  });
  assert.equal(unauthenticated.status, 401);
  assert.equal(unauthenticated.headers.get("WWW-Authenticate"), "Bearer");
  assert.equal(
    Schema.decodeUnknownSync(AuthenticationProblem)(
      await unauthenticated.json(),
    ).status,
    401,
  );
  for (const path of ["health", "register", "publish", "search"]) {
    for (const method of ["HEAD", "OPTIONS"]) {
      const safe = await fetch(`${url}/v1/${path}`, { method });
      assert.equal(safe.status, method === "OPTIONS" ? 204 : 200);
      assert.equal(await safe.text(), "");
    }
  }
} finally {
  if (server.pid !== undefined) process.kill(-server.pid, "SIGTERM");
  await once(server, "exit");
}
