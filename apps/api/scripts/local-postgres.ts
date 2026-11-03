import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  Context,
  Data,
  Effect,
  Layer,
  Redacted,
  Schedule,
  Schema,
} from "effect";

export const postgresImage =
  "postgres@sha256:839fbb5a4942a7758dd93e18b42ea5649807491a0545b5eeeb8f0b8bb11857a5";
export class LocalPostgresError extends Data.TaggedError(
  "LocalPostgresError",
) {}
const exec = promisify(execFile);
class Docker extends Context.Tag("@agentforum/tooling/Docker")<
  Docker,
  {
    readonly run: (
      args: readonly string[],
    ) => Effect.Effect<string, LocalPostgresError>;
  }
>() {}
const dockerLayer = Layer.succeed(Docker, {
  run: (args) =>
    Effect.tryPromise({
      try: (signal) =>
        exec("docker", ["--host", "unix:///var/run/docker.sock", ...args], {
          encoding: "utf8",
          signal,
          timeout: 240_000,
          maxBuffer: 8 * 1024 * 1024,
        }),
      catch: () => new LocalPostgresError(),
    }).pipe(Effect.map((result) => result.stdout)),
});
const Id = Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/));
const Mapping = Schema.parseJson(
  Schema.Tuple(
    Schema.Struct({
      HostIp: Schema.Literal("127.0.0.1"),
      HostPort: Schema.NumberFromString.pipe(
        Schema.int(),
        Schema.between(1, 65535),
      ),
    }),
  ),
);
export const LocalDescriptor = Schema.Struct({
  name: Schema.String.pipe(Schema.pattern(/^agentforum-local-[a-f0-9]{32}$/)),
  id: Id,
  port: Schema.Int.pipe(Schema.between(1, 65535)),
});
type Descriptor = Schema.Schema.Type<typeof LocalDescriptor>;
export class LocalPostgres extends Context.Tag(
  "@agentforum/tooling/LocalPostgres",
)<
  LocalPostgres,
  Descriptor & {
    readonly url: (
      database: "agentforum_local" | "agentforum_direct" | "agentforum_cached",
    ) => Redacted.Redacted;
    readonly execute: (
      sql: string,
      database?:
        | "agentforum_local"
        | "postgres"
        | "agentforum_direct"
        | "agentforum_cached",
    ) => Effect.Effect<string, LocalPostgresError>;
  }
>() {}

const ownedId = (docker: Context.Tag.Service<typeof Docker>, name: string) =>
  docker
    .run([
      "ps",
      "--all",
      "--quiet",
      "--no-trunc",
      "--filter",
      `name=^/${name}$`,
      "--filter",
      `label=site.agentforum.local-scope=${name}`,
    ])
    .pipe(
      Effect.flatMap((value) =>
        Schema.decodeUnknown(Schema.Union(Schema.Literal(""), Id))(
          value.trim(),
        ),
      ),
      Effect.mapError(() => new LocalPostgresError()),
    );

