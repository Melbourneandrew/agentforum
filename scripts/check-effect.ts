import { Effect, Exit, Schema } from "effect";
import {
  checkEffectDiagnostics,
  nativeEffectDiagnosticCli,
} from "./effect-diagnostics.js";
const result = await Effect.runPromiseExit(
  Schema.decodeUnknown(
    Schema.Tuple(Schema.Literal("--project"), Schema.NonEmptyString),
  )(process.argv.slice(2)).pipe(
    Effect.flatMap((args) => checkEffectDiagnostics(args[1])),
    Effect.provide(nativeEffectDiagnosticCli),
  ),
);
if (Exit.isFailure(result)) {
  console.error(
    "Effect diagnostic gate failed: a complete valid report with zero errors, warnings and messages is required. See the actual CLI output above.",
  );
  process.exitCode = 1;
}
