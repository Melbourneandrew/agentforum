import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Data, Effect, Schedule, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { ownedProcess } from "../../scripts/owned-process.js";
class ProcessFixtureNotReady extends Data.TaggedError(
  "ProcessFixtureNotReady",
) {}
describe("owned subprocess groups", () => {
  it("captures split UTF-8 without corrupting output", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const lease = yield* ownedProcess(
            process.execPath,
            [
              "-e",
              "process.stdout.write(Buffer.from([195]));setTimeout(()=>process.stdout.write(Buffer.from([169])),5)",
            ],
            { output: "capture", environment: {} },
          );
          return yield* Effect.promise(() => lease.completion);
        }),
      ),
    );
    expect(result).toMatchObject({ code: 0, stdout: "é", overflow: false });
  });
  it("fails bounded capture before unbounded output can be retained", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const lease = yield* ownedProcess(
            process.execPath,
            [
              "-e",
              "process.stdout.write('x'.repeat(9*1024*1024));setInterval(()=>{},1000)",
            ],
            { output: "capture", environment: {} },
          );
          return yield* Effect.promise(() => lease.completion);
        }),
      ),
    );
    expect(result).toMatchObject({
      code: 1,
      stdout: "",
      stderr: "",
      overflow: true,
    });
  });
  it("kills a TERM-resistant descendant after its leader exits", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "agentforum-process-proof-"),
    );
    try {
      const pidFile = join(directory, "pid");
      const pid = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* ownedProcess(
              process.execPath,
              [
                "-e",
                "const{spawn}=require('node:child_process');spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(process.env.PROBE_PID_FILE,String(process.pid));setInterval(()=>{},1000)\"],{stdio:'ignore'});setInterval(()=>{},1000)",
              ],
              { output: "capture", environment: { PROBE_PID_FILE: pidFile } },
            );
            return yield* Effect.tryPromise({
              try: () => readFile(pidFile, "utf8"),
              catch: () => new ProcessFixtureNotReady(),
            }).pipe(
              Effect.retry({
                times: 100,
                schedule: Schedule.spaced("5 millis"),
              }),
              Effect.flatMap(
                Schema.decodeUnknown(
                  Schema.NumberFromString.pipe(Schema.int(), Schema.positive()),
                ),
              ),
            );
          }),
        ),
      );
      let running = true;
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          const state = await readFile(`/proc/${String(pid)}/stat`, "utf8");
          running =
            state.slice(
              state.lastIndexOf(")") + 2,
              state.lastIndexOf(")") + 3,
            ) !== "Z";
        } catch {
          running = false;
        }
        if (!running) break;
        await new Promise<void>((done) => {
          setTimeout(done, 10);
        });
      }
      expect(running).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
