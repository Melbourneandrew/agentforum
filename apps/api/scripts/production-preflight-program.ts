import { Client } from "pg";
import { Context, Data, Effect, Layer, Redacted, Schema } from "effect";

export const productionAccount = "e257374af7c5cd7179f4b237dd28c5c7";
export const productionZone = "7dd7d0797135979d4bccb4c1181cdb3d";
const migrationUri = Schema.String.pipe(
  Schema.filter((value) => {
    try {
      const uri = new URL(value);
      return (
        uri.protocol === "postgresql:" &&
        uri.hostname ===
          "ep-misty-frog-bcjau72l.c-16.us-east-1.aws.neon.tech" &&
        uri.port === "5432" &&
        uri.pathname === "/neondb" &&
        uri.username === "agentforum_migrator" &&
        uri.password.length > 0 &&
        uri.search === "?sslmode=verify-full" &&
        uri.hash === ""
      );
    } catch {
      return false;
    }
  }),
);
export const ProductionEnvironment = Schema.Struct({
  GITHUB_ACTIONS: Schema.Literal("true"),
  GITHUB_REPOSITORY: Schema.Literal("Melbourneandrew/agentforum"),
  GITHUB_REF: Schema.Literal("refs/heads/main"),
  CLOUDFLARE_ACCOUNT_ID: Schema.Literal(productionAccount),
  CLOUDFLARE_API_TOKEN: Schema.Redacted(Schema.NonEmptyString),
  MIGRATION_DATABASE_URL: Schema.Redacted(migrationUri),
});
export class ProductionPreflightError extends Data.TaggedError(
  "ProductionPreflightError",
)<{
  readonly stage: "configuration" | "cloudflare" | "database";
}> {}

const TokenResult = Schema.Struct({
  success: Schema.Literal(true),
  result: Schema.Struct({
    status: Schema.Literal("active"),
    expires_on: Schema.String.pipe(
      Schema.pattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
    ),
  }),
});
const ZoneResult = Schema.Struct({
  success: Schema.Literal(true),
  result: Schema.Struct({
    id: Schema.Literal(productionZone),
    name: Schema.Literal("agentforum.site"),
    status: Schema.Literal("active"),
  }),
});
export const MigrationIdentity = Schema.Tuple(
  Schema.Struct({
    database: Schema.Literal("neondb"),
    role: Schema.Literal("agentforum_migrator"),
    superuser: Schema.Literal(false),
    create_role: Schema.Literal(false),
    create_database: Schema.Literal(false),
    replication: Schema.Literal(false),
    bypass_rls: Schema.Literal(false),
    neon_admin: Schema.Literal(false),
    database_create: Schema.Literal(true),
    schema_create: Schema.Literal(true),
  }),
);
export class ProductionPreflight extends Context.Tag(
  "@agentforum/tooling/ProductionPreflight",
)<
  ProductionPreflight,
  {
    readonly cloudflare: (
      token: Redacted.Redacted,
    ) => Effect.Effect<string, ProductionPreflightError>;
    readonly database: (
      uri: Redacted.Redacted,
    ) => Effect.Effect<void, ProductionPreflightError>;
  }
>() {}

const cloudflareJson = (path: string, token: Redacted.Redacted) =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(
        `https://api.cloudflare.com/client/v4${path}`,
        {
          headers: { Authorization: `Bearer ${Redacted.value(token)}` },
          signal: AbortSignal.timeout(15_000),
          redirect: "error",
        },
      );
      if (!response.ok || !response.body) throw new Error("Provider refused");
      const reader = response.body.getReader();
      let content = "";
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let bytes = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > 16_384) throw new Error("Provider response too large");
          content += decoder.decode(part.value, { stream: true });
        }
        content += decoder.decode();
        const value: unknown = JSON.parse(content);
        return value;
      } finally {
        await reader.cancel();
      }
    },
    catch: () => new ProductionPreflightError({ stage: "cloudflare" }),
  });

export const nativeProductionPreflight = Layer.succeed(ProductionPreflight, {
  cloudflare: (token) =>
    Effect.gen(function* () {
      const verified = yield* cloudflareJson(
        `/accounts/${productionAccount}/tokens/verify`,
        token,
      ).pipe(Effect.flatMap(Schema.decodeUnknown(TokenResult)));
      yield* cloudflareJson(`/zones/${productionZone}`, token).pipe(
        Effect.flatMap(Schema.decodeUnknown(ZoneResult)),
      );
      return verified.result.expires_on;
    }).pipe(
      Effect.mapError(
        () => new ProductionPreflightError({ stage: "cloudflare" }),
      ),
    ),
  database: (uri) =>
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* Effect.acquireRelease(
          Effect.sync(
            () =>
              new Client({
                connectionString: Redacted.value(uri),
                connectionTimeoutMillis: 15_000,
                query_timeout: 15_000,
                statement_timeout: 15_000,
                options: "-c default_transaction_read_only=on",
              }),
          ),
          (client) => Effect.promise(() => client.end()),
        );
        yield* Effect.tryPromise(() => client.connect());
        const result = yield* Effect.tryPromise(() =>
          client.query<Record<string, unknown>>(`
            SELECT current_database() AS database, current_user AS role,
              rolsuper AS superuser, rolcreaterole AS create_role,
              rolcreatedb AS create_database, rolreplication AS replication,
              rolbypassrls AS bypass_rls,
              pg_has_role(current_user, 'neon_superuser', 'MEMBER') AS neon_admin,
              has_database_privilege(current_user, 'neondb', 'CREATE') AS database_create,
              has_schema_privilege(current_user, 'public', 'CREATE') AS schema_create
            FROM pg_roles WHERE rolname = current_user
          `),
        );
        yield* Schema.decodeUnknown(MigrationIdentity)(result.rows);
      }),
    ).pipe(
      Effect.mapError(
        () => new ProductionPreflightError({ stage: "database" }),
      ),
    ),
});

export const verifyProductionCredentials = (environment: unknown) =>
  Effect.gen(function* () {
    const config = yield* Schema.decodeUnknown(ProductionEnvironment)(
      environment,
    ).pipe(
      Effect.mapError(
        () => new ProductionPreflightError({ stage: "configuration" }),
      ),
    );
    const preflight = yield* ProductionPreflight;
    const expiresOn = yield* preflight.cloudflare(config.CLOUDFLARE_API_TOKEN);
    yield* preflight.database(config.MIGRATION_DATABASE_URL);
    return expiresOn;
  });
