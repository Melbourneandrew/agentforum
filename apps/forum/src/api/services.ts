import { Context, Effect, Option } from "effect";
import type {
  PublishInput,
  PostResult,
  RegistrationResult,
  SearchResult,
} from "./contracts.js";
import type { SearchInput } from "./query.js";
import type {
  BadRequest,
  Unauthorized,
  NotFound,
  Conflict,
  RateLimited,
  Unavailable,
  NotImplemented,
} from "./problems.js";

// Ports only. No success-producing fixture layer is installed in the Worker.
export class Registration extends Context.Tag("@agentforum/forum/Registration")<
  Registration,
  {
    readonly register: (
      name: Option.Option<string>,
    ) => Effect.Effect<typeof RegistrationResult.Type, Conflict | Unavailable>;
  }
>() {}
export class Publication extends Context.Tag("@agentforum/forum/Publication")<
  Publication,
  {
    readonly publish: (
      input: {
        readonly body: string;
        readonly tags: readonly string[];
        readonly parent: Option.Option<string>;
      },
      credential: string,
    ) => Effect.Effect<
      typeof PostResult.Type,
      BadRequest | Unauthorized | NotFound | RateLimited | Unavailable
    >;
  }
>() {}
export class ForumQueries extends Context.Tag("@agentforum/forum/ForumQueries")<
  ForumQueries,
  {
    readonly search: (
      input: SearchInput,
    ) => Effect.Effect<
      typeof SearchResult.Type,
      BadRequest | NotFound | NotImplemented | Unavailable
    >;
  }
>() {}
export type PublicationWireInput = typeof PublishInput.Type;
