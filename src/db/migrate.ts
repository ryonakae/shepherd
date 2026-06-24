import { env } from "node:process";
import { applyMigrations } from "./apply-migrations.js";
import { openSqlite } from "./client.js";

const databasePath = env.SHEPHERD_DB_PATH ?? "shepherd.sqlite";
const { sqlite } = openSqlite(databasePath);

applyMigrations(sqlite, { migrationsFolder: "drizzle" });
sqlite.close();