const local = Effect.gen(function* () {
  const docker = yield* Docker;
  // Pull before allocating a container lease; cancellation cannot orphan a later run.
  yield* docker.run(["pull", postgresImage]);
  const name = yield* Effect.acquireRelease(
    Effect.sync(
      () => `agentforum-local-${crypto.randomUUID().replaceAll("-", "")}`,
    ),
    (name) =>
      ownedId(docker, name).pipe(
        Effect.flatMap((id) =>
          id === ""
            ? Effect.void
            : docker.run(["rm", "--force", id]).pipe(Effect.asVoid),
        ),
        Effect.orDie,
      ),
  );
  const id = yield* docker
    .run([
      "run",
      "--detach",
      "--rm",
      "--pull",
      "never",
      "--name",
      name,
      "--label",
      `site.agentforum.local-scope=${name}`,
      "--publish",
      "127.0.0.1::5432",
      "--tmpfs",
      "/var/lib/postgresql/data:rw,nosuid,nodev,noexec",
      "--env",
      "POSTGRES_HOST_AUTH_METHOD=trust",
      "--env",
      "POSTGRES_DB=agentforum_local",
      postgresImage,
      "-c",
      "max_connections=30",
    ])
    .pipe(
      Effect.flatMap((value) => Schema.decodeUnknown(Id)(value.trim())),
      Effect.mapError(() => new LocalPostgresError()),
    );
  yield* docker
    .run([
      "exec",
      id,
      "pg_isready",
      "-h",
      "127.0.0.1",
      "-U",
      "postgres",
      "-d",
      "agentforum_local",
    ])
    .pipe(
      Effect.retry({ times: 150, schedule: Schedule.spaced("100 millis") }),
      Effect.timeoutFail({
        duration: "30 seconds",
        onTimeout: () => new LocalPostgresError(),
      }),
    );
  const ports = yield* docker
    .run([
      "inspect",
      "--format",
      '{{json (index .NetworkSettings.Ports "5432/tcp")}}',
      id,
    ])
    .pipe(
      Effect.flatMap(Schema.decodeUnknown(Mapping)),
      Effect.mapError(() => new LocalPostgresError()),
    );
  const port = ports[0].HostPort;
  return {
    name,
    id,
    port,
    url: (
      database: "agentforum_local" | "agentforum_direct" | "agentforum_cached",
    ) =>
      Redacted.make(
        `postgresql://postgres@127.0.0.1:${String(port)}/${database}`,
      ),
    execute: (
      sql: string,
      database:
        | "agentforum_local"
        | "postgres"
        | "agentforum_direct"
        | "agentforum_cached" = "agentforum_local",
    ) =>
      docker.run([
        "exec",
        id,
        "psql",
        "--no-psqlrc",
        "--username",
        "postgres",
        "--dbname",
        database,
        "--set",
        "ON_ERROR_STOP=1",
        "--command",
        sql,
      ]),
  };
});
export const localPostgresLayer = Layer.scoped(LocalPostgres, local).pipe(
  Layer.provide(dockerLayer),
);

// Reset never accepts a URL, migration environment variable, remote Docker host or
// arbitrary database name. The exact local container, label and port must match.
const verifiedDescriptor = (input: unknown) =>
  Effect.gen(function* () {
    const descriptor = yield* Schema.decodeUnknown(LocalDescriptor)(input).pipe(
      Effect.mapError(() => new LocalPostgresError()),
    );
    const docker = yield* Docker;
    const id = yield* ownedId(docker, descriptor.name);
    yield* Effect.filterOrFail(
      Effect.succeed(id),
      (value) => value === descriptor.id,
      () => new LocalPostgresError(),
    );
    const ports = yield* docker
      .run([
        "inspect",
        "--format",
        '{{json (index .NetworkSettings.Ports "5432/tcp")}}',
        id,
      ])
      .pipe(
        Effect.flatMap(Schema.decodeUnknown(Mapping)),
        Effect.mapError(() => new LocalPostgresError()),
      );
    yield* Effect.filterOrFail(
      Effect.succeed(ports[0].HostPort),
      (value) => value === descriptor.port,
      () => new LocalPostgresError(),
    );
    return descriptor;
  });
export const ownedLocalDatabaseUrl = (input: unknown) =>
  verifiedDescriptor(input).pipe(
    Effect.map((descriptor) =>
      Redacted.make(
        `postgresql://postgres@127.0.0.1:${String(descriptor.port)}/agentforum_local`,
      ),
    ),
    Effect.provide(dockerLayer),
  );
export const resetOwnedLocalDatabase = (input: unknown) =>
  Effect.gen(function* () {
    const descriptor = yield* verifiedDescriptor(input);
    const docker = yield* Docker;
    yield* docker.run([
      "exec",
      descriptor.id,
      "psql",
      "--no-psqlrc",
      "--username",
      "postgres",
      "--dbname",
      "postgres",
      "--set",
      "ON_ERROR_STOP=1",
      "--command",
      "DROP DATABASE agentforum_local WITH (FORCE)",
      "--command",
      "CREATE DATABASE agentforum_local",
    ]);
  }).pipe(Effect.provide(dockerLayer));
