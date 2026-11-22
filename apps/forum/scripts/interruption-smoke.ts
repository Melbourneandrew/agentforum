import { connect } from "node:net";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { setTimeout } from "node:timers/promises";

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  const before = new Set(await readdir(tmpdir()));
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "scripts/bundle-smoke.ts"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  let sent = false;
  const observe = (chunk: Buffer) => {
    output += chunk.toString();
    if (!sent && output.includes("production_smoke_browser_started")) {
      sent = true;
      child.kill(signal);
      // Exercise wrappers forwarding a second signal during asynchronous cleanup.
      const timer = globalThis.setTimeout(() => {
        child.kill(signal);
      }, 20);
      timer.unref();
    }
  };
  child.stdout.on("data", observe);
  child.stderr.on("data", observe);
  try {
    await once(child, "exit", { signal: AbortSignal.timeout(30_000) });
    assert.ok(sent, `Did not observe actual browser startup: ${output}`);
    assert.notEqual(
      child.exitCode,
      0,
      "Interrupted smoke must not report success",
    );
    await setTimeout(100);
    const remaining = (await readdir(tmpdir())).filter(
      (name) => name.startsWith("agent-forum-runtime-") && !before.has(name),
    );
    assert.deepEqual(remaining, [], "Interrupted smoke left owned D1 state");
    const listening = await new Promise<boolean>((resolve) => {
      const socket = connect({ host: "127.0.0.1", port: 8792 });
      socket.setTimeout(500);
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => {
        resolve(false);
      });
      socket.once("timeout", () => {
        socket.destroy();
        resolve(false);
      });
    });
    assert.equal(
      listening,
      false,
      "Interrupted smoke left its TCP listener running",
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  }
}
console.log(
  "Real Chromium/workerd/D1 interruption cleanup passed for SIGINT and SIGTERM, including repeated signals.",
);
