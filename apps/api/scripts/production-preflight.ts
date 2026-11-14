import { Effect } from "effect";
import {
  nativeProductionPreflight,
  verifyProductionCredentials,
} from "./production-preflight-program.js";

await Effect.runPromise(
  verifyProductionCredentials(process.env).pipe(
    Effect.provide(nativeProductionPreflight),
    Effect.match({
      onFailure: (error) => {
        console.error(`Production credential preflight failed: ${error.stage}`);
        process.exitCode = 1;
      },
      onSuccess: (expiresOn) => {
        console.log(
          `Verified active Cloudflare token (expires ${expiresOn}), target zone, and dedicated direct Neon migration identity with restricted privileges. No migrations or deployments performed.`,
        );
      },
    }),
    Effect.catchAllCause(() =>
      Effect.sync(() => {
        console.error("Production credential preflight failed unexpectedly");
        process.exitCode = 1;
      }),
    ),
  ),
);
