import { defineConfig } from "drizzle-kit";
import { migrationLayout } from "./scripts/migration-layout.js";
// Generation reads repository schema only and never needs database credentials.
// Applying migrations goes through db:migrate's separately validated origin target.
export default defineConfig(migrationLayout);
