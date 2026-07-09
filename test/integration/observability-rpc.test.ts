import { existsSync, mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test } from "vitest";
import { createAgentHistoryService } from "@/agent-history/service.js";
import { ObservabilityRpcClient } from "@/daemon/client.js";
import { ObservabilityRpcServer } from "@/daemon/observability-server.js";
import { AgentNotificationService } from "@/observability/agent-notification-service.js";
import { encodeJsonLine, JsonLineDecoder } from "@/shared/json-lines.js";
import {
  cleanupTempDirs,
  openObservabilityDbHarness,
  tempDirs,
} from "./observability-db-harness.js";

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

    const subscription = await client.request("agent.notifications.subscribe", {
      subscriberId: "pi-session",
      subscriberKind: "pi",
      workspaceId: "wB",
    });
    expect(subscription).toMatchObject({
      events: [expect.objectContaining({ id: event.id })],
      subscription: { id: expect.stringMatching(/^ans_/) },
    });
    const subscriptionId = (subscription as { subscription: { id: string } }).subscription.id;
    await expect(
      client.request("agent.notifications.ack", { eventId: event.id, subscriptionId }),
    ).resolves.toEqual({ acknowledged: true });

    await expect(client.request("legacy.method", {})).rejects.toThrow("Unknown method");
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

  test("streams agent.event notifications", async () => {
    const { harness, server, socketPath } = await openServerWithoutClient();
    const socket = createConnection(socketPath);
    const decoder = new JsonLineDecoder();
    const messages: unknown[] = [];
    socket.on("data", (chunk) => messages.push(...decoder.push(chunk.toString("utf8"))));
    socket.write(encodeJsonLine({ id: 1, method: "agent.events", params: {} }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    harness.herdrSessions.upsertRunning({
      name: "default",
      sessionDir: "/tmp/herdr",
      socketPath: "/tmp/herdr/herdr.sock",
    });
    const event = harness.agentEvents.append({
      herdrSessionName: "default",
      payload: {},
      type: "agent.idle",
      workspaceId: "wB",
    });
    server.publishAgentEvent(event);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(messages).toContainEqual(expect.objectContaining({ method: "agent.event" }));
    socket.destroy();
    harness.sqlite.close();
  });
});

async function openServer() {
  const { dir, harness, server, socketPath } = await openServerWithoutClient();
  const client = new ObservabilityRpcClient({ socketPath });
  return { client, dir, harness, server };
}

async function openServerWithoutClient() {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-agent-rpc-"));
  tempDirs.push(dir);
  const socketPath = join(dir, "rpc.sock");
  if (existsSync(socketPath)) unlinkSync(socketPath);
  const harness = openObservabilityDbHarness();
  const server = new ObservabilityRpcServer({
    history: createAgentHistoryService({ cache: harness.agentHistoryCache, homeDir: dir }),
    notifications: new AgentNotificationService({ cursors: harness.agentNotificationCursors }),
    socketPath,
    stores: {
      agentEvents: harness.agentEvents,
      agents: harness.agents,
      herdrWorkspaces: harness.herdrWorkspaces,
    },
  });
  servers.push(server);
  await server.start();
  return { dir, harness, server, socketPath };
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
