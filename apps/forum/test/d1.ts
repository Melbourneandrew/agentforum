import { env } from "cloudflare:workers";
import { inject } from "vitest";
import type { Bindings } from "../src/runtime/context.js";
// Use the official migration reader's exact Wrangler chunks in native D1.
export const migrate = async (db: Bindings["DB"] = env.DB) => {
  await db
    .prepare("CREATE TABLE IF NOT EXISTS d1_migrations(name TEXT PRIMARY KEY)")
    .run();
  for (const migration of inject("migrations")) {
    if (
      await db
        .prepare("SELECT name FROM d1_migrations WHERE name=?")
        .bind(migration.name)
        .first()
    )
      continue;
    await db.batch([
      ...migration.queries.map((query) => db.prepare(query)),
      db
        .prepare("INSERT INTO d1_migrations(name) VALUES (?)")
        .bind(migration.name),
    ]);
  }
};
