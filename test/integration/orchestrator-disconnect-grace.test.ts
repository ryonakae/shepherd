import { existsSync, mkdtempSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createAgentHistoryService } from "@/agent-history/service.js";
import { ObservabilityRpcServer } from "@/daemon/observability-server.js";
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

const scope = { herdrSessionName: "default", workspaceId: "wB" };

describe("orchestrator connection grace", () => {
  test("expires an absent owner and broadcasts after the disconnect grace", async () => {
    const scheduler = new ManualScheduler();
    const { harness, orchestrator, socketPath } = await openServer(scheduler);
    const owner = await RpcTestClient.connect(socketPath);
    const observer = await RpcTestClient.connect(socketPath);
    await Promise.all([register(owner, "owner"), register(observer, "observer")]);
    await owner.request("agent.orchestrator.set", { enabled: true });
    await Promise.all([
      owner.waitForNotification("agent.orchestrator.changed"),
      observer.waitForNotification("agent.orchestrator.changed"),
    ]);

    owner.close();
    await socketTick();
    scheduler.advance(49);
    expect(orchestrator.status(scope)?.owner?.terminalId).toBe("term_owner");
    scheduler.advance(1);
    expect(orchestrator.status(scope)?.owner).toBeNull();
    await expect(observer.waitForNotification("agent.orchestrator.changed")).resolves.toMatchObject(
      {
        params: { change: { reason: "disconnected", current: { owner: null } } },
      },
    );

    observer.close();
    harness.sqlite.close();
  });

  test("same-terminal reconnect and overlapping sockets preserve ownership", async () => {
    const scheduler = new ManualScheduler();
    const { harness, orchestrator, socketPath } = await openServer(scheduler);
    const first = await RpcTestClient.connect(socketPath);
    await register(first, "owner");
    await first.request("agent.orchestrator.set", { enabled: true });

    const overlap = await RpcTestClient.connect(socketPath);
    await register(overlap, "owner-replacement");
    first.close();
    await socketTick();
    scheduler.advance(100);
    expect(orchestrator.status(scope)?.owner?.terminalId).toBe("term_owner");

    overlap.close();
    await socketTick();
    scheduler.advance(25);
    const replacement = await RpcTestClient.connect(socketPath);
    await register(replacement, "owner-after-gap");
    scheduler.advance(100);
    expect(orchestrator.status(scope)?.owner?.terminalId).toBe("term_owner");

    replacement.close();
    harness.sqlite.close();
  });

  test("startup grace preserves a matching reconnect and expires an absent owner", async () => {
    const scheduler = new ManualScheduler();
    const setup = createHarness();
    const orchestrator = createOrchestrator(setup.harness);
    orchestrator.claim({ ...scope, paneId: "wB:p-owner", terminalId: "term_owner" });
    const first = await startServer(setup, orchestrator, scheduler);

    scheduler.advance(99);
    expect(orchestrator.status(scope)?.owner).not.toBeNull();
    const returning = await RpcTestClient.connect(first.socketPath);
    await register(returning, "returning");
    scheduler.advance(1);
    expect(orchestrator.status(scope)?.owner?.terminalId).toBe("term_owner");
    returning.close();
    await first.server.stop();
    servers.splice(servers.indexOf(first.server), 1);
    setup.harness.sqlite.close();

    const absentSetup = createHarness();
    const absentOrchestrator = createOrchestrator(absentSetup.harness);
    absentOrchestrator.claim({ ...scope, paneId: "wB:p-owner", terminalId: "term_owner" });
    const absent = await startServer(absentSetup, absentOrchestrator, scheduler);
    scheduler.advance(100);
    expect(absentOrchestrator.status(scope)?.owner).toBeNull();
    absentSetup.harness.sqlite.close();
    await absent.server.stop();
    servers.splice(servers.indexOf(absent.server), 1);
  });

  test("intentional stop cancels startup timers without clearing persisted owner", async () => {
    const scheduler = new ManualScheduler();
    const setup = createHarness();
    const orchestrator = createOrchestrator(setup.harness);
    orchestrator.claim({ ...scope, paneId: "wB:p-owner", terminalId: "term_owner" });
    const { server } = await startServer(setup, orchestrator, scheduler);

    await server.stop();
    servers.splice(servers.indexOf(server), 1);
    scheduler.advance(1_000);
    expect(orchestrator.status(scope)?.owner?.terminalId).toBe("term_owner");
    setup.harness.sqlite.close();
  });
});

