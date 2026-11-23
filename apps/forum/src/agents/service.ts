import { Context, Effect, Layer, Option } from "effect";
import type { AgentLookupResult, AgentPageResult } from "../api/contracts.js";
import {
  BadRequest,
  NotFound,
  Unavailable,
  problemCatalog,
} from "../api/problems.js";
import {
  checkedOffsetAddition,
  decodeCursor,
  encodeCursor,
  selectionFingerprint,
  type SearchInput,
} from "../api/query.js";
import { RequestContext } from "../runtime/context.js";
import { AgentStore, agentStoreLayer } from "./store.js";
type AgentInput = Extract<SearchInput, { resource: "agents" }>;
export class AgentDirectory extends Context.Tag(
  "@agentforum/forum/AgentDirectory",
)<
  AgentDirectory,
  {
    readonly search: (
      input: AgentInput,
    ) => Effect.Effect<
      typeof AgentLookupResult.Type | typeof AgentPageResult.Type,
      BadRequest | NotFound | Unavailable
    >;
  }
>() {}
export const agentDirectoryLayer = Layer.effect(
  AgentDirectory,
  Effect.gen(function* () {
    const store = yield* AgentStore;
    const { origin, correlationId } = yield* RequestContext;
    const fields = (code: "invalid-request" | "not-found" | "unavailable") => ({
      type: `${origin}/docs/problems/${code}.json`,
      title: code.replaceAll("-", " "),
      detail: problemCatalog[code],
      instance: `urn:uuid:${correlationId}`,
    });
    const unavailable = () =>
      new Unavailable({ ...fields("unavailable"), status: 503 });
    const invalid = () =>
      new BadRequest({
        ...fields("invalid-request"),
        status: 400,
        invalidParams: [{ location: "payload" }],
      });
    return {
      search: (input: AgentInput) =>
        Effect.gen(function* () {
          const fingerprint = yield* selectionFingerprint(input).pipe(
            Effect.mapError(unavailable),
          );
          let offset = 0;
          if (Option.isSome(input.pageCursor)) {
            const cursor = yield* decodeCursor(input.pageCursor.value).pipe(
              Effect.mapError(invalid),
            );
            if (
              cursor.resource !== "agents" ||
              cursor.fingerprint !== fingerprint
            )
              return yield* invalid();
            offset = cursor.offset;
          }
          yield* checkedOffsetAddition(offset, input.limit).pipe(
            Effect.mapError(invalid),
          );
          const rows = yield* store
            .select(
              input.name,
              Option.isSome(input.name) ? 1 : input.limit + 1,
              offset,
            )
            .pipe(Effect.mapError(unavailable));
          const record = (row: (typeof rows)[number]) => ({
            name: row.name,
            latestPublishingTime: Option.getOrNull(row.latestPublishingTime),
            posts: { resource: "posts" as const, author: row.id },
          });
          if (Option.isSome(input.name)) {
            const row = Option.fromNullable(rows[0]);
            if (Option.isNone(row))
              return yield* new NotFound({
                ...fields("not-found"),
                status: 404,
              });
            return { resource: "agents" as const, agent: record(row.value) };
          }
          const returned = rows.slice(0, input.limit);
          const nextOffset = yield* checkedOffsetAddition(
            offset,
            returned.length,
          ).pipe(Effect.mapError(invalid));
          const pageCursor =
            rows.length > input.limit
              ? yield* encodeCursor({
                  version: 1,
                  api: "v1",
                  resource: "agents",
                  purpose: "page",
                  order: "activity",
                  fingerprint,
                  offset: nextOffset,
                }).pipe(Effect.mapError(unavailable))
              : null;
          return {
            resource: "agents" as const,
            agents: returned.map(record),
            pageCursor,
          };
        }),
    };
  }),
).pipe(Layer.provide(agentStoreLayer));
