// Complete byte archive, NOT execution authority or compatibility approval.
// Caller retains the exact approved application-source/clean-checkout contract.
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Effect, Schema } from "effect";
import { failure } from "./model.js";
import { Artifact, Digest } from "./release-model.js";
import { decodeConfig, prepareTarget } from "./release-config.js";

type Prepared = Effect.Effect.Success<ReturnType<typeof prepareTarget>>;
const hash = (bytes: string | Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const Path = Schema.String.pipe(
  Schema.filter(
    (value) =>
      value
        .split("/")
        .every((part) => !!part && part !== "." && part !== "..") &&
      !/[\\\0]/.test(value),
  ),
);
const File = Schema.Struct({
  path: Path,
  digest: Digest,
  size: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
});
const Manifest = Schema.Struct({
  version: Schema.Literal(1),
  repository: Schema.String,
  artifact: Artifact,
  target: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  files: Schema.Array(File),
});
export interface CompleteArchive {
  readonly directory: string;
  readonly contentDigest: string;
}
const known = new WeakMap<CompleteArchive, Artifact>();
const io = <A>(use: () => Promise<A>) =>
  Effect.tryPromise({
    try: use,
    catch: () => failure("build", "archive-integrity-unverified"),
  });
const regular = async (path: string) => {
  if ((await realpath(path)) !== resolve(path)) throw new Error("unsafe path");
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("not regular");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return await file.readFile();
  } finally {
    await file.close();
  }
};
const inventory = async (root: string, folder: string): Promise<string[]> => {
  const path = join(root, folder);
  if (
    (await realpath(path)) !== resolve(path) ||
    !(await lstat(path)).isDirectory()
  )
    throw new Error("unsafe directory");
  const names = (await readdir(path)).sort();
  const paths: string[] = [];
  for (const name of names) {
    const child = join(path, name),
      stat = await lstat(child);
    if (stat.isSymbolicLink()) throw new Error("symlink");
    const logical = `${folder}/${name}`;
    Schema.decodeUnknownSync(Path)(logical);
    if (stat.isDirectory()) paths.push(...(await inventory(root, logical)));
    else if (stat.isFile()) paths.push(logical);
    else throw new Error("special file");
  }
  return paths;
};
const folders = [
  "apps/forum/dist/server",
  "apps/forum/dist/client",
  "apps/forum/migrations",
] as const;
const built = "apps/forum/dist/server/wrangler.json";
const list = async (root: string) =>
  (await Promise.all(folders.map((folder) => inventory(root, folder)))).flat();
const source = async (repository: string, revision: string, home: string) => {
  if ((await realpath(repository)) !== repository)
    throw new Error("unsafe repository");
  const git = (args: string[]) =>
    new Promise<string>((success, reject) => {
      execFile(
        "git",
        args,
        {
          cwd: repository,
          env: {
            PATH: process.env.PATH ?? "",
            HOME: home,
            XDG_CONFIG_HOME: home,
          },
          timeout: 10000,
          encoding: "utf8",
        },
        (error, stdout) => {
          if (error) reject(new Error("source unverified"));
          else success(stdout);
        },
      );
    });
  if (
    (await git(["rev-parse", "HEAD"])).trim() !== revision ||
    (await git(["status", "--porcelain=v1", "--untracked-files=normal"])) !== ""
  )
    throw new Error("source mismatch");
};
const unchanged = (a: Artifact, b: Artifact) =>
  a.sourceRevision === b.sourceRevision &&
  a.artifactDigest === b.artifactDigest &&
  JSON.stringify(a.identity) === JSON.stringify(b.identity) &&
  (a.canonicalOrigin ?? a.identity.defaultOrigin) ===
    (b.canonicalOrigin ?? b.identity.defaultOrigin) &&
  JSON.stringify(a.migrations) === JSON.stringify(b.migrations);
