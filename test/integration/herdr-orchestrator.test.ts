import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { applyMigrations } from "@/db/apply-migrations.js";
import { openSqlite } from "@/db/client.js";
import { EventStore } from "@/db/event-store.js";
import { HerdrOrchestrator } from "@/herdr/orchestrator.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("HerdrOrchestrator", () => {
  test("creates a Shepherd workspace layout and records the Herdr binding", async () => {
    const { sqlite, store } = openMigratedDatabase();
    const session = store.createSession({ id: "session-abcdef123456" });
    const calls: unknown[] = [];
    const orchestrator = new HerdrOrchestrator({
      herdr: {
        async createWorkspace(params) {
          calls.push(["workspace.create", params]);
          return { workspace_id: "w1" };
        },
        async createTab(params) {
          calls.push(["tab.create", params]);
          return { tab_id: `w1:t${calls.length}` };
        },
      },
      sqlite,
    });

    const binding = await orchestrator.ensureWorkspace({
      herdrSessionName: "shepherd-api",
      sessionId: session.id,
      taskSlug: "Review Slack Sync",
      workingDirectory: "/repo",
    });

    expect(binding).toEqual({
      herdrSessionName: "shepherd-api",
      tabs: {
        agents: "w1:t2",
        logs: "w1:t4",
        review: "w1:t5",
        scratch: "w1:t6",
        tests: "w1:t3",
      },
      workspaceId: "w1",
    });
    expect(calls[0]).toEqual([
      "workspace.create",
      { cwd: "/repo", label: "shepherd-review-slack-sync-session" },
    ]);
    expect(calls).toHaveLength(6);
  });

  test("returns an existing binding without creating another Herdr workspace", async () => {
    const { sqlite, store } = openMigratedDatabase();
    const session = store.createSession({ id: "session-abcdef123456" });
    const orchestrator = new HerdrOrchestrator({
      herdr: {
        async createWorkspace() {
          throw new Error("should not create workspace twice");
        },
        async createTab() {
          throw new Error("should not create tabs twice");
        },
      },
      sqlite,
    });

    await sqlite
      .prepare(
        "insert into herdr_bindings (id, session_id, herdr_session_name, workspace_id, metadata_json, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "binding-1",
        session.id,
        "shepherd-api",
        "w1",
        JSON.stringify({ tabs: { agents: "w1:t1" } }),
        Date.now(),
        Date.now(),
      );

    await expect(
      orchestrator.ensureWorkspace({
        herdrSessionName: "shepherd-api",
        sessionId: session.id,
        taskSlug: "Review Slack Sync",
        workingDirectory: "/repo",
      }),
    ).resolves.toEqual({
      herdrSessionName: "shepherd-api",
      tabs: { agents: "w1:t1" },
      workspaceId: "w1",
    });
  });
});

function openMigratedDatabase(): {
  sqlite: ReturnType<typeof openSqlite>["sqlite"];
  store: EventStore;
} {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-herdr-orchestrator-"));
  tempDirs.push(dir);

  const { sqlite } = openSqlite(join(dir, "test.sqlite"));
  applyMigrations(sqlite, { migrationsFolder: "drizzle" });
  return { sqlite, store: new EventStore(sqlite) };
}
