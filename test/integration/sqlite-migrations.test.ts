import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { applyMigrations } from "@/db/apply-migrations.js";
import { openSqlite } from "@/db/client.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

describe("SQLite migrations", () => {
  test("create the agent index schema", () => {
    const dir = mkdtempSync(join(tmpdir(), "shepherd-db-"));
    tempDirs.push(dir);
    const { sqlite } = openSqlite(join(dir, "test.sqlite"));
    applyMigrations(sqlite, { migrationsFolder: "drizzle" });
    const tables = sqlite
      .prepare("select name from sqlite_master where type = 'table' order by name")
      .all()
      .map((row) => (row as { name: string }).name)
      .filter((name) => name !== "__drizzle_migrations" && name !== "sqlite_sequence");
    expect(tables).toEqual([
      "agent_events",
      "agent_history_cache",
      "agent_orchestrator_scopes",
      "agents",
      "herdr_sessions",
      "herdr_workspaces",
    ]);
    expect(tables).not.toContain("observed_workspaces");
    const scopeColumns = sqlite
      .prepare("pragma table_info(agent_orchestrator_scopes)")
      .all()
      .map((row) => row as { name: string });
    expect(scopeColumns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "acked_event_id",
        "herdr_session_name",
        "owner_pane_id",
        "owner_terminal_id",
        "workspace_id",
      ]),
    );
    const eventColumns = sqlite
      .prepare("pragma table_info(agent_events)")
      .all()
      .map((row) => row as { name: string; notnull: number });
    expect(eventColumns.find((column) => column.name === "terminal_id")?.notnull).toBe(0);
    sqlite.close();
  });
});
