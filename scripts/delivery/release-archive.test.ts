// Integrity fixtures only. Complete-app/workerd proof is in recovery-native.
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Effect, Either, Schema } from "effect";
import { afterEach, expect, it } from "vitest";
import { Identity } from "./model.js";
import { prepareTarget } from "./release-config.js";
import {
  captureArchive,
  materializeArchive,
  openArchive,
  verifyArchive,
  verifyMaterializedArchive,
} from "./release-archive.js";
const exec = promisify(execFile);
const temporary: string[] = [];
afterEach(async () => {
  for (const path of temporary.splice(0)) {
    await chmod(join(path, "archive"), 0o700).catch(() => undefined);
    await rm(path, { recursive: true, force: true });
  }
});
const fixture = async () => {
  const state = await mkdtemp(join(tmpdir(), "wo34-archive-unit-"));
  temporary.push(state);
  const repository = join(state, "repo"),
    server = join(repository, "apps/forum/dist/server"),
    client = join(repository, "apps/forum/dist/client"),
    migrations = join(repository, "apps/forum/migrations");
  for (const path of [server, client, migrations])
    await mkdir(path, { recursive: true });
  await writeFile(
    join(server, "index.js"),
    "export default {fetch(){return new Response('unit fixture')}}",
  );
  await writeFile(
    join(server, "extra.wasm"),
    new Uint8Array([0, 97, 115, 109]),
  );
  await writeFile(join(client, "fixture.txt"), "unit asset");
  await writeFile(
    join(migrations, "0000.sql"),
    "CREATE TABLE fixture(value TEXT);",
  );
  await writeFile(join(repository, ".gitignore"), "apps/forum/dist/\n");
  const git = (args: string[]) =>
    exec("git", args, {
      cwd: repository,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: state,
        XDG_CONFIG_HOME: state,
      },
    });
  await git(["init", "-q"]);
  await git(["add", "."]);
  await git([
    "-c",
    "user.name=Local Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "fixture",
  ]);
  const revision = (await git(["rev-parse", "HEAD"])).stdout.trim();
  const identity = Schema.decodeUnknownSync(Identity)({
    version: 1,
    accountId: "a".repeat(32),
    workerName: "archive-forum",
    databaseName: "archive-db",
    databaseId: "11111111-1111-1111-1111-111111111111",
    defaultOrigin: "https://archive-forum.fixture.workers.dev",
  });
  const raw = {
    name: "unbound",
    main: "index.js",
    compatibility_date: "2026-11-02",
    compatibility_flags: ["nodejs_compat"],
    no_bundle: true,
    workers_dev: false,
    preview_urls: false,
    vars: {},
    secrets: { required: [] },
    observability: { enabled: false, logs: { enabled: false } },
    future: { preserved: true },
    assets: {
      directory: "../client",
      binding: "ASSETS",
      run_worker_first: ["/v1", "/v1/*"],
    },
    d1_databases: [
      {
        binding: "DB",
        database_name: "unbound",
        migrations_dir: "../../migrations",
      },
    ],
  };
  const builtConfig = join(server, "wrangler.json");
  await writeFile(builtConfig, JSON.stringify(raw));
  const prepared = await Effect.runPromise(
    prepareTarget({
      raw,
      builtConfig,
      output: join(state, "target.json"),
      identity,
      sourceRevision: revision,
      authorizeTarget: true,
    }),
  );
  await writeFile(
    prepared.artifact.configPath,
    JSON.stringify(prepared.target),
  );
  const directory = join(state, "archive");
  return {
    state,
    repository,
    server,
    client,
    migrations,
    prepared,
    directory,
    capture: () => captureArchive({ repository, prepared, directory }),
  };
};
it("captures all server/assets/config/migration bytes and separately rebases deployment digest", async () => {
  const f = await fixture(),
    archive = await Effect.runPromise(f.capture());
  await Effect.runPromise(verifyArchive(archive));
  expect(
    await readFile(
      join(archive.directory, "apps/forum/dist/server/extra.wasm"),
    ),
  ).toEqual(Buffer.from([0, 97, 115, 109]));
  const prepared = await Effect.runPromise(
    materializeArchive({
      archive,
      output: join(f.state, "rebased.json"),
      approvedApplicationSource: f.prepared.artifact.sourceRevision,
    }),
  );
  expect(prepared.artifact.artifactDigest).not.toBe(
    f.prepared.artifact.artifactDigest,
  );
  expect(prepared.artifact.sourceRevision).toBe(
    f.prepared.artifact.sourceRevision,
  );
  expect(prepared.artifact.identity).toEqual(f.prepared.artifact.identity);
  expect(prepared.artifact.compatibleSchemas).toEqual([]);
  expect(prepared.target.workers_dev).toBe(true);
  expect(prepared.target.d1_databases[0]?.database_id).toBe(
    f.prepared.artifact.identity.databaseId,
  );
  await writeFile(
    prepared.artifact.configPath,
    JSON.stringify(prepared.target),
  );
  await Effect.runPromise(
    verifyMaterializedArchive(archive, prepared.artifact),
  );
  await writeFile(prepared.artifact.configPath, "{}");
  expect(
    Either.isLeft(
      await Effect.runPromise(
        Effect.either(verifyMaterializedArchive(archive, prepared.artifact)),
      ),
    ),
  ).toBe(true);
});
it.each(["worker", "manifest", "extra", "missing", "symlink"])(
  "rejects %s archive tampering",
  async (kind) => {
    const f = await fixture(),
      archive = await Effect.runPromise(f.capture());
    const worker = join(archive.directory, "apps/forum/dist/server/index.js");
    if (kind === "worker") {
      await chmod(worker, 0o600);
      await writeFile(worker, "changed");
    }
    if (kind === "manifest") {
      const manifest = join(archive.directory, "manifest.json");
      await chmod(manifest, 0o600);
      await writeFile(manifest, "{}");
    }
    if (kind === "extra")
      await writeFile(
        join(archive.directory, "apps/forum/dist/server/injected.js"),
        "extra",
      );
    if (kind === "missing") await rm(worker);
    if (kind === "symlink") {
      await rm(worker);
      await symlink(join(f.server, "index.js"), worker);
    }
    expect(
      Either.isLeft(
        await Effect.runPromise(Effect.either(verifyArchive(archive))),
      ),
    ).toBe(true);
  },
);
it("rejects wrong expected digest/source/identity and manufactured handles", async () => {
  const f = await fixture(),
    archive = await Effect.runPromise(f.capture());
  for (const artifact of [
    { ...f.prepared.artifact, sourceRevision: "f".repeat(40) },
    {
      ...f.prepared.artifact,
      identity: {
        ...f.prepared.artifact.identity,
        databaseId: "22222222-2222-2222-2222-222222222222",
      },
    },
  ])
    expect(
      Either.isLeft(
        await Effect.runPromise(
          Effect.either(openArchive({ ...archive, artifact })),
        ),
      ),
    ).toBe(true);
  expect(
    Either.isLeft(
      await Effect.runPromise(
        Effect.either(
          openArchive({
            ...archive,
            contentDigest: "0".repeat(64),
            artifact: f.prepared.artifact,
          }),
        ),
      ),
    ),
  ).toBe(true);
  expect(
    Either.isLeft(
      await Effect.runPromise(Effect.either(verifyArchive({ ...archive }))),
    ),
  ).toBe(true);
  const result = await Effect.runPromise(
    Effect.either(
      materializeArchive({
        archive,
        output: join(f.state, "wrong-source.json"),
        approvedApplicationSource: "f".repeat(40),
      }),
    ),
  );
  expect(Either.isLeft(result) && result.left.code).toBe(
    "archive-approved-source-mismatch",
  );
});
it.each(["dirty", "symlink", "existing", "mismatched"])(
  "refuses %s capture before publishing",
  async (kind) => {
    const f = await fixture();
    if (kind === "dirty")
      await writeFile(join(f.migrations, "0000.sql"), "SELECT 1;");
    if (kind === "symlink")
      await symlink(
        join(f.client, "fixture.txt"),
        join(f.server, "foreign.js"),
      );
    if (kind === "existing") await mkdir(f.directory);
    if (kind === "mismatched")
      f.prepared.target.vars.CANONICAL_ORIGIN = "https://hostile.example.com";
    expect(
      Either.isLeft(await Effect.runPromise(Effect.either(f.capture()))),
    ).toBe(true);
  },
);
