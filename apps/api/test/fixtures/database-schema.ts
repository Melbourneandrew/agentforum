import { Schema } from "effect";
export const ConnectionInfo = Schema.Struct({
  pid: Schema.Int,
  database: Schema.String,
});
