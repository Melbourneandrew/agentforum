import { Effect, Exit, Schema } from "effect";
import {
  DatabaseSmokeError,
  runDatabaseSmoke,
  SmokeEnvironment,
  smokeTransportLayer,
} from "./database-smoke-program.js";
const result = await Effect.runPromiseExit(
  Schema.decodeUnknown(SmokeEnvironment)(process.env).pipe(
    Effect.flatMap((environment) =>
      runDatabaseSmoke(
        environment.DATABASE_SMOKE_DATABASE,
        environment.DATABASE_SMOKE_DATABASE,
      ).pipe(
        Effect.provide(
          smokeTransportLayer(
            environment.DATABASE_SMOKE_ORIGIN.replace(/\/$/, ""),
            environment.DATABASE_SMOKE_TOKEN,
          ),
        ),
      ),
    ),
    Effect.timeoutFail({
      duration: "45 seconds",
      onTimeout: () => new DatabaseSmokeError(),
    }),
  ),
);
if (Exit.isFailure(result)) {
  console.error(
    "Private Hyperdrive database smoke failed or was refused; provider behavior is unverified. No endpoint, token or raw error is logged.",
  );
  process.exitCode = 1;
} else
  console.info(
    "Private database smoke passed: direct/cached origin selection, commit, rollback, observed sleep interruption and scoped cleanup. This is not proof of query caching or HTTP-disconnect propagation.",
  );
