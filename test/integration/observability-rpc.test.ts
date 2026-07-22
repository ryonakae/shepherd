import { existsSync, mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test } from "vitest";
import type { AgentHistoryService } from "@/agent-history/service.js";
import { createAgentHistoryService, emptyCompactHistory } from "@/agent-history/service.js";
import { ObservabilityRpcClient } from "@/daemon/client.js";
import { ObservabilityRpcServer } from "@/daemon/observability-server.js";
import { AgentContextService } from "@/observability/agent-context-service.js";
import { AgentOrchestratorService } from "@/observability/agent-orchestrator-service.js";
import {
  cleanupTempDirs,
  openObservabilityDbHarness,
  tempDirs,
} from "./observability-db-harness.js";
import { RpcTestClient } from "./rpc-test-client.js";

const servers: ObservabilityRpcServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  cleanupTempDirs();
});

describe("ObservabilityRpcServer", () => {
  test("serves agent methods over JSONL", async () => {
    const { client, harness } = await openServer();
    seedAgent(harness);

    await expect(client.request("agent.list", { workspaceId: "wB" })).resolves.toMatchObject({
      agents: [expect.objectContaining({ agent: "pi", paneId: "wB:p1" })],
    });
    await expect(
      client.request("agent.get", { target: "pi", workspaceId: "wB" }),
    ).resolves.toMatchObject({
      agent: expect.objectContaining({ agent: "pi", paneId: "wB:p1" }),
    });
    await expect(
      client.request("agent.read", { limit: 10, target: "pi", workspaceId: "wB" }),
    ).resolves.toMatchObject({ agent: expect.objectContaining({ messages: [] }) });

    const event = harness.agentEvents.append({
      herdrSessionName: "default",
      payload: { to: "idle" },
      type: "agent.idle",
      workspaceId: "wB",
    });
    await expect(client.request("agent.events", { workspaceId: "wB" })).resolves.toMatchObject({
      events: [expect.objectContaining({ id: event.id, type: "agent.idle" })],
    });

    await expect(
      client.request("agent.orchestrator.register", {
        herdrSocketPath: "/tmp/herdr/herdr.sock",
        paneId: "wB:p1",
        sessionRef: {
          agent: "pi",
          kind: "path",
          source: "herdr:pi",
          value: "/tmp/pi-session.jsonl",
        },
        subscriberId: "pi-session",
        subscriberKind: "pi",
        workspaceId: "wB",
      }),
    ).resolves.toMatchObject({ events: [], presence: { terminalId: "term_1" }, state: null });
    await expect(
      client.request("agent.orchestrator.set", { enabled: true }),
    ).resolves.toMatchObject({
      changed: true,
      state: { owner: { terminalId: "term_1" } },
    });
    await expect(
      client.request("agent.notifications.ack", { eventId: event.id }),
    ).resolves.toMatchObject({
      acknowledged: true,
    });
    const removedMethod = ["agent", "telemetry"].join(".");
    await expect(
      client.request(removedMethod, {
        event: {},
        workspaceId: "wB",
      }),
    ).rejects.toThrow(`Unknown method: ${removedMethod}`);

    await expect(client.request("legacy.method", {})).rejects.toThrow("Unknown method");
    client.close();
    harness.sqlite.close();
  });

  test("resolves identifiers before live names and live names before kinds", async () => {
    const { client, harness } = await openServer();
    seedTargetAgents(harness);
    const listed = (await client.request("agent.list", { workspaceId: "wB" })) as {
      agents: Array<{ id: string; paneId: string }>;
    };
    const firstId = listed.agents.find((agent) => agent.paneId === "wB:p1")?.id;
    if (!firstId) throw new Error("Expected first agent id");
    seedTargetAgents(harness, firstId);

    await expect(
      client.request("agent.get", { target: "term_1", workspaceId: "wB" }),
    ).resolves.toMatchObject({ agent: { paneId: "wB:p1" } });
    await expect(
      client.request("agent.get", { target: firstId, workspaceId: "wB" }),
    ).resolves.toMatchObject({ agent: { paneId: "wB:p1" } });
    await expect(
      client.request("agent.get", { target: "reviewer", workspaceId: "wB" }),
    ).resolves.toMatchObject({ agent: { name: "reviewer", paneId: "wB:p1" } });
    await expect(
      client.request("agent.get", { target: "codex", workspaceId: "wB" }),
    ).resolves.toMatchObject({ agent: { name: "codex", paneId: "wB:p2" } });
    await expect(
      client.request("agent.get", { target: "claude", workspaceId: "wB" }),
    ).resolves.toMatchObject({ agent: { agent: "claude", paneId: "wB:p3" } });

    client.close();
    harness.sqlite.close();
  });

  test("reports ambiguity at the highest matching target priority", async () => {
    const { client, harness } = await openServer();
    seedAmbiguousTargetAgents(harness);

    const nameError = await client
      .request("agent.get", { target: "shared", workspaceId: "wB" })
      .catch((error: unknown) => error);
    expect(nameError).toBeInstanceOf(Error);
    expect((nameError as Error).message).toContain(
      "pane=wB:p1 terminal=term_1 name=shared agent=codex",
    );
    expect((nameError as Error).message).toContain(
      "pane=wB:p2 terminal=term_2 name=shared agent=reviewer",
    );
    expect((nameError as Error).message).not.toContain("pane=wB:p3");

    harness.agents.replaceForSession({
      agents: [
        {
          agent: "pi",
          agent_status: "idle",
          pane_id: "wB:p1",
          terminal_id: "term_1",
          workspace_id: "wB",
        },
        {
          agent: "pi",
          agent_status: "idle",
          pane_id: "wB:p2",
          terminal_id: "term_2",
          workspace_id: "wB",
        },
      ],
      herdrSessionName: "default",
    });
    await expect(client.request("agent.get", { target: "pi", workspaceId: "wB" })).rejects.toThrow(
      "pane=wB:p1 terminal=term_1 name=unnamed agent=pi; session=default workspace=wB pane=wB:p2 terminal=term_2 name=unnamed agent=pi",
    );

    client.close();
    harness.sqlite.close();
  });

  test("hides retained agents after their Herdr session stops", async () => {
    const { client, harness } = await openServer();
    seedAgent(harness);

    harness.herdrSessions.markStoppedMissingFrom([]);

    expect(
      harness.agents.findByPane({ herdrSessionName: "default", paneId: "wB:p1" }),
    ).toBeDefined();
    await expect(client.request("agent.list", { workspaceId: "wB" })).resolves.toEqual({
      agents: [],
    });
    await expect(client.request("agent.list", { all: true })).resolves.toEqual({ agents: [] });
    await expect(client.request("agent.get", { target: "pi", workspaceId: "wB" })).rejects.toThrow(
      "agent target not found: pi",
    );
    await expect(
      client.request("agent.read", { limit: 20, target: "pi", workspaceId: "wB" }),
    ).rejects.toThrow("agent target not found: pi");

    client.close();
    harness.sqlite.close();
  });

  test("reads additional runtime histories through agent.read", async () => {
    const { client, dir, harness } = await openServer();
    seedAdditionalRuntimeAgents(harness);
    const codexDir = join(dir, ".codex", "sessions", "2026", "07", "09");
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(
      join(codexDir, "rollout-2026-07-09T12-00-00-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee.jsonl"),
      `${JSON.stringify({ type: "session_meta", payload: { cwd: "/repo-codex" } })}\n${JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "codex user" } })}\n`,
    );

    const openCodeDir = join(dir, ".local", "share", "opencode");
    mkdirSync(openCodeDir, { recursive: true });
    const openCodeDbPath = join(openCodeDir, "opencode.db");
    const sqlite = new DatabaseSync(openCodeDbPath);
    sqlite.exec(`
      create table session (id text primary key, directory text not null, time_updated integer not null);
      create table message (id text primary key, session_id text not null, time_created integer not null, time_updated integer not null, data text not null);
      create table part (id text primary key, message_id text not null, session_id text not null, time_created integer not null, time_updated integer not null, data text not null);
    `);
    sqlite
      .prepare("insert into session (id, directory, time_updated) values (?, ?, ?)")
      .run("oc_1", "/repo-opencode", 1);
    sqlite
      .prepare(
        "insert into message (id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?)",
      )
      .run("m1", "oc_1", 1, 1, JSON.stringify({ role: "user" }));
    sqlite
      .prepare(
        "insert into part (id, message_id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?, ?)",
      )
      .run("p1", "m1", "oc_1", 2, 2, JSON.stringify({ type: "text", text: "opencode user" }));
    sqlite.close();

    const geminiProjectDir = join(dir, ".gemini", "tmp", "repo-gemini");
    const geminiChatsDir = join(geminiProjectDir, "chats");
    mkdirSync(geminiChatsDir, { recursive: true });
    writeFileSync(join(geminiProjectDir, ".project_root"), "/repo-gemini\n");
    writeFileSync(
      join(geminiChatsDir, "session-2026-07-09T12-00-00abcdef.json"),
      JSON.stringify({ messages: [{ id: "g1", type: "user", content: "gemini user" }] }),
    );

    await expect(
      client.request("agent.read", { limit: 10, target: "codex", workspaceId: "wB" }),
    ).resolves.toMatchObject({
      agent: {
        historyRef: { source: "codex-jsonl" },
        messages: [expect.objectContaining({ role: "user" })],
      },
    });
    await expect(
      client.request("agent.read", { limit: 10, target: "opencode", workspaceId: "wB" }),
    ).resolves.toMatchObject({
      agent: {
        historyRef: { source: "opencode-sqlite", value: "oc_1" },
        messages: [expect.objectContaining({ role: "user" })],
      },
    });
    await expect(
      client.request("agent.read", { limit: 10, target: "gemini", workspaceId: "wB" }),
    ).resolves.toMatchObject({
      agent: {
        historyRef: { source: "gemini-json" },
        messages: [expect.objectContaining({ role: "user" })],
      },
    });

    client.close();
    harness.sqlite.close();
  });

  test("routes events to the newest owner socket and role changes to the exact scope", async () => {
    const { harness, server, socketPath } = await openServerWithoutClient();
    seedRoutingAgents(harness);
    const [piA, piB, piC, generic] = await Promise.all([
      RpcTestClient.connect(socketPath),
      RpcTestClient.connect(socketPath),
      RpcTestClient.connect(socketPath),
      RpcTestClient.connect(socketPath),
    ]);
    await Promise.all([
      register(piA, "wB:p-a", "pi-a", "wB"),
      register(piB, "wB:p-b", "pi-b", "wB"),
      register(piC, "wC:p-c", "pi-c", "wC"),
      generic.request("agent.events", { workspaceId: "wB" }),
    ]);

    const beforeOwner = appendRoutedEvent(harness, "term_agent", "wB");
    server.publishAgentEvent(beforeOwner);
    await tick();
    expect(piA.notifications).toEqual([]);
    expect(piB.notifications).toEqual([]);

    await expect(piA.request("agent.orchestrator.set", { enabled: true })).resolves.toMatchObject({
      changed: true,
      state: { owner: { paneId: "wB:p-a", terminalId: "term_a" } },
    });
    await expect(piA.waitForNotification("agent.orchestrator.changed")).resolves.toMatchObject({
      params: { change: { reason: "claimed", current: { owner: { terminalId: "term_a" } } } },
    });
    await expect(piB.waitForNotification("agent.orchestrator.changed")).resolves.toBeDefined();
    expect(piC.notifications).toEqual([]);
    expect(generic.notifications).toEqual([]);

    const agentEvent = appendRoutedEvent(harness, "term_agent", "wB");
    server.publishAgentEvent(agentEvent);
    await expect(piA.waitForNotification("agent.event")).resolves.toMatchObject({
      params: { event: { id: agentEvent.id } },
    });
    expect(piB.notifications).toEqual([]);

    const self = appendRoutedEvent(harness, "term_a", "wB");
    server.publishAgentEvent(self);
    const unknownTerminal = harness.agentEvents.append({
      herdrSessionName: "default",
      payload: {},
      terminalId: null,
      type: "agent.done",
      workspaceId: "wB",
    });
    server.publishAgentEvent(unknownTerminal);
    await tick();
    expect(piA.notifications).toEqual([]);

    const replacement = await piB.request("agent.orchestrator.set", { enabled: true });
    expect(replacement).toMatchObject({
      changed: true,
      events: [
        expect.objectContaining({ id: agentEvent.id }),
        expect.objectContaining({ id: self.id }),
      ],
      state: { owner: { terminalId: "term_b" } },
    });
    await Promise.all([
      piA.waitForNotification("agent.orchestrator.changed"),
      piB.waitForNotification("agent.orchestrator.changed"),
    ]);

    await expect(piA.request("agent.notifications.ack", { eventId: self.id })).rejects.toThrow(
      "Only the current orchestrator",
    );
    await expect(
      piB.request("agent.notifications.ack", { eventId: agentEvent.id }),
    ).resolves.toMatchObject({
      acknowledged: true,
      state: { ackedEventId: agentEvent.id },
    });
    await expect(
      piB.request("agent.notifications.ack", { eventId: self.id }),
    ).resolves.toMatchObject({
      acknowledged: true,
      state: { ackedEventId: self.id },
    });
    await expect(piA.request("agent.orchestrator.set", { enabled: false })).resolves.toMatchObject({
      changed: false,
      state: { owner: { terminalId: "term_b" } },
    });
    await expect(piB.request("agent.orchestrator.set", { enabled: false })).resolves.toMatchObject({
      changed: true,
      state: { owner: null },
    });
    await Promise.all([
      piA.waitForNotification("agent.orchestrator.changed"),
      piB.waitForNotification("agent.orchestrator.changed"),
    ]);

    const ownerless = appendRoutedEvent(harness, "term_agent", "wB");
    await expect(piA.request("agent.orchestrator.set", { enabled: true })).resolves.toMatchObject({
      changed: true,
      events: [],
      state: { ackedEventId: ownerless.id, owner: { terminalId: "term_a" } },
    });

    piA.close();
    piB.close();
    piC.close();
    generic.close();
    harness.sqlite.close();
  });

  test("serves cached lists and uses the persisted ref only for live detail reads", async () => {
    const calls: string[] = [];
    const liveHistory = {
      async read(_input: unknown, options: { preferredRef?: { value: string } | null }) {
        calls.push(`read:${options.preferredRef?.value}`);
        return { historyRef: null, messages: [] };
      },
      async resolveCompactHistory(
        _input: unknown,
        options: { preferredRef?: { value: string } | null },
      ) {
        calls.push(`get:${options.preferredRef?.value}`);
        return {
          compactHistory: emptyCompactHistory("pi-jsonl"),
          historyRef: null,
          sourceFingerprint: null,
        };
      },
    } as unknown as AgentHistoryService;
    const { client, harness } = await openServer({ history: liveHistory });
    seedAgent(harness);
    const agent = harness.agents.findByPane({ herdrSessionName: "default", paneId: "wB:p1" });
    if (!agent) throw new Error("missing seeded agent");
    harness.agentContextSnapshots.put({
      agentId: agent.id,
      compactHistory: {
        ...emptyCompactHistory("pi-jsonl"),
        lastUserMessage: { ref: "cached", text: "cached user", timestamp: null },
      },
      historyRef: {
        kind: "discovered_file",
        path: "/tmp/history.jsonl",
        source: "pi-jsonl",
        value: "/tmp/history.jsonl",
      },
      paneRevision: null,
      sourceFingerprint: { mtimeMs: 1, path: "/tmp/history.jsonl", size: 1 },
    });
    await expect(client.request("agent.list", { workspaceId: "wB" })).resolves.toMatchObject({
      agents: [{ history: { lastUserMessage: { text: "cached user" } } }],
    });
    expect(calls).toEqual([]);
    await client.request("agent.get", { target: "pi", workspaceId: "wB" });
    await client.request("agent.read", { target: "pi", workspaceId: "wB" });
    expect(calls).toEqual(["get:/tmp/history.jsonl", "read:/tmp/history.jsonl"]);
    client.close();
    harness.sqlite.close();
  });

  test("returns and pushes context only to the current owner, including null clearing snapshots", async () => {
    const { harness, server, socketPath } = await openServerWithoutClient();
    seedRoutingAgents(harness);
    const agents = harness.agents.list({ workspaceId: "wB" });
    for (const agent of agents) {
      harness.agentContextSnapshots.put({
        agentId: agent.id,
        compactHistory: {
          ...emptyCompactHistory("pi-jsonl"),
          lastAssistantMessage: {
            ref: agent.terminalId ?? "unknown",
            text: agent.paneId,
            timestamp: null,
          },
        },
        historyRef: null,
        paneRevision: null,
        sourceFingerprint: null,
      });
    }
    const [owner, off, other] = await Promise.all([
      RpcTestClient.connect(socketPath),
      RpcTestClient.connect(socketPath),
      RpcTestClient.connect(socketPath),
    ]);
    await expect(register(owner, "wB:p-a", "owner", "wB")).resolves.toMatchObject({
      context: null,
    });
    await register(off, "wB:p-b", "off", "wB");
    await register(other, "wC:p-c", "other", "wC");
    await expect(owner.request("agent.orchestrator.set", { enabled: true })).resolves.toMatchObject(
      {
        context: { agents: [{ terminalId: "term_b" }] },
      },
    );
    await tick();
    owner.clearNotifications();
    off.clearNotifications();
    other.clearNotifications();
    server.publishAgentContext({ herdrSessionName: "default", workspaceId: "wB" });
    await expect(owner.waitForNotification("agent.context.changed")).resolves.toMatchObject({
      params: { context: { agents: [{ terminalId: "term_b" }] }, workspaceId: "wB" },
    });
    await tick();
    expect(off.notifications).toEqual([]);
    expect(other.notifications).toEqual([]);

    const offAgent = agents.find((agent) => agent.terminalId === "term_b");
    if (!offAgent) throw new Error("missing off agent");
    harness.agentContextSnapshots.delete(offAgent.id);
    server.publishAgentContext({ herdrSessionName: "default", workspaceId: "wB" });
    await expect(owner.waitForNotification("agent.context.changed")).resolves.toMatchObject({
      params: { context: null, workspaceId: "wB" },
    });
    owner.close();
    off.close();
    other.close();
    harness.sqlite.close();
  });

  test("validates indexed presence and resolves a stale pane alias from live Herdr", async () => {
    const { harness, socketPath } = await openServerWithoutClient({
      resolvePaneIdentity: async () => ({
        paneId: "wC:p2",
        terminalId: "term_moved",
        workspaceId: "wC",
      }),
    });
    harness.herdrSessions.upsertRunning({
      name: "default",
      sessionDir: "/tmp/herdr",
      socketPath: "/tmp/herdr/herdr.sock",
    });
    const client = await RpcTestClient.connect(socketPath);

    await expect(register(client, "wB:p-old", "pi-moved", "wB")).resolves.toMatchObject({
      presence: {
        herdrSessionName: "default",
        paneId: "wC:p2",
        terminalId: "term_moved",
        workspaceId: "wC",
      },
    });
    await expect(
      client.request("agent.orchestrator.register", {
        herdrSocketPath: "/tmp/unknown.sock",
        paneId: "wB:p1",
        sessionRef: {
          agent: "pi",
          kind: "path",
          source: "herdr:pi",
          value: "/tmp/pi-session.jsonl",
        },
        subscriberId: "pi-unknown",
        subscriberKind: "pi",
        workspaceId: "wB",
      }),
    ).rejects.toThrow("running session");
    await expect(
      client.request("agent.orchestrator.register", {
        herdrSocketPath: "/tmp/herdr/herdr.sock",
        paneId: "wB:p1",
        sessionRef: {
          agent: "pi",
          kind: "path",
          source: "herdr:pi",
          value: "/tmp/pi-session.jsonl",
        },
        subscriberId: "bad-kind",
        subscriberKind: "claude",
        workspaceId: "wB",
      }),
    ).rejects.toThrow("Invalid RPC params");

    client.close();
    harness.sqlite.close();
  });
});

