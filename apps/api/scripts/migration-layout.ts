import type { Config } from "drizzle-kit";
export const migrationLayout = {
  dialect: "postgresql",
  schema: "./src/database/schema.ts",
  out: "./migrations",
  migrations: { schema: "drizzle", table: "__drizzle_migrations" },
} satisfies Config;
