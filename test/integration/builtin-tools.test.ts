import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { applyMigrations } from "@/db/apply-migrations.js";
import { openSqlite } from "@/db/client.js";
import { EventStore } from "@/db/event-store.js";
import { createBuiltinToolRegistry } from "@/gateway/builtin-tools.js";
import { LogicalToolRunner } from "@/gateway/tools.js";
import { HerdrOrchestrator } from "@/herdr/orchestrator.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("builtin logical tools", () => {
  test("session_read returns events from the current Shepherd session", async () => {
    const { events, runner, sessionId } = openRunner();
    const event = events.appendEvent({
      payload: { text: "hello" },
      sessionId,
      type: "user.message",
    });

    await expect(runner.run("session_read", { afterEventId: 0 }, { sessionId })).resolves.toEqual([
      event,
    ]);
  });

  test("ensure_herdr_workspace delegates to Herdr orchestration", async () => {
    const { runner, sessionId } = openRunner();

    await expect(
      runner.run(
        "ensure_herdr_workspace",
        {
          taskSlug: "Review Slack Sync",
          workingContextSlug: "shepherd",
          workingDirectory: "/repo",
        },
        { sessionId },
      ),
    ).resolves.toMatchObject({
      herdrSessionName: "shepherd-shepherd",
      workspaceId: "w1",
    });
  });

  test("herdr_start_agent uses configured agent profiles", async () => {
    const { runner, sessionId } = openRunner();

    await expect(
      runner.run(
        "herdr_start_agent",
        {
          agentName: "claude-impl",
          agentProfile: "claude",
          taskSlug: "Implement Slack Sync",
          workingContextSlug: "shepherd",
          workingDirectory: "/repo",
        },
        { sessionId },
      ),
    ).resolves.toMatchObject({
      agentName: "claude-impl",
      paneId: "w1:p1",
    });
  });

  test("herdr_send_agent_message and herdr_read_agent delegate to Herdr", async () => {
    const { runner, sessionId } = openRunner();

    await expect(
      runner.run(
        "herdr_send_agent_message",
        { target: "w1:p1", text: "please implement", workingContextSlug: "shepherd" },
        { sessionId },
      ),
    ).resolves.toEqual({ sent: true });
    await expect(
      runner.run(
        "herdr_read_agent",
        { lines: 50, source: "recent", target: "w1:p1", workingContextSlug: "shepherd" },
        { sessionId },
      ),
    ).resolves.toEqual({ text: "agent output" });
  });
});

function openRunner(): {
  events: EventStore;
  runner: LogicalToolRunner;
  sessionId: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-builtin-tools-"));
  tempDirs.push(dir);

  const { sqlite } = openSqlite(join(dir, "test.sqlite"));
  applyMigrations(sqlite, { migrationsFolder: "drizzle" });
  const events = new EventStore(sqlite);
  const session = events.createSession({ id: "session-abcdef123456" });
  const herdr = new HerdrOrchestrator({
    herdr: {
      async createWorkspace() {
        return { workspace_id: "w1" };
      },
      async createTab(params) {
        return { tab_id: `w1:${params.label}` };
      },
      async readAgent() {
        return { text: "agent output" };
      },
      async sendAgentMessage() {
        return { sent: true };
      },
      async startAgent() {
        return { pane_id: "w1:p1" };
      },
    },
    sqlite,
  });
  const registry = createBuiltinToolRegistry({
    agents: {
      claude: { args: ["--dangerously-skip-permissions"], command: "claude" },
    },
    events,
    herdr,
  });
  const runner = new LogicalToolRunner({
    events,
    policy: { allowedTools: new Set(registry.list().map((tool) => tool.name)) },
    registry,
  });

  return { events, runner, sessionId: session.id };
}
