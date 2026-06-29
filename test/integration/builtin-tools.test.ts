import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { applyMigrations } from "@/db/apply-migrations.js";
import { openSqlite } from "@/db/client.js";
import { EventStore } from "@/db/event-store.js";
import { WorkingContextStore } from "@/db/working-contexts.js";
import { createBuiltinToolRegistry } from "@/gateway/builtin-tools.js";
import { LogicalToolRunner } from "@/gateway/tools.js";
import { WorkingContextResolver } from "@/gateway/working-contexts.js";
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

  test("attach_herdr_workspace records an explicit existing Herdr binding", async () => {
    const { runner, sessionId } = openRunner();

    await expect(
      runner.run(
        "attach_herdr_workspace",
        {
          confirmedUserRequestedAttach: true,
          herdrSessionName: "manual-main",
          tabs: { agents: "w1:t1" },
          workspaceId: "w1",
        },
        { sessionId },
      ),
    ).resolves.toEqual({
      herdrSessionName: "manual-main",
      tabs: { agents: "w1:t1" },
      workspaceId: "w1",
    });

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
      herdrSessionName: "manual-main",
      workspaceId: "w1",
    });
  });

  test("working context tools discover and resolve allowed project roots", async () => {
    const { runner, sessionId } = openRunner({ allowedRoots: ["/repo"] });

    await expect(
      runner.run("workspace_discovery", { scanAllowedRoots: false }, { sessionId }),
    ).resolves.toMatchObject({
      allowedRoots: ["/repo"],
      candidates: [],
      recent: [],
    });
    await expect(
      runner.run(
        "resolve_working_context",
        { label: "Shepherd", path: "/repo/shepherd" },
        { sessionId },
      ),
    ).resolves.toMatchObject({
      herdrSessionName: "shepherd-shepherd",
      label: "Shepherd",
      path: "/repo/shepherd",
      slug: "shepherd",
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

  test("herdr_read inspects Herdr resources by working context", async () => {
    const { runner, sessionId } = openRunner();

    await expect(
      runner.run(
        "herdr_read",
        { resource: "workspaces", workingContextSlug: "shepherd" },
        { sessionId },
      ),
    ).resolves.toEqual([{ workspace_id: "w1" }]);
    await expect(
      runner.run(
        "herdr_read",
        { paneId: "w1:p1", resource: "pane", workingContextSlug: "shepherd" },
        { sessionId },
      ),
    ).resolves.toEqual({ pane_id: "w1:p1" });
  });

  test("herdr_read requires ids for singular resources", async () => {
    const { runner, sessionId } = openRunner();

    await expect(
      runner.run("herdr_read", { resource: "pane", workingContextSlug: "shepherd" }, { sessionId }),
    ).rejects.toThrow("paneId is required for pane reads");
  });

  test("herdr_read validates known resource names", async () => {
    const { runner, sessionId } = openRunner();

    await expect(
      runner.run(
        "herdr_read",
        { resource: "servers", workingContextSlug: "shepherd" },
        { sessionId },
      ),
    ).rejects.toThrow("Invalid input for logical tool");
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

  test("builtin registry exposes canonical Shepherd/Herdr tools only", () => {
    const { runner } = openRunner();
    const tools = runner.list();

    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [
        "attach_herdr_workspace",
        "ensure_herdr_workspace",
        "herdr_read",
        "herdr_read_agent",
        "herdr_send_agent_message",
        "herdr_start_agent",
        "open_pane",
        "read_pane",
        "resolve_working_context",
        "run_pane_command",
        "send_pane_text",
        "session_read",
        "wait_for_agent",
        "wait_for_herdr_event",
        "workspace_discovery",
      ].sort(),
    );
    expect(tools.filter((tool) => !tool.promptSnippet)).toEqual([]);

    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    expect(byName.get("resolve_working_context")?.promptGuidelines).toContain(
      "Use shepherd_resolve_working_context before creating Herdr resources when the working context is ambiguous.",
    );
    expect(byName.get("attach_herdr_workspace")?.promptGuidelines).toContain(
      "Use shepherd_attach_herdr_workspace only when the user explicitly asks to attach an existing non-Shepherd Herdr workspace.",
    );
    expect(byName.get("run_pane_command")?.promptGuidelines).toContain(
      "Use shepherd_run_pane_command only inside Shepherd-managed Herdr panes for tests, servers, logs, and controlled terminal workflows.",
    );
  });

  test("pane tools delegate to Herdr", async () => {
    const { runner, sessionId } = openRunner();

    await expect(
      runner.run(
        "open_pane",
        {
          direction: "right",
          taskSlug: "Run Tests",
          workingContextSlug: "shepherd",
          workingDirectory: "/repo",
        },
        { sessionId },
      ),
    ).resolves.toMatchObject({ paneId: "w1:p2" });
    await expect(
      runner.run(
        "run_pane_command",
        { command: "pnpm test", paneId: "w1:p2", workingContextSlug: "shepherd" },
        { sessionId },
      ),
    ).resolves.toEqual({ ran: true });
    await expect(
      runner.run(
        "read_pane",
        { lines: 20, paneId: "w1:p2", source: "recent", workingContextSlug: "shepherd" },
        { sessionId },
      ),
    ).resolves.toEqual({ text: "pane output" });
    await expect(
      runner.run(
        "send_pane_text",
        { paneId: "w1:p2", text: "hello", workingContextSlug: "shepherd" },
        { sessionId },
      ),
    ).resolves.toEqual({ sentText: true });
    await expect(
      runner.run(
        "wait_for_agent",
        { status: "idle", target: "w1:p1", workingContextSlug: "shepherd" },
        { sessionId },
      ),
    ).resolves.toEqual({ status: "idle" });
    await expect(
      runner.run(
        "wait_for_herdr_event",
        { match: "done", paneId: "w1:p2", workingContextSlug: "shepherd" },
        { sessionId },
      ),
    ).resolves.toEqual({ matched: true });
  });
});

function openRunner(options: { allowedRoots?: string[] } = {}): {
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
      async focusAgent() {
        return { focused: true };
      },
      async focusWorkspace() {
        return { focused: true };
      },
      async getAgent(params) {
        return { target: params.target };
      },
      async getPane(params) {
        return { pane_id: params.pane_id };
      },
      async getTab(params) {
        return { tab_id: params.tab_id };
      },
      async getWorkspace(params) {
        return { workspace_id: params.workspace_id };
      },
      async listAgents() {
        return [{ target: "claude-impl" }];
      },
      async listPanes() {
        return [{ pane_id: "w1:p1" }];
      },
      async listTabs() {
        return [{ tab_id: "w1:agents" }];
      },
      async listWorkspaces() {
        return [{ workspace_id: "w1" }];
      },
      async readPane() {
        return { text: "pane output" };
      },
      async readAgent() {
        return { text: "agent output" };
      },
      async runPaneCommand() {
        return { ran: true };
      },
      async sendPaneText() {
        return { sentText: true };
      },
      async sendAgentMessage() {
        return { sent: true };
      },
      async splitPane() {
        return { pane_id: "w1:p2" };
      },
      async startAgent() {
        return { pane_id: "w1:p1" };
      },
      async waitForAgent() {
        return { status: "idle" };
      },
      async waitForEvent() {
        return { type: "agent.status" };
      },
      async waitForOutput() {
        return { matched: true };
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
    workingContexts: new WorkingContextResolver({
      allowedRoots: options.allowedRoots ?? [],
      store: new WorkingContextStore(sqlite),
    }),
  });
  const runner = new LogicalToolRunner({
    events,
    policy: { allowedTools: new Set(registry.list().map((tool) => tool.name)) },
    registry,
  });

  return { events, runner, sessionId: session.id };
}
