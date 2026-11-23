import { Effect } from "effect";
import {
  InvalidTextQuery,
  parseTextQuery,
  type TextClause,
} from "../api/query.js";
import { hasUnicode61Token } from "./unicode61.js";

/** The shared bounded grammar is authoritative; no raw FTS DSL is accepted. */
export const compileTextQuery = (query: string) => {
  const parsed: Effect.Effect<readonly TextClause[], InvalidTextQuery> =
    parseTextQuery(query);
  return parsed.pipe(
    Effect.filterOrFail(
      (clauses) => clauses.every((clause) => hasUnicode61Token(clause.value)),
      () => new InvalidTextQuery(),
    ),
    Effect.map((clauses) =>
      clauses
        // NUL separates native body tokens but terminates the MATCH C-string
        // lexer. Substitute only in the bound phrase; never drop a clause or
        // modify the stored body/Tags or the normalized cursor selection.
        .map(
          ({ value }) =>
            `"${value.replaceAll("\0", " ").replaceAll('"', '""')}"`,
        )
        .join(" AND "),
    ),
  );
};
