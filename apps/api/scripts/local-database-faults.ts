import { createServer, type Server, type Socket } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { Context, Data, Effect, Layer, Redacted, Schema } from "effect";

class LocalDatabaseFaultError extends Data.TaggedError(
  "LocalDatabaseFaultError",
) {}
const Address = Schema.Struct({
  address: Schema.Literal("127.0.0.1"),
  family: Schema.Literal("IPv4"),
  port: Schema.Int.pipe(Schema.between(1, 65535)),
});
const Statistics = Schema.Struct({
  connections: Schema.Int,
  startupBytes: Schema.Int,
  faulted: Schema.Boolean,
});
const notRunning = Schema.Struct({
  code: Schema.Literal("ERR_SERVER_NOT_RUNNING"),
});
const close = (server: Server) =>
  Effect.tryPromise({
    try: () =>
      new Promise<boolean>((done, reject) => {
        server.close((error) => {
          if (error && !Schema.is(notRunning)(error))
            reject(new LocalDatabaseFaultError());
          else done(true);
        });
      }),
    catch: () => new LocalDatabaseFaultError(),
  }).pipe(Effect.orDie);
const listen = (server: Server, failed: () => void) =>
  Effect.async<boolean, LocalDatabaseFaultError>((resume) => {
    server.on("error", () => {
      failed();
      resume(Effect.fail(new LocalDatabaseFaultError()));
    });
    server.listen(0, "127.0.0.1", () => {
      resume(Effect.succeed(true));
    });
  }).pipe(
    Effect.flatMap(() => Schema.decodeUnknown(Address)(server.address())),
    Effect.mapError(() => new LocalDatabaseFaultError()),
  );

export class LocalDatabaseFaults extends Context.Tag(
  "@agentforum/tooling/LocalDatabaseFaults",
)<
  LocalDatabaseFaults,
  {
    readonly connectionString: Redacted.Redacted;
    readonly statisticsUrl: string;
  }
>() {}
const faults = Effect.gen(function* () {
  const lease = yield* Effect.acquireRelease(
    Effect.sync(() => {
      const sockets = new Set<Socket>();
      let faulted = false;
      let startupBytes = 0;
      const blackhole = createServer((socket) => {
        sockets.add(socket);
        // Drain real startup packets but deliberately never respond to the handshake.
        socket.on("data", (chunk: Buffer) => {
          startupBytes += chunk.byteLength;
        });
        socket.on("error", () => {
          socket.destroy();
        });
        socket.once("close", () => {
          sockets.delete(socket);
        });
      });
      const statistics = createHttpServer((_request, response) => {
        response.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        response.end(
          JSON.stringify(
            Schema.encodeSync(Statistics)({
              connections: sockets.size,
              startupBytes,
              faulted,
            }),
          ),
        );
      });
      return {
        blackhole,
        statistics,
        sockets,
        failed: () => {
          faulted = true;
        },
      };
    }),
    (lease) =>
      Effect.sync(() => {
        for (const socket of lease.sockets) socket.destroy();
      }).pipe(
        Effect.zipRight(
          Effect.all([close(lease.blackhole), close(lease.statistics)], {
            concurrency: "unbounded",
          }),
        ),
      ),
  );
  const tcp = yield* listen(lease.blackhole, lease.failed);
  const http = yield* listen(lease.statistics, lease.failed);
  return {
    connectionString: Redacted.make(
      `postgresql://postgres@127.0.0.1:${String(tcp.port)}/agentforum_direct`,
    ),
    statisticsUrl: `http://127.0.0.1:${String(http.port)}`,
  };
});
export const localDatabaseFaultsLayer = Layer.scoped(
  LocalDatabaseFaults,
  faults,
);
