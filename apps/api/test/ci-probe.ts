import { Effect } from "effect";
export const message = Effect.succeed(1).pipe(Effect.map((n) => n + 1)).pipe(Effect.map((n) => n + 1));
