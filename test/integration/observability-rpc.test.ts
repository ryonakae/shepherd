import { existsSync, mkdtempSync, unlinkSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

    await expect(client.request("workspace.snapshot", {})).rejects.toThrow("Unknown method");
    await expect(client.request("worker.events", {})).rejects.toThrow("Unknown method");
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
  const { harness, server, socketPath } = await openServerWithoutClient();
  const client = new ObservabilityRpcClient({ socketPath });
  return { client, harness, server };
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
  return { harness, server, socketPath };
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