const check = (directory: string, contentDigest: string, artifact: Artifact) =>
  Effect.gen(function* () {
    const decodedArtifact = yield* Schema.decodeUnknown(Artifact)(
      artifact,
    ).pipe(Effect.mapError(() => failure("build", "archive-artifact-invalid")));
    const manifest = yield* io(async () => {
      const root = resolve(directory);
      if (
        root !== directory ||
        (await realpath(root)) !== root ||
        (await lstat(root)).mode & 0o077
      )
        throw new Error("unsafe archive");
      const bytes = await regular(join(root, "manifest.json"));
      if (hash(bytes) !== contentDigest) throw new Error("manifest changed");
      const value = Schema.decodeUnknownSync(Schema.parseJson(Manifest))(
        bytes.toString("utf8"),
        { onExcessProperty: "error" },
      );
      if (JSON.stringify(value.artifact) !== JSON.stringify(decodedArtifact))
        throw new Error("foreign provenance");
      const paths = await list(root);
      if (
        JSON.stringify(paths) !==
        JSON.stringify(value.files.map((file) => file.path))
      )
        throw new Error("inventory changed");
      for (const file of value.files) {
        const data = await regular(join(root, file.path));
        if (data.length !== file.size || hash(data) !== file.digest)
          throw new Error("bytes changed");
      }
      const server = value.files.filter(
        (file) => file.path.startsWith(`${folders[0]}/`) && file.path !== built,
      );
      const assets = value.files.filter((file) =>
        file.path.startsWith(`${folders[1]}/`),
      );
      const migrations = value.files.filter(
        (file) =>
          file.path.startsWith(`${folders[2]}/`) && file.path.endsWith(".sql"),
      );
      const fingerprints = [...server, ...assets, ...migrations].map((file) => [
        join(value.repository, file.path),
        file.digest,
      ]);
      if (
        hash(JSON.stringify({ target: value.target, fingerprints })) !==
        decodedArtifact.artifactDigest
      )
        throw new Error("original digest mismatch");
      return value;
    });
    return manifest;
  });
export const openArchive = (input: {
  readonly directory: string;
  readonly contentDigest: string;
  readonly artifact: Artifact;
}) =>
  check(input.directory, input.contentDigest, input.artifact).pipe(
    Effect.map(() => {
      const archive = Object.freeze({
        directory: input.directory,
        contentDigest: input.contentDigest,
      });
      known.set(archive, input.artifact);
      return archive;
    }),
  );
export const verifyArchive = (archive: CompleteArchive) =>
  Effect.suspend(() => {
    const artifact = known.get(archive);
    return artifact
      ? check(archive.directory, archive.contentDigest, artifact).pipe(
          Effect.asVoid,
        )
      : Effect.fail(failure("build", "archive-handle-unverified"));
  });
