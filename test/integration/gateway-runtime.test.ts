import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModel, ToolSet } from "ai";
import { afterEach, describe, expect, test } from "vitest";
import type { ShepherdConfig } from "@/config/schema.js";
import { applyMigrations } from "@/db/apply-migrations.js";
import { openSqlite } from "@/db/client.js";
import { EventStore } from "@/db/event-store.js";
import { createGatewayRuntime } from "@/gateway/runtime.js";
import type { HerdrControlClient } from "@/herdr/orchestrator.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("createGatewayRuntime", () => {
  test("wires config, Codex provider, Herdr clients, and builtin tools", async () => {
    const { events, sqlite } = openMigratedDatabase();
    const session = events.createSession({ id: "session-abcdef123456" });
    const closed: string[] = [];
    const startedAgents: unknown[] = [];
    const runtime = createGatewayRuntime({
      config: openConfig(),
      createCodexProvider() {
        const provider = () => "codex-model" as unknown as LanguageModel;
        provider.close = async () => {
          closed.push("codex");
        };
        return provider;
      },
      createHerdrClient(sessionName) {
        return openFakeHerdrClient(sessionName, { closed, startedAgents });
      },
      events,
      generateText: async (options) => {
        await executeAiTool(options.tools ?? {}, "herdr_start_agent", {
          agentName: "claude-impl",
          agentProfile: "claude",
          taskSlug: "Implement Runtime",
          workingContextSlug: "main",
          workingDirectory: "/repo",
        });
        return { text: "Started Claude in Herdr." };
      },
      sqlite,
    });

    await expect(
      runtime.runner.runTurn({
        messages: [{ content: "start implementation", role: "user" }],
        sessionId: session.id,
      }),
    ).resolves.toEqual({ text: "Started Claude in Herdr." });

    await runtime.close();

    expect(startedAgents).toEqual([
      {
        args: ["--dangerously-skip-permissions"],
        command: "claude",
        cwd: "/repo",
        name: "claude-impl",
        tab_id: "w1:agents",
        workspace_id: "w1",
      },
    ]);
    expect(closed).toEqual(["codex", "shepherd-main"]);
  });
});

function executeAiTool(tools: ToolSet, name: string, input: unknown): Promise<unknown> {
  const candidate = tools[name] as { execute?: (input: unknown) => Promise<unknown> } | undefined;
  if (!candidate?.execute) {
    throw new Error(`Missing AI SDK tool: ${name}`);
  }

  return candidate.execute(input);
}

function openConfig(): ShepherdConfig {
  return {
    agents: {
      claude: { args: ["--dangerously-skip-permissions"], command: "claude" },
    },
    default_agent: "claude",
    gateway: {
      default_provider: "codex",
      model: "gpt-5.3-codex",
    },
    providers: {
      codex: {
        auth_source: "codex_cli",
        mode: "app_server",
        type: "codex_cli",
      },
    },
  };
}

function openFakeHerdrClient(
  sessionName: string,
  state: { closed: string[]; startedAgents: unknown[] },
): HerdrControlClient & { close(): void } {
  return {
    close() {
      state.closed.push(sessionName);
    },
    async createTab(params) {
      return { tab_id: `w1:${params.label}` };
    },
    async createWorkspace() {
      return { workspace_id: "w1" };
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
      return [{ target: "claude" }];
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
      return { text: "ready" };
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
    async startAgent(params) {
      state.startedAgents.push(params);
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
  };
}

function openMigratedDatabase(): {
  events: EventStore;
  sqlite: ReturnType<typeof openSqlite>["sqlite"];
} {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-gateway-runtime-"));
  tempDirs.push(dir);

  const { sqlite } = openSqlite(join(dir, "test.sqlite"));
  applyMigrations(sqlite, { migrationsFolder: "drizzle" });
  return { events: new EventStore(sqlite), sqlite };
}
