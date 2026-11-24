import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Effect, Either } from "effect";
import { describe, expect, it } from "vitest";
import {
  deniedEntry,
  entryCommand,
  EntryAdapters,
  EntryAuthorization,
} from "./release-entry-command.js";
const denied = (args: readonly string[]) =>
  Effect.runPromise(
    Effect.either(
      entryCommand(args).pipe(
        Effect.provideService(EntryAuthorization, deniedEntry),
        Effect.provideService(EntryAdapters, {
          prepare: () =>
            Effect.die("must not construct provider/DB/subprocess"),
        }),
      ),
    ),
  );
describe("actual root release admission (no provider authority inferred)", () => {
  for (const mode of ["native", "cli"])
    it(`denies ${mode} before adapter access`, async () => {
      const result = await denied([
        mode,
        mode === "native" ? "--resolved-config" : "--identity",
        "/unreadable/never-read",
      ]);
      expect(Either.isLeft(result) && result.left.stage).toBe("authorization");
    });
  for (const args of [
    ["--confirm-quiescent"],
    ["native", "--identity", "foreign"],
    ["cli", "--resolved-config", "foreign"],
    ["native", "--operation", "reset"],
    ["--remote"],
  ])
    it(`rejects unsupported or recovery-bypass arguments ${JSON.stringify(args)}`, async () => {
      const result = await denied(args);
      expect(Either.isLeft(result) && result.left.code).toBe(
        "release-entry-arguments-invalid",
      );
    });
  it("real root native/CLI subprocesses ignore ambient credential/CI guesses and emit only sanitized denial", () => {
    for (const mode of ["native", "cli"]) {
      const output = spawnSync(
        process.execPath,
        [
          "--import",
          import.meta.resolve("tsx"),
          fileURLToPath(new URL("./release-entry.ts", import.meta.url)),
          mode,
          mode === "native" ? "--resolved-config" : "--identity",
          "/no-such-file",
        ],
        {
          cwd: process.cwd(),
          env: {
            PATH: process.env.PATH,
            CI: "true",
            WORKERS_CI: "1",
            CLOUDFLARE_API_TOKEN: "sensitive-sentinel-never-read",
            CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
          },
          encoding: "utf8",
          timeout: 10000,
        },
      );
      expect(output.status).toBe(1);
      expect(output.stdout).toBe("");
      expect(output.stderr).not.toContain("sensitive-sentinel");
      expect(JSON.parse(output.stderr)).toMatchObject({
        status: "installation-not-completed",
        stage: "authorization",
        provider: "not-run",
      });
    }
  });
});
