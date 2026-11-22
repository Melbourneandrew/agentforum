import { Effect } from "effect";
import { InvalidTextQuery, parseTextQuery } from "../api/query.js";
import { hasUnicode61Token } from "./unicode61.js";

/** The shared bounded grammar is authoritative; no raw FTS DSL is accepted. */
export const compileTextQuery = (query: string) =>
  parseTextQuery(query).pipe(
    Effect.filterOrFail(
      (clauses) => clauses.every((clause) => hasUnicode61Token(clause.value)),
      () => new InvalidTextQuery(),
    ),
    Effect.map((clauses) =>
      clauses
        .map(
          ({ value }) =>
            `"${value.replaceAll("\0", " ").replaceAll('"', '""')}"`,
        )
        .join(" AND "),
    ),
  );
