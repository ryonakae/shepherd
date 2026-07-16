import { afterEach, describe, expect, test, vi } from "vitest";
import {
  ACTIVE_REVISION_POLL_MS,
  FULL_RESCAN_MS,
  HerdrSessionWatchManager,
} from "@/daemon/herdr-session-watch-manager.js";
import type { AgentIndexRefreshResult } from "@/observability/agent-index-service.js";
import type { AgentIndexRecord } from "@/observability/contracts.js";
import {
  cleanupTempDirs,
  openObservabilityDbHarness,
} from "../integration/observability-db-harness.js";

afterEach(() => {
  vi.useRealTimers();
  cleanupTempDirs();
});

describe("HerdrSessionWatchManager", () => {
  test("uses exact exported scheduler constants", () => {
    expect(ACTIVE_REVISION_POLL_MS).toBe(10_000);
    expect(FULL_RESCAN_MS).toBe(60_000);
  });

  test("polls working sessions at the active cadence and performs one full rescan at the boundary", async () => {
    vi.useFakeTimers();
    const harness = openObservabilityDbHarness();
    seedAgent(harness, "working");
    let refreshes = 0;
    let sessions = 0;
    const manager = managerFor(harness, {
      activeRevisionPollMs: 10,
      fullRescanMs: 60,
      index: {
        async handleHerdrEvent() {
          return { contextChangedScopes: [], events: [] };
        },
        async refreshHerdrSession() {
          refreshes += 1;
          return result([agentRecord("wB:p2", "wB", "working")]);
        },
      },
      sessionList: async () => {
        sessions += 1;
        return [entry()];
      },
    });
    await manager.start();
    await vi.advanceTimersByTimeAsync(50);
    expect(refreshes).toBe(6);
    expect(sessions).toBe(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(refreshes).toBe(7);
    expect(sessions).toBe(2);
    await manager.stop();
    harness.sqlite.close();
  });

  test("does not poll all-idle sessions before the full rescan", async () => {
    vi.useFakeTimers();
    const harness = openObservabilityDbHarness();
    seedAgent(harness, "idle");
    let refreshes = 0;
    const manager = managerFor(harness, {
      activeRevisionPollMs: 10,
      fullRescanMs: 60,
      index: {
        async handleHerdrEvent() {
          return { contextChangedScopes: [], events: [] };
        },
        async refreshHerdrSession() {
          refreshes += 1;
          return result([agentRecord("wB:p2", "wB", "idle")]);
        },
      },
    });
    await manager.start();
    await vi.advanceTimersByTimeAsync(50);
    expect(refreshes).toBe(1);
    await manager.stop();
    harness.sqlite.close();
  });

  test("awaits a removed watcher before finalizing the stopped session", async () => {
    const harness = openObservabilityDbHarness();
    let sessions = [entry()];
    let subscriptions = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manager = managerFor(harness, {
      clientFactory: () => ({
        close() {},
        async *subscribeEvents() {
          subscriptions += 1;
          yield* [];
        },
      }),
      index: {
        async handleHerdrEvent() {
          return { contextChangedScopes: [], events: [] };
        },
        async refreshHerdrSession() {
          await gate;
          harness.herdrSessions.upsertRunning(entry());
          return result([]);
        },
      },
      sessionList: async () => sessions,
    });
    await manager.start();
    sessions = [];
    let settled = false;
    const rescanning = manager.rescanNow().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    release();
    await rescanning;

    expect(harness.herdrSessions.get("default").running).toBe(false);
    expect(subscriptions).toBe(0);
    await manager.stop();
    harness.sqlite.close();
  });

  test("does not start a watcher after stop wins a full-rescan race", async () => {
    vi.useFakeTimers();
    const harness = openObservabilityDbHarness();
    let listCalls = 0;
    let resolveRescan!: (entries: ReturnType<typeof entry>[]) => void;
    const rescan = new Promise<ReturnType<typeof entry>[]>((resolve) => {
      resolveRescan = resolve;
    });
    let clients = 0;
    const manager = managerFor(harness, {
      activeRevisionPollMs: 10,
      clientFactory: () => {
        clients += 1;
        return {
          close() {},
          async *subscribeEvents(_params, options) {
            await new Promise<void>((resolve) =>
              options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
            );
          },
        };
      },
      fullRescanMs: 60,
      index: {
        async handleHerdrEvent() {
          return { contextChangedScopes: [], events: [] };
        },
        async refreshHerdrSession() {
          return result([]);
        },
      },
      sessionList: async () => {
        listCalls += 1;
        return listCalls === 1 ? [entry()] : rescan;
      },
    });
    await manager.start();
    const ticking = vi.advanceTimersByTimeAsync(60);
    await vi.waitFor(() => expect(listCalls).toBe(2));

    const stopping = manager.stop();
    resolveRescan([entry()]);
    await Promise.all([ticking, stopping]);

    expect(clients).toBe(1);
    harness.sqlite.close();
  });

  test("publishes one shared refresh result once", async () => {
    vi.useFakeTimers();
    const harness = openObservabilityDbHarness();
    seedAgent(harness, "working");
    let resolveRefresh!: (value: ReturnType<typeof result>) => void;
    const shared = new Promise<AgentIndexRefreshResult>((resolve) => {
      resolveRefresh = resolve;
    });
    let refreshCalls = 0;
    const published = { context: 0, events: 0, reconcile: 0 };
    const manager = managerFor(harness, {
      activeRevisionPollMs: 10,
      fullRescanMs: 60,
      index: {
        async handleHerdrEvent() {
          return { contextChangedScopes: [], events: [] };
        },
        refreshHerdrSession() {
          refreshCalls += 1;
          return shared;
        },
      },
      onAgentContextChanged: () => {
        published.context += 1;
      },
      onAgentEvent: () => {
        published.events += 1;
      },
      onAgentIndexRefreshed: () => {
        published.reconcile += 1;
      },
    });
    await manager.start();
    expect(refreshCalls).toBe(1);
    vi.advanceTimersByTime(10);
    await Promise.resolve();
    expect(refreshCalls).toBe(2);
    resolveRefresh({
      agents: [agentRecord("wB:p2", "wB", "working")],
      contextChangedScopes: [{ herdrSessionName: "default", workspaceId: "wB" }],
      events: [event()],
    });
    await shared;
    for (let index = 0; index < 5; index += 1) await Promise.resolve();

    expect(published).toEqual({ context: 1, events: 1, reconcile: 1 });
    await manager.stop();
    harness.sqlite.close();
  });

  test("reconnects when Herdr event stream closes without a restart event", async () => {
    const harness = openObservabilityDbHarness();
    const received: unknown[] = [];
    let subscribeCalls = 0;
    let handled = 0;
    const manager = managerFor(harness, {
      clientFactory: () => ({
        close() {},
        async *subscribeEvents() {
          subscribeCalls += 1;
          if (subscribeCalls === 1) return;
          yield { agent_status: "idle", pane_id: "wB:p2", type: "pane.agent_status_changed" };
          await new Promise((resolve) => setTimeout(resolve, 20));
        },
      }),
      index: {
        async handleHerdrEvent() {
          handled += 1;
          return { contextChangedScopes: [], events: [event()] };
        },
        async refreshHerdrSession() {
          return result([]);
        },
      },
      onAgentEvent: (item) => received.push(item),
      reconnectDelayMs: 0,
    });
    await manager.start();
    await waitFor(() => handled > 0);
    await manager.stop();
    harness.sqlite.close();
    expect(subscribeCalls).toBeGreaterThanOrEqual(2);
    expect(received).toContainEqual(expect.objectContaining({ type: "agent.idle" }));
  });

  test("reconciles before publishing changed context and events after a pane move", async () => {
    const harness = openObservabilityDbHarness();
    const operations: string[] = [];
    let refreshCalls = 0;
    let subscribeCalls = 0;
    const manager = managerFor(harness, {
      clientFactory: () => ({
        close() {},
        async *subscribeEvents(_params, options) {
          subscribeCalls += 1;
          if (subscribeCalls === 1) {
            yield { type: "pane.moved" };
            return;
          }
          await new Promise<void>((resolve) => {
            options?.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
        },
      }),
      index: {
        async handleHerdrEvent() {
          return { contextChangedScopes: [], events: [] };
        },
        async refreshHerdrSession() {
          refreshCalls += 1;
          const agent = agentRecord(
            refreshCalls === 1 ? "wA:p1" : "wB:p3",
            refreshCalls === 1 ? "wA" : "wB",
            "working",
          );
          return {
            agents: [agent],
            contextChangedScopes: [{ herdrSessionName: "default", workspaceId: agent.workspaceId }],
            events: [event(agent.workspaceId)],
          };
        },
      },
      onAgentContextChanged: (scope) => operations.push(`context:${scope.workspaceId}`),
      onAgentEvent: (item) => operations.push(`event:${item.workspaceId}`),
      onAgentIndexRefreshed: ({ agents }) => operations.push(`reconcile:${agents[0]?.paneId}`),
      reconnectDelayMs: 0,
    });
    await manager.start();
    await waitFor(() => subscribeCalls === 2);
    await manager.stop();
    harness.sqlite.close();
    expect(operations).toEqual([
      "reconcile:wA:p1",
      "context:wA",
      "event:wA",
      "reconcile:wB:p3",
      "context:wB",
      "event:wB",
    ]);
  });
});

function managerFor(
  harness: ReturnType<typeof openObservabilityDbHarness>,
  overrides: Partial<Omit<ConstructorParameters<typeof HerdrSessionWatchManager>[0], "index">> & {
    index: {
      handleHerdrEvent: () => Promise<unknown>;
      refreshHerdrSession: () => Promise<unknown>;
    };
  },
) {
  const { index, ...options } = overrides;
  return new HerdrSessionWatchManager({
    activeRevisionPollMs: 60_000,
    agents: harness.agents,
    clientFactory: () => ({
      close() {},
      async *subscribeEvents(_params, options) {
        if (options?.signal?.aborted) return;
        await new Promise<void>((resolve) =>
          options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
        );
      },
    }),
    fullRescanMs: 60_000,
    herdrSessions: harness.herdrSessions,
    index: index as unknown as ConstructorParameters<typeof HerdrSessionWatchManager>[0]["index"],
    onAgentContextChanged() {},
    onAgentEvent() {},
    onAgentIndexRefreshed() {},
    reconnectDelayMs: 0,
    sessionList: async () => [entry()],
    ...options,
  });
}

function entry() {
  return {
    name: "default",
    running: true,
    sessionDir: "/tmp/herdr",
    socketPath: "/tmp/herdr.sock",
  };
}

function seedAgent(
  harness: ReturnType<typeof openObservabilityDbHarness>,
  status: "idle" | "working",
) {
  harness.herdrSessions.upsertRunning(entry());
  harness.agents.replaceForSession({
    agents: [
      {
        agent: "claude",
        agent_status: status,
        pane_id: "wB:p2",
        terminal_id: "term_1",
        workspace_id: "wB",
      },
    ],
    herdrSessionName: "default",
  });
}

function result(agents: AgentIndexRecord[]): AgentIndexRefreshResult {
  return { agents, contextChangedScopes: [], events: [] };
}

function event(workspaceId = "wB") {
  return {
    agentId: null,
    compactHistory: null,
    createdAt: new Date(),
    herdrSessionName: "default",
    id: 1,
    paneId: "wB:p2",
    payload: {},
    terminalId: null,
    type: "agent.idle" as const,
    workspaceId,
  };
}

function agentRecord(
  paneId: string,
  workspaceId: string,
  agentStatus: "idle" | "working",
): AgentIndexRecord {
  return {
    agent: "pi",
    agentSession: null,
    agentStatus,
    cwd: null,
    firstSeenAt: new Date(0),
    focused: false,
    foregroundCwd: null,
    herdrSessionName: "default",
    id: "ag_1",
    lastSeenAt: new Date(0),
    paneId,
    paneRevision: null,
    tabId: null,
    terminalId: "term_1",
    workspaceId,
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition was not met");
}
