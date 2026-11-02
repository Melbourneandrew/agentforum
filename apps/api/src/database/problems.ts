import { Schema } from "effect";

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
