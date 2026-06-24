import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { applyMigrations } from "@/db/apply-migrations.js";
import { openSqlite } from "@/db/client.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("SQLite migrations", () => {
  test("apply the committed Drizzle migrations to a real SQLite database", () => {
    const dir = mkdtempSync(join(tmpdir(), "shepherd-db-"));
    tempDirs.push(dir);

    const { sqlite } = openSqlite(join(dir, "test.sqlite"));
    applyMigrations(sqlite, { migrationsFolder: "drizzle" });

    const tables = sqlite
      .prepare(
        "select name from sqlite_master where type = 'table' and name in ('sessions', 'events') order by name",
      )
      .all()
      .map((row) => row.name);

    sqlite.close();

    expect(tables).toEqual(["events", "sessions"]);
  });
});
