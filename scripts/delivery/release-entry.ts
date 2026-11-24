// Production root entry. No automatic credential lookup, remote transport or
// unsupported Builds attestation. Provider adapters are parent qualification
// scope; denial is real and occurs before adapter construction or subprocesses.
import { Effect, Either } from "effect";
import { failure, recovery } from "./model.js";
import {
  deniedEntry,
  entryCommand,
  EntryAuthorization,
  EntryAdapters,
} from "./release-entry-command.js";
const result = await Effect.runPromise(
  Effect.either(
    entryCommand(process.argv.slice(2)).pipe(
      Effect.provideService(EntryAuthorization, deniedEntry),
      Effect.provideService(EntryAdapters, {
        prepare: () =>
          Effect.fail(
            failure("authorization", "release-adapters-unconfigured"),
          ),
      }),
    ),
  ),
);
if (Either.isLeft(result)) {
  console.error(
    JSON.stringify({
      status: "installation-not-completed",
      stage: result.left.stage,
      code: result.left.code,
      recovery: recovery[result.left.stage],
      provider: "not-run",
    }),
  );
  process.exitCode = 1;
} else console.log(JSON.stringify(result.right));
