import type { DatabaseSync } from "node:sqlite";
import { type MigrationConfig, readMigrationFiles } from "drizzle-orm/migrator";

type MigrationRow = {
  created_at: number;
};

export function applyMigrations(sqlite: DatabaseSync, config: MigrationConfig): void {
  const migrationsTable = config.migrationsTable ?? "__drizzle_migrations";

  sqlite.exec(`
    create table if not exists "${migrationsTable}" (
      id integer primary key autoincrement not null,
      hash text not null,
      created_at integer not null
    )
  `);

  const lastMigration = sqlite
    .prepare(`select created_at from "${migrationsTable}" order by created_at desc limit 1`)
    .get() as MigrationRow | undefined;

  for (const migration of readMigrationFiles(config)) {
    if (lastMigration && lastMigration.created_at >= migration.folderMillis) {
      continue;
    }

    sqlite.exec("begin");
    try {
      for (const statement of migration.sql) {
        const trimmed = statement.trim();
        if (trimmed.length > 0) {
          sqlite.exec(trimmed);
        }
      }

      sqlite
        .prepare(`insert into "${migrationsTable}" (hash, created_at) values (?, ?)`)
        .run(migration.hash, migration.folderMillis);
      sqlite.exec("commit");
    } catch (error) {
      sqlite.exec("rollback");
      throw error;
    }
  }
}
