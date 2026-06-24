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
        async readAgent() {
          throw new Error("not used");
        },
        async sendAgentMessage() {
          throw new Error("not used");
        },
        async startAgent() {
          throw new Error("not used");
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
        async readAgent() {
          throw new Error("not used");
        },
        async sendAgentMessage() {
          throw new Error("not used");
        },
        async startAgent() {
          throw new Error("not used");
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

  test("starts an agent in the Shepherd agents tab", async () => {
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
          return { tab_id: `w1:${params.label}` };
        },
        async readAgent() {
          throw new Error("not used");
        },
        async sendAgentMessage() {
          throw new Error("not used");
        },
        async startAgent(params) {
          calls.push(["agent.start", params]);
          return { pane_id: "w1:p1" };
        },
      },
      sqlite,
    });

    await expect(
      orchestrator.startAgent({
        agentName: "claude-impl",
        herdrSessionName: "shepherd-main",
        profile: { args: ["--dangerously-skip-permissions"], command: "claude" },
        sessionId: session.id,
        taskSlug: "Implement Slack Sync",
        workingDirectory: "/repo",
      }),
    ).resolves.toMatchObject({
      agentName: "claude-impl",
      paneId: "w1:p1",
      tabId: "w1:agents",
      workspaceId: "w1",
    });

    expect(calls.at(-1)).toEqual([
      "agent.start",
      {
        args: ["--dangerously-skip-permissions"],
        command: "claude",
        cwd: "/repo",
        name: "claude-impl",
        tab_id: "w1:agents",
        workspace_id: "w1",
      },
    ]);
  });

  test("uses a client selected by Herdr session name", async () => {
    const { sqlite, store } = openMigratedDatabase();
    const session = store.createSession({ id: "session-abcdef123456" });
    const selectedSessions: string[] = [];
    const orchestrator = new HerdrOrchestrator({
      clientForSession(sessionName) {
        selectedSessions.push(sessionName);
        return {
          async createWorkspace() {
            return { workspace_id: "w1" };
          },
          async createTab(params) {
            return { tab_id: `w1:${params.label}` };
          },
          async readAgent() {
            throw new Error("not used");
          },
          async sendAgentMessage() {
            throw new Error("not used");
          },
          async startAgent() {
            return { pane_id: "w1:p1" };
          },
        };
      },
      sqlite,
    });

    await orchestrator.startAgent({
      agentName: "codex-review",
      herdrSessionName: "shepherd-api",
      profile: { command: "codex" },
      sessionId: session.id,
      taskSlug: "Review API",
      workingDirectory: "/repo",
    });

    expect(selectedSessions).toEqual(["shepherd-api", "shepherd-api"]);
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
