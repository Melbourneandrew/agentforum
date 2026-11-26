// Evidence DATA only. Authority remains ParentExecution and exact clean source A.
// No file/JSON/callback can mint a witness: only the concrete local runtime below.
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { Agent, request as httpsRequest } from "node:https";
import { createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { Effect, Schema } from "effect";
import { Identity, failure } from "./model.js";
import { Artifact } from "./release-model.js";
import {
  openArchive,
  materializeArchive,
  verifyMaterializedArchive,
  verifyArchiveBuild,
  type CompleteArchive,
} from "./release-archive.js";
import { sameIdentity } from "./release-control.js";
import {
  physicalStates,
  inspectInstalled,
  type PhysicalState,
} from "./remote-state.js";
import { localControls } from "./control-local.js";
import type { SqliteMigrationSource } from "../sqlite-migrations.js";
import type { prepareTarget } from "./release-config.js";
import {
  RegistrationResult,
  PostResult,
  PostPageResult,
} from "../../apps/forum/src/api/contracts.js";
const exec = promisify(execFile);
type Prepared = Effect.Effect.Success<ReturnType<typeof prepareTarget>>;
export interface RecoveryWitness {
  readonly kind: "complete-worker-pair-witness";
}
export interface RecoverySelection {
  readonly directory: string;
  readonly contentDigest: string;
  readonly originalArtifact: Artifact;
  readonly witness: RecoveryWitness;
}
const proofs = new WeakMap<
  object,
  {
    readonly archive: CompleteArchive;
    readonly artifact: Artifact;
    readonly state: PhysicalState;
  }
>();
const running = (child: import("node:child_process").ChildProcess) =>
  child.exitCode === null && child.signalCode === null;
const invalid = () => failure("build", "recovery-evidence-unverified");
const io = <A>(use: () => Promise<A>) =>
  Effect.tryPromise({ try: use, catch: invalid });
const equal = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const proofFor = (witness: unknown) =>
  Effect.suspend(() => {
    const proof =
      typeof witness === "object" && witness !== null
        ? proofs.get(witness)
        : undefined;
    return proof ? Effect.succeed(proof) : Effect.fail(invalid());
  });
// No readiness/authorization result. The only compatible schema is derived from
// a genuine witness, never supplied by a caller or loaded from an assertion file.
export const prepareRecovery = (input: {
  readonly selection: RecoverySelection;
  readonly applicationRepository: string;
  readonly identity: Identity;
  readonly sourceRevision: string;
  readonly canonicalOrigin: string;
  readonly output: string;
}) =>
  Effect.gen(function* () {
    const selection = yield* Schema.decodeUnknown(
      Schema.Struct({
        directory: Schema.NonEmptyString,
        contentDigest: Schema.String,
        originalArtifact: Artifact,
        witness: Schema.Unknown,
      }),
    )(input.selection, { onExcessProperty: "error" }).pipe(
      Effect.mapError(invalid),
    );
    const proof = yield* proofFor(selection.witness);
    const archive = yield* openArchive({
      directory: selection.directory,
      contentDigest: selection.contentDigest,
      artifact: selection.originalArtifact,
    });
    if (
      archive.directory !== proof.archive.directory ||
      archive.contentDigest !== proof.archive.contentDigest ||
      proof.artifact.sourceRevision !== input.sourceRevision ||
      !sameIdentity(proof.artifact.identity, input.identity) ||
      (proof.artifact.canonicalOrigin ??
        proof.artifact.identity.defaultOrigin) !== input.canonicalOrigin
    )
      return yield* Effect.fail(invalid());
    yield* verifyArchiveBuild(archive, input.applicationRepository);
    const prepared = yield* materializeArchive({
      archive,
      output: input.output,
      approvedApplicationSource: input.sourceRevision,
    });
    if (
      !equal(
        { ...prepared.artifact, configPath: proof.artifact.configPath },
        proof.artifact,
      )
    )
      return yield* Effect.fail(invalid());
    yield* io(() =>
      writeFile(prepared.artifact.configPath, JSON.stringify(prepared.target), {
        flag: "wx",
        mode: 0o600,
      }),
    );
    const artifact = {
      ...prepared.artifact,
      compatibleSchemas: [proof.state.physicalDigest],
    };
    const verify = verifyRecoveryCandidate(
      input.selection.witness,
      archive,
      artifact,
    );
    yield* verify;
    return {
      prepared: { ...prepared, artifact },
      states: [structuredClone(proof.state)],
      verify,
    };
  });
export const verifyRecoveryCandidate = (
  witness: RecoveryWitness,
  archive: CompleteArchive,
  artifact: Artifact,
) =>
  Effect.gen(function* () {
    const proof = yield* proofFor(witness);
    // The ordinary verifier is not weakened. Strip only AFTER exact comparison
    // with the internally derived singleton and the full bound candidate tuple.
    const expected = {
      ...proof.artifact,
      configPath: artifact.configPath,
      compatibleSchemas: [proof.state.physicalDigest],
    };
    if (
      archive.directory !== proof.archive.directory ||
      archive.contentDigest !== proof.archive.contentDigest ||
      !equal(expected, artifact)
    )
      return yield* Effect.fail(invalid());
    yield* verifyMaterializedArchive(archive, {
      ...artifact,
      compatibleSchemas: [],
    });
  });

// Explicit disposable LOCAL qualification. Owns pinned workerd, real D1 queries
// and the complete API exercise. No supplied transport or success callback.
// Provider/complete-release qualification remains separately required in WO37.
export const qualifyLocalRecovery = (input: {
  readonly archive: CompleteArchive;
  readonly artifact: Artifact;
  readonly applicationRepository: string;
  readonly toolingRepository: string;
  readonly state: string;
  readonly migrationSources: readonly SqliteMigrationSource[];
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const artifact = yield* Schema.decodeUnknown(Artifact)(
        input.artifact,
      ).pipe(Effect.mapError(invalid));
      yield* verifyMaterializedArchive(input.archive, artifact);
      const env = {
        PATH: process.env.PATH ?? "",
        HOME: input.state,
        XDG_CONFIG_HOME: input.state,
        CI: "true",
        CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
        WRANGLER_SEND_METRICS: "false",
        WRANGLER_LOG_PATH: join(input.state, "recovery-wrangler.log"),
        WRANGLER_RESOURCES_PROVISION: "false",
      };
      const source = () =>
        io(async () => {
          if (
            (await realpath(input.applicationRepository)) !==
              input.applicationRepository ||
            (await realpath(input.state)) !== input.state ||
            (await lstat(input.state)).mode & 0o077 ||
            !(
              await lstat(
                join(
                  input.applicationRepository,
                  "apps/forum/scripts/owner-build.ts",
                ),
              )
            ).isFile()
          )
            throw new Error("unsupported source");
          if (
            (
              await exec("git", ["rev-parse", "HEAD"], {
                cwd: input.applicationRepository,
                env,
              })
            ).stdout.trim() !== artifact.sourceRevision ||
            (
              await exec(
                "git",
                ["status", "--porcelain=v1", "--untracked-files=normal"],
                { cwd: input.applicationRepository, env },
              )
            ).stdout !== ""
          )
            throw new Error("source mismatch");
        });
      yield* source();
      if (
        input.migrationSources.length <= artifact.migrations.length ||
        artifact.migrations.some(
          (migration, index) =>
            input.migrationSources[index]?.path !==
            `apps/forum/migrations/${migration.name}`,
        )
      )
        return yield* Effect.fail(invalid());
      // Reuse reviewed observation checks for source byte-prefix and complete native
      // replay, but do not mint from that function's caller-supplied exercise.
      const archiveSources = yield* io(() =>
        Promise.all(
          artifact.migrations.map(async (migration) => ({
            path: `apps/forum/migrations/${migration.name}`,
            bytes: await readFile(
              join(
                input.archive.directory,
                "apps/forum/migrations",
                migration.name,
              ),
            ),
          })),
        ),
      );
      for (const [index, sourceFile] of archiveSources.entries())
        if (
          !Buffer.from(sourceFile.bytes).equals(
            Buffer.from(input.migrationSources[index]?.bytes ?? []),
          )
        )
          return yield* Effect.fail(invalid());
      const states = yield* physicalStates(input.migrationSources);
      const state = states.at(-1);
      if (!state) return yield* Effect.fail(invalid());
      const wrangler = join(
        input.applicationRepository,
        "apps/forum/node_modules/wrangler/bin/wrangler.js",
      );
      const run = async (args: string[]) =>
        (
          await exec(
            process.execPath,
            [wrangler, ...args, "--env-file", "/dev/null"],
            {
              cwd: input.applicationRepository,
              env,
              timeout: 60000,
              maxBuffer: 8 * 1024 * 1024,
            },
          )
        ).stdout;
      const prepared: Prepared = {
        artifact,
        target: (yield* materializeArchive({
          archive: input.archive,
          output: join(input.state, "unused-qualification-target.json"),
          approvedApplicationSource: artifact.sourceRevision,
        })).target,
      };
      const controls = yield* io(() =>
        localControls({
          prepared,
          root: input.toolingRepository,
          state: input.state,
          run,
        }),
      );
      const before = yield* inspectInstalled(
        artifact,
        [state],
        controls.database,
      );
      const runtime = yield* Effect.acquireRelease(
        io(async () => {
          const certificate = join(input.state, "recovery-certificate.pem"),
            key = join(input.state, "recovery-key.pem");
          await exec(
            "openssl",
            [
              "req",
              "-x509",
              "-newkey",
              "rsa:2048",
              "-nodes",
              "-keyout",
              key,
              "-out",
              certificate,
              "-days",
              "1",
              "-subj",
              "/CN=localhost",
              "-addext",
              "subjectAltName=IP:127.0.0.1,DNS:localhost",
            ],
            { env, timeout: 10000 },
          );
          const agent = new Agent({ ca: await readFile(certificate) });
          const socket = createServer();
          socket.listen(0, "127.0.0.1");
          await once(socket, "listening");
          const address = socket.address();
          if (!address || typeof address === "string")
            throw new Error("no port");
          const port = address.port;
          await new Promise<void>((success, reject) =>
            socket.close((error) => {
              if (error) reject(error);
              else success();
            }),
          );
          const base = `https://127.0.0.1:${String(port)}`;
          const child = spawn(
            process.execPath,
            [
              wrangler,
              "dev",
              "--local",
              "--no-bundle",
              "--config",
              artifact.configPath,
              "--persist-to",
              join(input.state, "d1"),
              "--ip",
              "127.0.0.1",
              "--port",
              String(port),
              "--inspector-port",
              "0",
              "--local-protocol",
              "https",
              "--local-upstream",
              `127.0.0.1:${String(port)}`,
              "--upstream-protocol",
              "https",
              "--var",
              `CANONICAL_ORIGIN:${base}`,
              "--https-cert-path",
              certificate,
              "--https-key-path",
              key,
              "--env-file",
              "/dev/null",
            ],
            { cwd: input.applicationRepository, env, stdio: "ignore" },
          );
          child.on("error", () => undefined);
          return { child, agent, base };
        }),
        (runtime) =>
          io(async () => {
            if (running(runtime.child)) {
              const exited = once(runtime.child, "exit");
              runtime.child.kill("SIGTERM");
              await Promise.race([exited, delay(3000)]);
              if (running(runtime.child)) runtime.child.kill("SIGKILL");
              await exited;
            }
            runtime.agent.destroy();
          }).pipe(Effect.orDie),
      );
      const request = async (path: string, init?: RequestInit) => {
        const incoming = new Request(`${runtime.base}${path}`, init),
          url = new URL(incoming.url);
        if (url.origin !== runtime.base) throw new Error("nonlocal transport");
        const body =
          incoming.method === "GET" || incoming.method === "HEAD"
            ? undefined
            : Buffer.from(await incoming.arrayBuffer());
        return new Promise<Response>((success, reject) => {
          const outgoing = httpsRequest(
            url,
            {
              agent: runtime.agent,
              method: incoming.method,
              headers: Object.fromEntries(incoming.headers),
              signal: AbortSignal.timeout(5000),
            },
            (response) => {
              const chunks: Buffer[] = [];
              let size = 0;
              response.on("data", (chunk: Buffer) => {
                size += chunk.length;
                if (size > 1024 * 1024)
                  outgoing.destroy(new Error("response too large"));
                else chunks.push(chunk);
              });
              response.on("error", reject);
              response.on("end", () => {
                success(
                  new Response(Buffer.concat(chunks), {
                    status: response.statusCode ?? 500,
                  }),
                );
              });
            },
          );
          outgoing.on("error", reject);
          outgoing.end(body);
        });
      };
      const nonce = randomUUID().replaceAll("-", "");
      const term = `qualifiedarchive${nonce}`;
      yield* io(async () => {
        let started = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          if (
            runtime.child.exitCode !== null ||
            runtime.child.signalCode !== null
          )
            throw new Error("worker exited");
          const response = await request("/v1/search?payload=%7B%7D").catch(
            () => undefined,
          );
          if (response?.status === 200) {
            await response.body?.cancel();
            started = true;
            break;
          }
          await response?.body?.cancel();
          await delay(100);
        }
        if (!started) throw new Error("worker not started");
        const call = (
          operation: string,
          inputData: unknown,
          method: string,
          key = "",
        ) => {
          const body = JSON.stringify(inputData);
          return request(
            `/v1/${operation}${method === "GET" ? `?payload=${encodeURIComponent(body)}` : ""}`,
            {
              method,
              headers: {
                "Content-Type": "application/json",
                ...(key ? { Authorization: `Bearer ${key}` } : {}),
              },
              ...(method === "POST" ? { body } : {}),
            },
          );
        };
        const signup = await call("register", { name: `Qual${nonce}` }, "POST");
        if (signup.status !== 201) throw new Error("registration failed");
        const agent = await Schema.decodeUnknownPromise(RegistrationResult)(
          await signup.json(),
        );
        const initial = await call(
          "publish",
          { body: `${term} retained` },
          "POST",
          agent.apiKey,
        );
        if (initial.status !== 201) throw new Error("publication failed");
        const post = await Schema.decodeUnknownPromise(PostResult)(
          await initial.json(),
        );
        const checkpointResponse = await call(
          "search",
          { author: agent.id },
          "GET",
        );
        if (checkpointResponse.status !== 200) throw new Error("search failed");
        const checkpoint = await Schema.decodeUnknownPromise(PostPageResult)(
          await checkpointResponse.json(),
        );
        if (!checkpoint.posts.some((value) => value.id === post.id))
          throw new Error("record missing");
        const next = await call(
          "publish",
          { body: "qualified archive GET key retained" },
          "GET",
          agent.apiKey,
        );
        if (next.status !== 201) throw new Error("key failed");
        const nextPost = await Schema.decodeUnknownPromise(PostResult)(
          await next.json(),
        );
        for (const method of ["GET", "POST"]) {
          const response = await call(
            "search",
            { author: agent.id, readCursor: checkpoint.readCursor },
            method,
          );
          if (
            response.status !== 200 ||
            !equal(
              (
                await Schema.decodeUnknownPromise(PostPageResult)(
                  await response.json(),
                )
              ).posts.map((value) => value.id),
              [nextPost.id],
            )
          )
            throw new Error("checkpoint failed");
        }
        for (const path of [
          "/",
          "/docs/",
          "/docs/openapi.json",
          "/llms.txt",
          "/skill.md",
        ]) {
          const response = await request(path);
          if (response.status !== 200)
            throw new Error("complete surface missing");
          await response.body?.cancel();
        }
        if (
          (await (await request("/llms.txt")).text()) !==
          (await (await request("/skill.md")).text())
        )
          throw new Error("guides differ");
      });
      const fts = yield* controls.database.query(
        "SELECT count(*) AS n FROM post_fts WHERE post_fts MATCH ?",
        [term],
      );
      if (!equal(fts, [{ n: 1 }])) return yield* Effect.fail(invalid());
      yield* source();
      yield* verifyMaterializedArchive(input.archive, artifact);
      const after = yield* inspectInstalled(
        artifact,
        [state],
        controls.database,
      );
      if (!equal(before, after)) return yield* Effect.fail(invalid());
      const witness = Object.freeze({
        kind: "complete-worker-pair-witness" as const,
      });
      // Clone the complete state so caller mutation of migration inputs cannot change
      // a witnessed tuple. Neither the witness nor the registry is serializable.
      const copy = structuredClone(state);
      proofs.set(witness, {
        archive: input.archive,
        artifact: structuredClone(artifact),
        state: copy,
      });
      return witness;
    }),
  );
