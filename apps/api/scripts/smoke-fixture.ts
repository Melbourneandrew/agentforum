import { Data, Effect, Exit, Layer, Redacted, Schema } from "effect";
import {
  databaseBindingsLayer,
  directDatabaseLayer,
} from "../src/database/database.js";
import {
  SmokeRole,
  prepareSmokeFixture,
  cleanupSmokeFixture,
} from "./smoke-fixture-program.js";
import { migrationOrigin } from "./migrations.js";
class SmokeFixtureError extends Data.TaggedError("SmokeFixtureError") {}
const Role = Schema.Struct({ DATABASE_SMOKE_RUNTIME_ROLE: SmokeRole });
const result = await Effect.runPromiseExit(
  Effect.gen(function* () {
    const args = yield* Schema.decodeUnknown(
      Schema.Tuple(Schema.Literal("prepare", "cleanup")),
    )(process.argv.slice(2));
    const role = yield* Schema.decodeUnknown(Role)(process.env);
    const url = yield* migrationOrigin(process.env);
    yield* (
      args[0] === "prepare"
        ? prepareSmokeFixture(role.DATABASE_SMOKE_RUNTIME_ROLE)
        : cleanupSmokeFixture
    ).pipe(
      Effect.provide(
        directDatabaseLayer.pipe(
          Layer.provide(
            databaseBindingsLayer({
              HYPERDRIVE_DIRECT: { connectionString: Redacted.value(url) },
              HYPERDRIVE_CACHED: { connectionString: Redacted.value(url) },
            }),
          ),
        ),
      ),
    );
  }).pipe(
    Effect.timeoutFail({
      duration: "30 seconds",
      onTimeout: () => new SmokeFixtureError(),
    }),
  ),
);
if (Exit.isFailure(result)) {
  console.error(
    "Private database fixture operation refused or failed. Authorized Actions origin credentials, explicit runtime role and prepare/cleanup operation are required.",
  );
  process.exitCode = 1;
}
