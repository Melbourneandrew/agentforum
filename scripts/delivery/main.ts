import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Effect, Schema } from "effect";
import { command } from "./cli.js";
import { withIdentityFile } from "./identity-file.js";
import { Request, failure, recovery } from "./model.js";
import { cloudflare } from "./provider.js";

const root = resolve(import.meta.dirname, "../..");
const program = command(process.argv.slice(2), {
  readRequest: (path) =>
    Effect.try({
      try: () => readFileSync(path, "utf8"),
      catch: () => failure("configuration", "request-unreadable-or-invalid"),
    }).pipe(
      Effect.flatMap((text) =>
        Schema.decodeUnknown(Schema.parseJson(Request))(text, {
          onExcessProperty: "error",
        }),
      ),
      Effect.mapError(() =>
        failure("configuration", "request-unreadable-or-invalid"),
      ),
    ),
  provider: Effect.suspend(() => {
    const token = process.env.CLOUDFLARE_API_TOKEN;
    if (!token?.trim() || token.trim() !== token)
      return Effect.fail(
        failure("authorization", "scoped-provider-credential-required"),
      );
    return Effect.succeed(cloudflare(fetch, token));
  }),
  withIdentity: (path, use) => withIdentityFile(path, root, use),
  output: (text) => {
    console.log(text);
  },
}).pipe(
  Effect.catchAll((error) =>
    Effect.sync(() => {
      console.error(
        JSON.stringify({
          status: "not-installed",
          stage: error.stage,
          code: error.code,
          recovery: recovery[error.stage],
        }),
      );
      process.exitCode = 1;
    }),
  ),
);
await Effect.runPromise(
  program.pipe(
    Effect.catchAllCause(() =>
      Effect.sync(() => {
        console.error(
          JSON.stringify({
            status: "not-installed",
            stage: "provisioning",
            code: "local-delivery-failed",
            recovery: recovery.provisioning,
          }),
        );
        process.exitCode = 1;
      }),
    ),
  ),
);
