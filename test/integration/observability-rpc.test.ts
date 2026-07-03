import { existsSync, mkdtempSync, unlinkSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { ObservabilityRpcClient } from "@/daemon/client.js";
import { ObservabilityRpcServer } from "@/daemon/observability-server.js";
import { encodeJsonLine, JsonLineDecoder } from "@/gateway/json-lines.js";
import { NotificationService } from "@/observability/notification-service.js";
import { WorkerStatePipeline } from "@/observability/worker-state-pipeline.js";
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
  test("serves observability methods over JSONL", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shepherd-observability-rpc-"));
    tempDirs.push(dir);
    const socketPath = join(dir, "rpc.sock");
    const harness = openObservabilityDbHarness();
    const pipeline = new WorkerStatePipeline({
      ...harness,
      herdrClientForWorkspace: () => fakeHerdrClient(),
      transcriptAdapters: [],
    });
    const notifications = new NotificationService({
      cursors: harness.cursors,
      workerEvents: harness.workerEvents,
    });
    const server = new ObservabilityRpcServer({
      notifications,
      pipeline,
      socketPath,
      stores: harness,
    });
    servers.push(server);
    await server.start();

    const client = new ObservabilityRpcClient({ socketPath });
    const observed = await client.request("workspace.observe", {
      herdrSessionName: "main",
      workspaceId: "w1",
    });
    expect(observed).toMatchObject({ observedWorkspace: { id: expect.stringMatching(/^ow_/) } });
    const observedWorkspaceId = (observed as { observedWorkspace: { id: string } })
      .observedWorkspace.id;

    const snapshot = await client.request("workspace.snapshot", { observedWorkspaceId });
    expect(snapshot).toMatchObject({ workers: [] });

    harness.workerEvents.append({
      observedWorkspaceId,
      payload: { ok: true },
      type: "worker.summary.updated",
      workerId: null,
    });
    await expect(client.request("worker.events", { observedWorkspaceId })).resolves.toMatchObject({
      events: [expect.objectContaining({ type: "worker.summary.updated" })],
    });

    await expect(
      client.request("runtime.telemetry", { event: lifecycleEvent(), observedWorkspaceId }),
    ).resolves.toEqual({ accepted: true });

    const subscription = await client.request("notification.subscribe", {
      autoResume: true,
      observedWorkspaceId,
      subscriberId: "pi",
      subscriberKind: "pi",
    });
    expect(subscription).toMatchObject({
      events: [expect.any(Object)],
      subscription: { id: expect.stringMatching(/^ns_/) },
    });
    const subscriptionId = (subscription as { subscription: { id: string } }).subscription.id;
    await expect(
      client.request("notification.ack", { eventId: 1, subscriptionId }),
    ).resolves.toEqual({ acknowledged: true });

    await expect(client.request("unknown.method", {})).rejects.toThrow("Unknown method");
    client.close();
    harness.sqlite.close();
  });

  test("streams worker.event notifications", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shepherd-observability-rpc-"));
    tempDirs.push(dir);
    const socketPath = join(dir, "rpc.sock");
    if (existsSync(socketPath)) unlinkSync(socketPath);
    const harness = openObservabilityDbHarness();
    const workspace = harness.workspaces.observe({ herdrSessionName: "main", workspaceId: "w1" });
    const server = new ObservabilityRpcServer({
      notifications: new NotificationService({
        cursors: harness.cursors,
        workerEvents: harness.workerEvents,
      }),
      pipeline: new WorkerStatePipeline({
        ...harness,
        herdrClientForWorkspace: () => fakeHerdrClient(),
        transcriptAdapters: [],
      }),
      socketPath,
      stores: harness,
    });
    servers.push(server);
    await server.start();

    const socket = createConnection(socketPath);
    const decoder = new JsonLineDecoder();
    const messages: unknown[] = [];
    socket.on("data", (chunk) => messages.push(...decoder.push(chunk.toString("utf8"))));
    socket.write(
      encodeJsonLine({
        id: 1,
        method: "worker.events",
        params: { observedWorkspaceId: workspace.id },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    harness.workerEvents.append({
      observedWorkspaceId: workspace.id,
      payload: {},
      type: "worker.blocked",
      workerId: null,
    });
    server.publishWorkerEvent({ observedWorkspaceId: workspace.id });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(messages).toContainEqual(expect.objectContaining({ method: "worker.event" }));
    socket.destroy();
    harness.sqlite.close();
  });
});

function lifecycleEvent() {
  return {
    occurredAt: "2026-07-02T00:00:00.000Z",
    runtime: "pi",
    sessionRef: null,
    status: "working",
    type: "worker.lifecycle",
    workerKey: null,
  };
}

function fakeHerdrClient() {
  return {
    agentRead: async () => ({}),
    agentSend: async () => ({}),
    agentStart: async () => ({}),
    close: () => undefined,
    listAgents: async () => [],
    sessionSnapshot: async () => ({
      snapshot: { agents: [], panes: [], tabs: [], workspaces: [{ id: "w1" }] },
    }),
    subscribeEvents: async function* () {},
  };
}