async function openServer(scheduler: ManualScheduler) {
  const setup = createHarness();
  const orchestrator = createOrchestrator(setup.harness);
  const started = await startServer(setup, orchestrator, scheduler);
  return { ...setup, ...started, orchestrator };
}

function createHarness() {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-grace-"));
  tempDirs.push(dir);
  const socketPath = join(dir, "rpc.sock");
  if (existsSync(socketPath)) unlinkSync(socketPath);
  const harness = openObservabilityDbHarness();
  harness.herdrSessions.upsertRunning({
    name: "default",
    sessionDir: "/tmp/herdr",
    socketPath: "/tmp/herdr/herdr.sock",
  });
  harness.agents.replaceForSession({
    agents: [
      {
        agent: "pi",
        pane_id: "wB:p-owner",
        terminal_id: "term_owner",
        workspace_id: "wB",
      },
      {
        agent: "pi",
        pane_id: "wB:p-observer",
        terminal_id: "term_observer",
        workspace_id: "wB",
      },
    ],
    herdrSessionName: "default",
  });
  return { dir, harness, socketPath };
}

function createOrchestrator(harness: ReturnType<typeof openObservabilityDbHarness>) {
  return new AgentOrchestratorService({
    agentEvents: harness.agentEvents,
    agents: harness.agents,
    scopes: harness.agentOrchestratorScopes,
  });
}

async function startServer(
  setup: ReturnType<typeof createHarness>,
  orchestrator: AgentOrchestratorService,
  scheduler: ManualScheduler,
) {
  const server = new ObservabilityRpcServer({
    clearTimeout: (handle) => scheduler.clear(handle),
    disconnectGraceMs: 50,
    history: createAgentHistoryService({ cache: setup.harness.agentHistoryCache }),
    orchestrator,
    setTimeout: (callback, delay) => scheduler.set(callback, delay),
    socketPath: setup.socketPath,
    startupReconnectGraceMs: 100,
    stores: {
      agentEvents: setup.harness.agentEvents,
      agents: setup.harness.agents,
      herdrSessions: setup.harness.herdrSessions,
      herdrWorkspaces: setup.harness.herdrWorkspaces,
    },
  });
  servers.push(server);
  await server.start();
  return { server, socketPath: setup.socketPath };
}

function register(client: RpcTestClient, subscriberId: string): Promise<unknown> {
  return client.request("agent.orchestrator.register", {
    herdrSocketPath: "/tmp/herdr/herdr.sock",
    paneId: subscriberId === "observer" ? "wB:p-observer" : "wB:p-owner",
    subscriberId,
    subscriberKind: "pi",
    workspaceId: "wB",
  });
}

async function socketTick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

class ManualScheduler {
  #nextId = 1;
  #now = 0;
  readonly #timers = new Map<number, { callback: () => void; due: number }>();

  set(callback: () => void, delay: number): ReturnType<typeof setTimeout> {
    const id = this.#nextId;
    this.#nextId += 1;
    this.#timers.set(id, { callback, due: this.#now + delay });
    return id as unknown as ReturnType<typeof setTimeout>;
  }

  clear(handle: ReturnType<typeof setTimeout>): void {
    this.#timers.delete(handle as unknown as number);
  }

  advance(milliseconds: number): void {
    this.#now += milliseconds;
    while (true) {
      const ready = [...this.#timers.entries()]
        .filter(([, timer]) => timer.due <= this.#now)
        .sort((left, right) => left[1].due - right[1].due);
      if (ready.length === 0) return;
      for (const [id, timer] of ready) {
        this.#timers.delete(id);
        timer.callback();
      }
    }
  }
}
