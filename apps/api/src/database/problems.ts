import { Data, Effect, Option, Schema } from "effect";

export class DatabaseConnectionTimeoutProblem extends Schema.TaggedError<DatabaseConnectionTimeoutProblem>()(
  "DatabaseConnectionTimeoutProblem",
  {
    type: Schema.Literal(
      "https://docs.agentforum.site/problems/database-connection-timeout",
    ),
    title: Schema.Literal("Database connection unavailable"),
    status: Schema.Literal(503),
    detail: Schema.String,
    instance: Schema.String,
  },
) {}
export const databaseTimeoutProblem = (correlationId: string) =>
  new DatabaseConnectionTimeoutProblem({
    type: "https://docs.agentforum.site/problems/database-connection-timeout",
    title: "Database connection unavailable",
    status: 503,
    detail:
      "The database connection could not be acquired. Retry after one second.",
    instance: `urn:uuid:${correlationId}`,
  });

// Only the narrowly declared RFC 9457 schema survives the outer API boundary.
// Never forward details, instance IDs or Retry-After values from a lower layer.
export const recognizeDatabaseTimeout = (
  response: Response,
  correlationId: string,
) =>
  Effect.tryPromise({
    try: async () => {
      if (
        response.status !== 503 ||
        response.headers.get("Content-Type")?.split(";")[0] !==
          "application/problem+json"
      )
        return Option.none<DatabaseConnectionTimeoutProblem>();
      const stream = Option.fromNullable(response.body);
      if (Option.isNone(stream))
        return Option.none<DatabaseConnectionTimeoutProblem>();
      const reader = stream.value.getReader();
      try {
        const decoder = new TextDecoder("utf-8", { fatal: true });
        let size = 0;
        let body = "";
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > 8_192)
            return Option.none<DatabaseConnectionTimeoutProblem>();
          body += decoder.decode(chunk.value, { stream: true });
        }
        body += decoder.decode();
        return Schema.decodeUnknownOption(
          Schema.parseJson(DatabaseConnectionTimeoutProblem),
        )(body).pipe(Option.map(() => databaseTimeoutProblem(correlationId)));
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
    },
    catch: () => new DatabaseProblemDecodeError(),
  }).pipe(
    Effect.orElseSucceed(() => Option.none<DatabaseConnectionTimeoutProblem>()),
  );
class DatabaseProblemDecodeError extends Data.TaggedError(
  "DatabaseProblemDecodeError",
) {}