async function openServer(options: Parameters<typeof openServerWithoutClient>[0] = {}) {
  const { dir, harness, server, socketPath } = await openServerWithoutClient(options);
  const client = new ObservabilityRpcClient({ socketPath });
  return { client, dir, harness, server };
}

async function openServerWithoutClient(
  options: {
    history?: AgentHistoryService;
    resolvePaneIdentity?: () => Promise<{
      paneId: string;
      terminalId: string;
      workspaceId: string;
    }>;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-agent-rpc-"));
  tempDirs.push(dir);
  const socketPath = join(dir, "rpc.sock");
  if (existsSync(socketPath)) unlinkSync(socketPath);
  const harness = openObservabilityDbHarness();
  const history =
    options.history ??
    createAgentHistoryService({ cache: harness.agentHistoryCache, homeDir: dir });
  const context = new AgentContextService({
    history,
    stores: { agentContextSnapshots: harness.agentContextSnapshots, agents: harness.agents },
  });
  const server = new ObservabilityRpcServer({
    context,
    history,
    orchestrator: new AgentOrchestratorService({
      agentEvents: harness.agentEvents,
      agents: harness.agents,
      scopes: harness.agentOrchestratorScopes,
    }),
    ...(options.resolvePaneIdentity ? { resolvePaneIdentity: options.resolvePaneIdentity } : {}),
    socketPath,
    stores: {
      agentEvents: harness.agentEvents,
      agents: harness.agents,
      herdrSessions: harness.herdrSessions,
      herdrWorkspaces: harness.herdrWorkspaces,
    },
  });
  servers.push(server);
  await server.start();
  return { dir, harness, server, socketPath };
}

function register(
  client: RpcTestClient,
  paneId: string,
  subscriberId: string,
  workspaceId: string,
): Promise<unknown> {
  return client.request("agent.orchestrator.register", {
    herdrSocketPath: "/tmp/herdr/herdr.sock",
    paneId,
    sessionRef: {
      agent: "pi",
      kind: "path",
      source: "herdr:pi",
      value: "/tmp/pi-session.jsonl",
    },
    subscriberId,
    subscriberKind: "pi",
    workspaceId,
  });
}

function appendRoutedEvent(
  harness: ReturnType<typeof openObservabilityDbHarness>,
  terminalId: string,
  workspaceId: string,
) {
  return harness.agentEvents.append({
    herdrSessionName: "default",
    payload: {},
    terminalId,
    type: "agent.done",
    workspaceId,
  });
}

function seedRoutingAgents(harness: ReturnType<typeof openObservabilityDbHarness>) {
  harness.herdrSessions.upsertRunning({
    name: "default",
    sessionDir: "/tmp/herdr",
    socketPath: "/tmp/herdr/herdr.sock",
  });
  harness.agents.replaceForSession({
    agents: [
      { agent: "pi", pane_id: "wB:p-a", terminal_id: "term_a", workspace_id: "wB" },
      { agent: "pi", pane_id: "wB:p-b", terminal_id: "term_b", workspace_id: "wB" },
      { agent: "pi", pane_id: "wC:p-c", terminal_id: "term_c", workspace_id: "wC" },
    ],
    herdrSessionName: "default",
  });
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

function seedAdditionalRuntimeAgents(harness: ReturnType<typeof openObservabilityDbHarness>) {
  harness.herdrSessions.upsertRunning({
    name: "default",
    sessionDir: "/tmp/herdr",
    socketPath: "/tmp/herdr/herdr.sock",
  });
  harness.agents.replaceForSession({
    agents: [
      {
        agent: "codex",
        agent_status: "idle",
        cwd: "/repo-codex",
        pane_id: "wB:p-codex",
        terminal_id: "term_codex",
        workspace_id: "wB",
      },
      {
        agent: "opencode",
        agent_status: "idle",
        cwd: "/repo-opencode",
        pane_id: "wB:p-opencode",
        terminal_id: "term_opencode",
        workspace_id: "wB",
      },
      {
        agent: "gemini",
        agent_status: "idle",
        cwd: "/repo-gemini",
        pane_id: "wB:p-gemini",
        terminal_id: "term_gemini",
        workspace_id: "wB",
      },
    ],
    herdrSessionName: "default",
  });
}

function seedAmbiguousTargetAgents(harness: ReturnType<typeof openObservabilityDbHarness>) {
  harness.herdrSessions.upsertRunning({
    name: "default",
    sessionDir: "/tmp/herdr",
    socketPath: "/tmp/herdr/herdr.sock",
  });
  harness.agents.replaceForSession({
    agents: [
      {
        agent: "codex",
        agent_status: "idle",
        name: "shared",
        pane_id: "wB:p1",
        terminal_id: "term_1",
        workspace_id: "wB",
      },
      {
        agent: "reviewer",
        agent_status: "idle",
        name: "shared",
        pane_id: "wB:p2",
        terminal_id: "term_2",
        workspace_id: "wB",
      },
      {
        agent: "shared",
        agent_status: "idle",
        name: "other",
        pane_id: "wB:p3",
        terminal_id: "term_3",
        workspace_id: "wB",
      },
    ],
    herdrSessionName: "default",
  });
}

function seedTargetAgents(
  harness: ReturnType<typeof openObservabilityDbHarness>,
  firstAgentId?: string,
) {
  harness.herdrSessions.upsertRunning({
    name: "default",
    sessionDir: "/tmp/herdr",
    socketPath: "/tmp/herdr/herdr.sock",
  });
  harness.agents.replaceForSession({
    agents: [
      {
        agent: "codex",
        agent_status: "idle",
        name: "reviewer",
        pane_id: "wB:p1",
        terminal_id: "term_1",
        workspace_id: "wB",
      },
      {
        agent: "reviewer",
        agent_status: "idle",
        name: "codex",
        pane_id: "wB:p2",
        terminal_id: "term_2",
        workspace_id: "wB",
      },
      {
        agent: "claude",
        agent_status: "idle",
        name: firstAgentId ?? "term_1",
        pane_id: "wB:p3",
        terminal_id: "term_3",
        workspace_id: "wB",
      },
    ],
    herdrSessionName: "default",
  });
}

function seedAgent(harness: ReturnType<typeof openObservabilityDbHarness>) {
  harness.herdrSessions.upsertRunning({
    name: "default",
    sessionDir: "/tmp/herdr",
    socketPath: "/tmp/herdr/herdr.sock",
  });
  harness.agents.replaceForSession({
    agents: [
      {
        agent: "pi",
        agent_status: "idle",
        cwd: "/repo",
        pane_id: "wB:p1",
        terminal_id: "term_1",
        workspace_id: "wB",
      },
    ],
    herdrSessionName: "default",
  });
}
