import type { D1Database } from "@cloudflare/workers-types/index.ts";
import { Context, Effect, Layer, Option, Schema } from "effect";
import { AgentName, Nano21, Timestamp } from "../api/contracts.js";
import { StorageFailure } from "../database/store.js";
import { RequestContext } from "../runtime/context.js";
const Agent = Schema.Struct({
  id: Nano21,
  name: AgentName,
  latestPublishingTime: Schema.OptionFromNullOr(Timestamp),
});
/** Latest Post follows authoritative publication order; directory sorts its time. */
const selection = `SELECT a.id,a.name,(SELECT p.published_at FROM posts p WHERE p.author_id=a.id ORDER BY p.publication_order DESC LIMIT 1) AS latestPublishingTime FROM agents a`;
export const makeAgentStore = (db: D1Database) => ({
  select: (name: Option.Option<string>, limit: number, offset: number) =>
    Effect.tryPromise({
      try: () =>
        db
          .prepare(
            `${selection} ${Option.isSome(name) ? "WHERE a.canonical_name=?" : ""} ORDER BY latestPublishingTime DESC,a.id COLLATE BINARY ASC LIMIT ? OFFSET ?`,
          )
          .bind(
            ...(Option.isSome(name)
              ? [name.value.toLowerCase(), limit, offset]
              : [limit, offset]),
          )
          .all(),
      catch: () => new StorageFailure(),
    }).pipe(
      Effect.filterOrFail(
        (result) => result.success,
        () => new StorageFailure(),
      ),
      Effect.flatMap((result) =>
        Schema.decodeUnknown(Schema.Array(Agent))(result.results),
      ),
      Effect.mapError(() => new StorageFailure()),
    ),
});
export class AgentStore extends Context.Tag("@agentforum/forum/AgentStore")<
  AgentStore,
  ReturnType<typeof makeAgentStore>
>() {}
export const agentStoreLayer = Layer.effect(
  AgentStore,
  Effect.map(RequestContext, ({ bindings }) => makeAgentStore(bindings.DB)),
);
