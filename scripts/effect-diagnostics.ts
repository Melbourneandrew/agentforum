import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Context, Data, Effect, Layer, Schema } from "effect";

export class EffectDiagnosticGateError extends Data.TaggedError(
  "EffectDiagnosticGateError",
) {}
const Count = Schema.Int.pipe(Schema.nonNegative());
const Position = Schema.Int.pipe(Schema.positive());
export const DiagnosticReport = Schema.parseJson(
  Schema.Struct({
    diagnostics: Schema.Array(
      Schema.Struct({
        file: Schema.String,
        start: Count,
        length: Count,
        line: Position,
        column: Position,
        endLine: Position,
        endColumn: Position,
        severity: Schema.Literal("error", "warning", "message"),
        code: Schema.Int,
        name: Schema.NonEmptyString,
        message: Schema.String,
      }),
    ),
    summary: Schema.Struct({
      filesChecked: Count,
      totalFiles: Count,
      errors: Count,
      warnings: Count,
      messages: Count,
    }),
  }),
);
export const isCleanDiagnosticReport = (
  report: Schema.Schema.Type<typeof DiagnosticReport>,
) =>
  report.diagnostics.length === 0 &&
  report.summary.errors === 0 &&
  report.summary.warnings === 0 &&
  report.summary.messages === 0 &&
  report.summary.filesChecked > 0 &&
  report.summary.filesChecked === report.summary.totalFiles;

export class EffectDiagnosticCli extends Context.Tag(
  "@agentforum/tooling/EffectDiagnosticCli",
)<
  EffectDiagnosticCli,
  {
    readonly run: (project: string) => Effect.Effect<
      {
        readonly code: number;
        readonly stdout: string;
        readonly stderr: string;
      },
      EffectDiagnosticGateError
    >;
  }
>() {}
export const nativeEffectDiagnosticCli = Layer.succeed(EffectDiagnosticCli, {
  run: (project) =>
    Effect.try({
      try: () => {
        // Execute the real pinned CLI directly, not a shell/PATH-selected substitute.
        const cli = fileURLToPath(
          import.meta.resolve("@effect/language-service/cli.js"),
        );
        const result = spawnSync(
          process.execPath,
          [
            cli,
            "diagnostics",
            "--strict",
            "--format",
            "json",
            "--project",
            project,
          ],
          { encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024 },
        );
        if (result.error || result.signal !== null || result.status === null)
          throw new EffectDiagnosticGateError();
        return {
          code: result.status,
          stdout: result.stdout,
          stderr: result.stderr,
        };
      },
      catch: () => new EffectDiagnosticGateError(),
    }),
});
export const checkEffectDiagnostics = (project: string) =>
  Effect.gen(function* () {
    const cli = yield* EffectDiagnosticCli;
    const result = yield* cli.run(project);
    // Preserve the tool's actual diagnostics. The wrapper changes pass/fail policy,
    // never the diagnostic severity, source, config or visibility.
    yield* Effect.sync(() => {
      process.stdout.write(result.stdout);
      process.stderr.write(result.stderr);
    });
    const report = yield* Schema.decodeUnknown(DiagnosticReport)(
      result.stdout,
    ).pipe(Effect.mapError(() => new EffectDiagnosticGateError()));
    yield* Effect.filterOrFail(
      Effect.succeed(report),
      (value) => result.code === 0 && isCleanDiagnosticReport(value),
      () => new EffectDiagnosticGateError(),
    );
  });