export const captureArchive = (input: {
  readonly repository: string;
  readonly prepared: Prepared;
  readonly directory: string;
}) =>
  Effect.gen(function* () {
    const artifact = yield* Schema.decodeUnknown(Artifact)(
      input.prepared.artifact,
    ).pipe(Effect.mapError(() => failure("build", "archive-artifact-invalid")));
    const parent = dirname(input.directory),
      stage = `${input.directory}.partial-${randomUUID()}`;
    yield* io(async () => {
      if (
        input.directory !== resolve(input.directory) ||
        (await realpath(parent)) !== parent ||
        (await lstat(parent)).mode & 0o077
      )
        throw new Error("unsafe destination");
      await source(input.repository, artifact.sourceRevision, parent);
      await mkdir(stage, { mode: 0o700 });
    });
    return yield* Effect.gen(function* () {
      const raw = yield* io(() => regular(join(input.repository, built))).pipe(
        Effect.flatMap((bytes) => decodeConfig(bytes.toString("utf8"))),
      );
      const fresh = yield* prepareTarget({
        raw,
        builtConfig: join(input.repository, built),
        output: join(parent, `archive-verify-${randomUUID()}.json`),
        identity: artifact.identity,
        sourceRevision: artifact.sourceRevision,
        canonicalOrigin:
          artifact.canonicalOrigin ?? artifact.identity.defaultOrigin,
        authorizeTarget: true,
      });
      if (
        !unchanged(fresh.artifact, artifact) ||
        JSON.stringify(fresh.target) !== JSON.stringify(input.prepared.target)
      )
        return yield* Effect.fail(
          failure("build", "archive-prepared-artifact-mismatch"),
        );
      const contentDigest = yield* io(async () => {
        const paths = await list(input.repository);
        const files: (typeof File.Type)[] = [];
        for (const path of paths) {
          const bytes = await regular(join(input.repository, path));
          const destination = join(stage, path);
          await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
          const file = await open(destination, "wx", 0o400);
          try {
            await file.writeFile(bytes);
            await file.sync();
          } finally {
            await file.close();
          }
          files.push({ path, digest: hash(bytes), size: bytes.length });
        }
        const bytes = JSON.stringify({
          version: 1,
          repository: input.repository,
          artifact,
          target: fresh.target,
          files,
        });
        const manifest = await open(join(stage, "manifest.json"), "wx", 0o400);
        try {
          await manifest.writeFile(bytes);
          await manifest.sync();
        } finally {
          await manifest.close();
        }
        await source(input.repository, artifact.sourceRevision, parent);
        return hash(bytes);
      });
      yield* check(stage, contentDigest, artifact);
      // Refuse replacement. Immutable/private archives are not a filesystem seal;
      // every use rechecks bytes, and callers preserve pre-effect verification.
      yield* io(async () => {
        await mkdir(input.directory, { mode: 0o700 });
        await rename(stage, input.directory);
        await chmod(input.directory, 0o500);
      });
      return yield* openArchive({
        directory: input.directory,
        contentDigest,
        artifact,
      });
    }).pipe(
      Effect.onError(() =>
        io(() => rm(stage, { recursive: true, force: true })).pipe(
          Effect.orDie,
        ),
      ),
    );
  });
export const materializeArchive = (input: {
  readonly archive: CompleteArchive;
  readonly output: string;
  readonly approvedApplicationSource: string;
}) =>
  Effect.gen(function* () {
    const artifact = known.get(input.archive);
    if (artifact?.sourceRevision !== input.approvedApplicationSource)
      return yield* Effect.fail(
        failure("authorization", "archive-approved-source-mismatch"),
      );
    yield* verifyArchive(input.archive);
    const config = join(input.archive.directory, built);
    const raw = yield* io(() => regular(config)).pipe(
      Effect.flatMap((bytes) => decodeConfig(bytes.toString("utf8"))),
    );
    const prepared = yield* prepareTarget({
      raw,
      builtConfig: config,
      output: input.output,
      identity: artifact.identity,
      sourceRevision: input.approvedApplicationSource,
      canonicalOrigin:
        artifact.canonicalOrigin ?? artifact.identity.defaultOrigin,
      authorizeTarget: true,
    });
    yield* verifyArchive(input.archive);
    return {
      ...prepared,
      artifact: {
        ...prepared.artifact,
        schemaDigest: artifact.schemaDigest,
        compatibleSchemas: [],
      },
    };
  });
// Bind a materialized candidate to these archive bytes, not a caller's assertion.
export const verifyMaterializedArchive = (
  archive: CompleteArchive,
  artifact: Artifact,
) =>
  Effect.gen(function* () {
    const current = yield* materializeArchive({
      archive,
      output: join(
        dirname(artifact.configPath),
        `archive-recheck-${randomUUID()}.json`,
      ),
      approvedApplicationSource: artifact.sourceRevision,
    });
    if (
      !unchanged(current.artifact, artifact) ||
      current.artifact.schemaDigest !== artifact.schemaDigest ||
      artifact.compatibleSchemas.length ||
      (yield* io(() => regular(artifact.configPath))).toString("utf8") !==
        JSON.stringify(current.target)
    )
      return yield* Effect.fail(
        failure("build", "archive-materialization-mismatch"),
      );
  });
