// Production root entry. No automatic credential lookup, remote transport or
// unsupported Builds attestation. Provider adapters are parent qualification
// scope; WO34 retains adapter implementation. Denial occurs before adapter
// construction or subprocesses.
import { Effect, Either } from "effect";
import { resolve } from "node:path";
import { ownerEntryAuthorization, deniedOwnerAccess } from "./owner-handoff.js";
import { failure, recovery } from "./model.js";
import {
  deniedEntry,
  entryCommand,
  EntryAuthorization,
  EntryAdapters,
} from "./release-entry-command.js";
const owner = ownerEntryAuthorization(
  resolve(import.meta.dirname, "../.."),
  deniedOwnerAccess,
);
const result = await Effect.runPromise(
  Effect.either(
    entryCommand(process.argv.slice(2)).pipe(
      Effect.provideService(EntryAuthorization, {
        admit: (input) =>
          input.mode === "cli" ? owner.admit(input) : deniedEntry.admit(input),
      }),
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
