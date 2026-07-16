import { existsSync, mkdtempSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createAgentHistoryService } from "@/agent-history/service.js";
import { ObservabilityRpcServer } from "@/daemon/observability-server.js";
import { AgentContextService } from "@/observability/agent-context-service.js";
import { AgentOrchestratorService } from "@/observability/agent-orchestrator-service.js";
import type { AgentIndexRecord } from "@/observability/contracts.js";
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

describe("orchestrator pane movement", () => {
  test("updates non-owner presence from terminal identity and retains absent terminals", async () => {
    const { harness, server, socketPath } = await openServer();
    seedAgents(harness);
    const piA = await RpcTestClient.connect(socketPath);
    await register(piA, "wA:p-a", "pi-a", "wA");

    const moved = replaceAgents(harness, [
      snapshot("term_a", "wB:p-a-moved", "wB"),
      snapshot("term_peer", "wA:p-peer", "wA"),
      snapshot("term_b", "wB:p-b", "wB"),
    ]);
    server.reconcileAgentLocations({ agents: moved, herdrSessionName: "default" });
    await expect(piA.request("agent.orchestrator.get", {})).resolves.toMatchObject({
      presence: {
        herdrSessionName: "default",
        paneId: "wB:p-a-moved",
        terminalId: "term_a",
        workspaceId: "wB",
      },
    });
    await expect(piA.request("agent.orchestrator.set", { enabled: true })).resolves.toMatchObject({
      state: { herdrSessionName: "default", workspaceId: "wB" },
    });

    server.reconcileAgentLocations({ agents: [], herdrSessionName: "default" });
    await expect(piA.request("agent.orchestrator.get", {})).resolves.toMatchObject({
      presence: { paneId: "wB:p-a-moved", workspaceId: "wB" },
    });
    server.reconcileAgentLocations({
      agents: [otherSessionAgent("term_a", "wX:p1", "wX")],
      herdrSessionName: "other",
    });
    await expect(piA.request("agent.orchestrator.get", {})).resolves.toMatchObject({
      presence: { paneId: "wB:p-a-moved", workspaceId: "wB" },
    });

    piA.close();
    harness.sqlite.close();
  });

  test("moves an owner across workspaces, replaces the destination, and routes by new scope", async () => {
    const { harness, orchestrator, server, socketPath } = await openServer();
    seedAgents(harness);
    const [piA, sourcePeer, piB] = await Promise.all([
      RpcTestClient.connect(socketPath),
      RpcTestClient.connect(socketPath),
      RpcTestClient.connect(socketPath),
    ]);
    await Promise.all([
      register(piA, "wA:p-a", "pi-a", "wA"),
      register(sourcePeer, "wA:p-peer", "pi-peer", "wA"),
      register(piB, "wB:p-b", "pi-b", "wB"),
    ]);
    const sourceBaseline = appendEvent(harness, "term_peer", "wA");
    const targetBaseline = appendEvent(harness, "term_agent", "wB");
    await piA.request("agent.orchestrator.set", { enabled: true });
    await piB.request("agent.orchestrator.set", { enabled: true });
    await Promise.all([
      piA.waitForNotification("agent.orchestrator.changed"),
      sourcePeer.waitForNotification("agent.orchestrator.changed"),
      piB.waitForNotification("agent.orchestrator.changed"),
    ]);
    const sourceAck = appendEvent(harness, "term_peer", "wA");
    const targetAck = appendEvent(harness, "term_agent", "wB");
    await piA.request("agent.notifications.ack", { eventId: sourceAck.id });
    await piB.request("agent.notifications.ack", { eventId: targetAck.id });
    piA.clearNotifications();
    sourcePeer.clearNotifications();
    piB.clearNotifications();

    const moved = replaceAgents(harness, [
      snapshot("term_a", "wB:p-a-moved", "wB"),
      snapshot("term_peer", "wA:p-peer", "wA"),
      snapshot("term_b", "wB:p-b", "wB"),
    ]);
    server.reconcileAgentLocations({ agents: moved, herdrSessionName: "default" });

    expect(orchestrator.status({ herdrSessionName: "default", workspaceId: "wA" })).toMatchObject({
      ackedEventId: sourceAck.id,
      owner: null,
    });
    expect(orchestrator.status({ herdrSessionName: "default", workspaceId: "wB" })).toMatchObject({
      ackedEventId: targetAck.id,
      owner: { paneId: "wB:p-a-moved", terminalId: "term_a" },
    });
    expect(sourceBaseline.id).toBeLessThan(sourceAck.id);
    expect(targetBaseline.id).toBeLessThan(targetAck.id);
    await expect(
      sourcePeer.waitForNotification("agent.orchestrator.changed"),
    ).resolves.toMatchObject({
      params: { change: { current: { owner: null, workspaceId: "wA" }, reason: "moved" } },
    });
    await expect(piB.waitForNotification("agent.orchestrator.changed")).resolves.toMatchObject({
      params: {
        change: {
          current: { owner: { terminalId: "term_a" }, workspaceId: "wB" },
          previous: { owner: { terminalId: "term_b" } },
          reason: "moved",
        },
      },
    });
    await expect(piA.waitForNotification("agent.orchestrator.changed")).resolves.toMatchObject({
      params: { change: { current: { owner: { terminalId: "term_a" }, workspaceId: "wB" } } },
    });
    await expect(piA.request("agent.orchestrator.get", {})).resolves.toMatchObject({
      presence: { paneId: "wB:p-a-moved", workspaceId: "wB" },
    });

    piA.clearNotifications();
    piB.clearNotifications();
    sourcePeer.clearNotifications();
    server.reconcileAgentLocations({ agents: moved, herdrSessionName: "default" });
    await socketTick();
    expect(piA.notifications).toEqual([]);
    expect(piB.notifications).toEqual([]);
    expect(sourcePeer.notifications).toEqual([]);

    const oldScopeEvent = appendEvent(harness, "term_peer", "wA");
    server.publishAgentEvent(oldScopeEvent);
    await socketTick();
    expect(piA.notifications).toEqual([]);
    const destinationEvent = appendEvent(harness, "term_b", "wB");
    server.publishAgentEvent(destinationEvent);
    await expect(piA.waitForNotification("agent.event")).resolves.toMatchObject({
      params: { event: { id: destinationEvent.id } },
    });
    const selfEvent = appendEvent(harness, "term_a", "wB");
    server.publishAgentEvent(selfEvent);
    await socketTick();
    expect(piA.notifications).toEqual([]);

    const sameWorkspace = replaceAgents(harness, [
      snapshot("term_a", "wB:p-a-new", "wB"),
      snapshot("term_peer", "wA:p-peer", "wA"),
      snapshot("term_b", "wB:p-b", "wB"),
    ]);
    server.reconcileAgentLocations({ agents: sameWorkspace, herdrSessionName: "default" });
    await expect(piA.waitForNotification("agent.orchestrator.changed")).resolves.toMatchObject({
      params: {
        change: {
          current: { owner: { paneId: "wB:p-a-new" }, workspaceId: "wB" },
          reason: "moved",
        },
      },
    });
    expect(orchestrator.status({ herdrSessionName: "default", workspaceId: "wB" })).toMatchObject({
      ackedEventId: targetAck.id,
      owner: { paneId: "wB:p-a-new" },
    });

    piA.close();
    sourcePeer.close();
    piB.close();
    harness.sqlite.close();
  });
});

