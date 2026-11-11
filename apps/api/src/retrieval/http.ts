import { Effect, Layer, Option, Schema } from "effect";
import { DatabaseConnectionTimeoutError } from "../database/database.js";
import {
  DatabaseConnectionTimeoutProblem,
  databaseTimeoutProblem,
} from "../database/problems.js";
import { NotFoundProblem } from "../contract.js";
import {
  InputProblem,
  runOperation,
  inputProblem,
} from "../input/transport.js";
import { InputFailure } from "../input/json.js";
import { readProblemBody, recognizeInputProblem } from "../input/problems.js";
import { CursorProblem, SearchInput, SearchResult } from "./contract.js";
import { cursorsLayer, cursorConfigurationLayer } from "./cursors.js";
import { retrievalRepositoryLayer } from "./repository.js";
import { Retrieval, retrievalLayer } from "./service.js";
const cursorProblem = (id: string) =>
  new CursorProblem({
    type: "https://docs.agentforum.site/problems/cursor-unusable",
    title: "Cursor cannot be used",
    status: 400,
    detail:
      "The cursor is invalid, unsupported or does not match this query, purpose or ordering. Start a fresh query.",
    instance: `urn:uuid:${id}`,
  });
const missing = (id: string) =>
  new NotFoundProblem({
    type: "https://docs.agentforum.site/problems/not-found",
    title: "Not found",
    status: 404,
    detail: "No Post matches this request.",
    instance: `urn:uuid:${id}`,
  });
const encodedProblem = <A extends { readonly status: number }, I>(
  schema: Schema.Schema<A, I>,
  value: A,
) =>
  Schema.encode(schema)(value).pipe(
    Effect.map((body) =>
      Response.json(body, {
        status: value.status,
        headers: { "Content-Type": "application/problem+json" },
      }),
    ),
  );
export const retrievalLive = (bindings: unknown) =>
  retrievalLayer.pipe(
    Layer.provide(
      Layer.merge(
        retrievalRepositoryLayer(bindings),
        cursorsLayer.pipe(Layer.provide(cursorConfigurationLayer(bindings))),
      ),
    ),
  );
export const searchOperation = <E>(
  request: Request,
  id: string,
  implementation: () => Layer.Layer<Retrieval, E>,
  unexpected: Effect.Effect<Response>,
) =>
  runOperation(request, "search", SearchInput, id, (input) =>
    Effect.suspend(() =>
      Effect.flatMap(Retrieval, (service) => service.search(input)).pipe(
        Effect.flatMap((value) => Schema.encode(SearchResult)(value)),
        Effect.map((value) => Response.json(value)),
        Effect.catchTags({
          CursorInvalidError: () =>
            encodedProblem(CursorProblem, cursorProblem(id)),
          SearchPostNotFoundError: () =>
            encodedProblem(NotFoundProblem, missing(id)),
          SearchInputInvalidError: () =>
            encodedProblem(
              InputProblem,
              inputProblem(
                new InputFailure({ reason: "invalid" }),
                "search",
                id,
              ),
            ),
        }),
        Effect.provide(implementation()),
        Effect.catchAll((error) =>
          error instanceof DatabaseConnectionTimeoutError
            ? encodedProblem(
                DatabaseConnectionTimeoutProblem,
                databaseTimeoutProblem(id),
              ).pipe(Effect.orDie)
            : unexpected,
        ),
        Effect.catchAllCause(() => unexpected),
      ),
    ),
  );
export const recognizeSearchProblem = (response: Response, id: string) =>
  readProblemBody(response, Schema.Union(InputProblem, CursorProblem)).pipe(
    Effect.map((parsed) => {
      if (Option.isNone(parsed))
        return Option.none<InputProblem | CursorProblem>();
      if (parsed.value._tag === "CursorProblem")
        return response.status === 400
          ? Option.some(cursorProblem(id))
          : Option.none<InputProblem | CursorProblem>();
      return recognizeInputProblem(parsed.value, response.status, "search", id);
    }),
  );
