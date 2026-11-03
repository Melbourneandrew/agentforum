import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { Data, Effect, Option, Schema } from "effect";
class OwnedProcessError extends Data.TaggedError("OwnedProcessError") {}
const missing = Schema.Struct({ code: Schema.Literal("ESRCH") });
const signalGroup = (pid: number, signal: NodeJS.Signals) => {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!Schema.is(missing)(error)) throw new OwnedProcessError();
  }
};
export const ownedProcess = (
  command: string,
  args: readonly string[],
  options: {
    readonly environment: Readonly<Record<string, string>>;
    readonly output: "inherit" | "capture";
  },
) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const child = spawn(command, [...args], {
        detached: true,
        stdio:
          options.output === "inherit" ? "inherit" : ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...options.environment },
      });
      let stdout = "";
      let stderr = "";
      let bytes = 0;
      let overflow = false;
      const out = new StringDecoder("utf8");
      const err = new StringDecoder("utf8");
      const completion = new Promise<{
        readonly code: number;
        readonly signal: Option.Option<NodeJS.Signals>;
        readonly stdout: string;
        readonly stderr: string;
        readonly overflow: boolean;
      }>((done) => {
        const collect = (chunk: Buffer, target: "stdout" | "stderr") => {
          bytes += chunk.byteLength;
          if (bytes > 8 * 1024 * 1024) {
            overflow = true;
            done({
              code: 1,
              signal: Option.none(),
              stdout: "",
              stderr: "",
              overflow: true,
            });
            return;
          }
          if (target === "stdout") stdout += out.write(chunk);
          else stderr += err.write(chunk);
        };
        child.stdout?.on("data", (chunk: Buffer) => {
          collect(chunk, "stdout");
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          collect(chunk, "stderr");
        });
        child.once("error", () => {
          done({
            code: 1,
            signal: Option.none(),
            stdout: "",
            stderr: "",
            overflow,
          });
        });
        child.once("close", (code, signal) => {
          done({
            code: code ?? 1,
            signal: Option.fromNullable(signal),
            stdout: stdout + out.end(),
            stderr: stderr + err.end(),
            overflow,
          });
        });
      });
      return { child, completion };
    }),
    (lease) =>
      Effect.tryPromise({
        try: async () => {
          const pid = lease.child.pid;
          if (pid === undefined) return;
          signalGroup(pid, "SIGTERM");
          await new Promise<void>((done) => {
            const timer = setTimeout(done, 3_000);
            void lease.completion.then(() => {
              clearTimeout(timer);
              done();
            });
          });
          // The leader may exit before a descendant. Always terminate the whole owned
          // group, never only pnpm, and never leave a TERM-resistant child behind.
          signalGroup(pid, "SIGKILL");
        },
        catch: () => new OwnedProcessError(),
      }).pipe(Effect.orDie),
  );
