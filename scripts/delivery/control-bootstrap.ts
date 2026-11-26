import { Context, Effect, Schema } from "effect";
import { failure, type DeliveryError } from "./model.js";
import {
  CONTROL_FILE,
  CONTROL_HISTORY,
  CONTROL_TABLE,
  CONTROL_V1_SHA256,
  ControlDatabase,
  hashControl,
  NATIVE_HISTORY_SQL,
} from "./release-control.js";

export class NativeControlMigrations extends Context.Tag(
  "delivery/NativeControlMigrations",
)<
  NativeControlMigrations,
  {
    readonly v1: string;
    // Must invoke native Wrangler on a frozen one-file, non-activation config view.
    readonly applyV1: Effect.Effect<void, DeliveryError>;
  }
>() {}
const normalize = (sql: string) =>
  sql
    .replace(/\bIF NOT EXISTS\s+/g, "")
    .trim()
    .replace(/;$/, "")
    .replace(/\s+/g, " ");
const Master = Schema.Array(
  Schema.Struct({
    name: Schema.String,
    type: Schema.String,
    tbl_name: Schema.String,
    sql: Schema.NullOr(Schema.String),
  }),
);
export const verifyControlBootstrap = () =>
  Effect.gen(function* () {
    const db = yield* ControlDatabase;
    const native = yield* NativeControlMigrations;
    if ((yield* hashControl(native.v1)) !== CONTROL_V1_SHA256)
      return yield* Effect.fail(
        failure("initialization", "control-v1-bytes-mismatch"),
      );
    const rows = yield* db
      .query(
        `SELECT name,type,tbl_name,sql FROM sqlite_master WHERE tbl_name IN (?,?) ORDER BY name`,
        [CONTROL_TABLE, CONTROL_HISTORY],
      )
      .pipe(
        Effect.flatMap(Schema.decodeUnknown(Master)),
        Effect.mapError(() =>
          failure("initialization", "control-schema-unreadable"),
        ),
      );
    const table = rows.find((row) => row.name === CONTROL_TABLE);
    const history = rows.find((row) => row.name === CONTROL_HISTORY);
    // Partial initialization is not silently repaired. A concurrent canonical
    // bootstrap is convergent; a failed/ambiguous candidate stops before acquire.
    if (!table && !history && !rows.length) return false;
    if (
      !table?.sql ||
      !history?.sql ||
      table.type !== "table" ||
      history.type !== "table" ||
      normalize(table.sql) !== normalize(native.v1) ||
      normalize(history.sql) !== normalize(NATIVE_HISTORY_SQL) ||
      rows.some(
        (row) =>
          row.type !== "table" &&
          !(
            row.type === "index" &&
            row.sql === null &&
            row.name === `sqlite_autoindex_${CONTROL_HISTORY}_1`
          ),
      )
    )
      return yield* Effect.fail(
        failure("initialization", "control-schema-mismatch"),
      );
    const applied = yield* db
      .query(`SELECT name FROM ${CONTROL_HISTORY} ORDER BY id`, [])
      .pipe(
        Effect.flatMap(
          Schema.decodeUnknown(
            Schema.Array(Schema.Struct({ name: Schema.String })),
          ),
        ),
        Effect.mapError(() =>
          failure("initialization", "control-history-unreadable"),
        ),
      );
    if (applied.length !== 1 || applied[0]?.name !== CONTROL_FILE)
      return yield* Effect.fail(
        failure("initialization", "control-native-history-mismatch"),
      );
    return true;
  });
export const bootstrapControl = () =>
  Effect.gen(function* () {
    if (yield* verifyControlBootstrap()) return;
    const native = yield* NativeControlMigrations;
    yield* native.applyV1.pipe(
      Effect.mapError(() =>
        failure("initialization", "control-bootstrap-unknown-stop"),
      ),
    );
    if (!(yield* verifyControlBootstrap()))
      return yield* Effect.fail(
        failure("initialization", "control-bootstrap-not-committed"),
      );
  });
