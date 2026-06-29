import { resolveRuntime } from "@/config/runtime.js";
import { applyMigrations } from "./apply-migrations.js";
import { openSqlite } from "./client.js";

const runtime = resolveRuntime();
const { sqlite } = openSqlite(runtime.paths.dbPath);

applyMigrations(sqlite, { migrationsFolder: "drizzle" });
sqlite.close();