async function openServer() {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-pane-move-"));
  tempDirs.push(dir);
  const socketPath = join(dir, "rpc.sock");
  if (existsSync(socketPath)) unlinkSync(socketPath);
  const harness = openObservabilityDbHarness();
  const orchestrator = new AgentOrchestratorService({
    agentEvents: harness.agentEvents,
    agents: harness.agents,
    scopes: harness.agentOrchestratorScopes,
  });
  const history = createAgentHistoryService({ cache: harness.agentHistoryCache });
  const context = new AgentContextService({
    history,
    stores: { agentContextSnapshots: harness.agentContextSnapshots, agents: harness.agents },
  });
  const server = new ObservabilityRpcServer({
    context,
    history,
    orchestrator,
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
  return { harness, orchestrator, server, socketPath };
}

function seedAgents(harness: ReturnType<typeof openObservabilityDbHarness>) {
  harness.herdrSessions.upsertRunning({
    name: "default",
    sessionDir: "/tmp/herdr",
    socketPath: "/tmp/herdr/herdr.sock",
  });
  return replaceAgents(harness, [
    snapshot("term_a", "wA:p-a", "wA"),
    snapshot("term_peer", "wA:p-peer", "wA"),
    snapshot("term_b", "wB:p-b", "wB"),
  ]);
}

function replaceAgents(
  harness: ReturnType<typeof openObservabilityDbHarness>,
  agents: Record<string, unknown>[],
) {
  return harness.agents.replaceForSession({ agents, herdrSessionName: "default" });
}

function snapshot(terminalId: string, paneId: string, workspaceId: string) {
  return {
    agent: "pi",
    agent_status: "working",
    pane_id: paneId,
    terminal_id: terminalId,
    workspace_id: workspaceId,
  };
}

function otherSessionAgent(
  terminalId: string,
  paneId: string,
  workspaceId: string,
): AgentIndexRecord {
  return {
    agent: "pi",
    agentSession: null,
    agentStatus: "working",
    cwd: null,
    firstSeenAt: new Date(),
    focused: false,
    foregroundCwd: null,
    herdrSessionName: "other",
    id: "ag_other",
    lastSeenAt: new Date(),
    paneId,
    paneRevision: null,
    tabId: null,
    terminalId,
    workspaceId,
  };
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

function appendEvent(
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

async function socketTick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}
