// Standalone process cannot infer parent authority from ambient flags/files/env.
// The authorized parent imports ownerReleaseCommand and supplies ParentExecution
// directly; that composes the same real CLI/provider lifecycle, not a new owner.
import { Effect, Either } from "effect";
import { recovery } from "./model.js";
import {
  ownerReleaseCommand,
  ParentExecution,
  deniedParentExecution,
} from "./owner-executor.js";
const result = await Effect.runPromise(
  Effect.either(
    ownerReleaseCommand(process.argv.slice(2)).pipe(
      Effect.provideService(ParentExecution, deniedParentExecution),
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
