import { describe, expect, test } from "vitest";
import { HerdrSessionWatchManager } from "@/daemon/herdr-session-watch-manager.js";
import type { AgentIndexRecord } from "@/observability/contracts.js";
import { openObservabilityDbHarness } from "../integration/observability-db-harness.js";

describe("HerdrSessionWatchManager", () => {
  test("reconnects when Herdr event stream closes without a restart event", async () => {
    const harness = openObservabilityDbHarness();
    const received: unknown[] = [];
    let subscribeCalls = 0;
    let handled = 0;

    const manager = new HerdrSessionWatchManager({
      agents: harness.agents,
      clientFactory: () => ({
        close() {},
        async *subscribeEvents() {
          subscribeCalls += 1;
          if (subscribeCalls === 1) return;
          yield { agent_status: "idle", pane_id: "wB:p2", type: "pane.agent_status_changed" };
          await new Promise((resolve) => setTimeout(resolve, 20));
        },
      }),
      herdrSessions: harness.herdrSessions,
      index: {
        async handleHerdrEvent() {
          handled += 1;
          return {
            agentId: null,
            compactHistory: null,
            createdAt: new Date(),
            herdrSessionName: "default",
            id: 1,
            paneId: "wB:p2",
            payload: {},
            terminalId: null,
            type: "agent.idle",
            workspaceId: "wB",
          };
        },
        async refreshHerdrSession() {
          return [];
        },
      } as unknown as ConstructorParameters<typeof HerdrSessionWatchManager>[0]["index"],
      intervalMs: 60_000,
      onAgentEvent: (event) => received.push(event),
      reconnectDelayMs: 0,
      sessionList: async () => [
        {
          name: "default",
          running: true,
          sessionDir: "/tmp/herdr",
          socketPath: "/tmp/herdr.sock",
        },
      ],
    });

    await manager.start();
    await waitFor(() => handled > 0);
    await manager.stop();
    harness.sqlite.close();

    expect(subscribeCalls).toBeGreaterThanOrEqual(2);
    expect(received).toContainEqual(expect.objectContaining({ type: "agent.idle" }));
  });

  test("reconnects when the Herdr event stream fails", async () => {
    const harness = openObservabilityDbHarness();
    let subscribeCalls = 0;
    let handled = 0;
    const manager = new HerdrSessionWatchManager({
      agents: harness.agents,
      clientFactory: () => ({
        close() {},
        async *subscribeEvents() {
          subscribeCalls += 1;
          if (subscribeCalls === 1) throw new Error("stream failed");
          yield { agent_status: "idle", pane_id: "wB:p2", type: "pane.agent_status_changed" };
          await new Promise((resolve) => setTimeout(resolve, 20));
        },
      }),
      herdrSessions: harness.herdrSessions,
      index: {
        async handleHerdrEvent() {
          handled += 1;
          return undefined;
        },
        async refreshHerdrSession() {
          return [];
        },
      } as unknown as ConstructorParameters<typeof HerdrSessionWatchManager>[0]["index"],
      intervalMs: 60_000,
      onAgentEvent() {},
      reconnectDelayMs: 0,
      sessionList: async () => [
        {
          name: "default",
          running: true,
          sessionDir: "/tmp/herdr",
          socketPath: "/tmp/herdr.sock",
        },
      ],
    });

    await manager.start();
    await waitFor(() => handled > 0);
    await manager.stop();
    harness.sqlite.close();

    expect(subscribeCalls).toBeGreaterThanOrEqual(2);
  });

  test("refreshes an active session during rescan when a lifecycle event was missed", async () => {
    const harness = openObservabilityDbHarness();
    const refreshedPaneIds: string[] = [];
    let currentPaneId = "wB:p2";
    const manager = new HerdrSessionWatchManager({
      agents: harness.agents,
      clientFactory: () => ({
        close() {},
        async *subscribeEvents(_params, options) {
          await new Promise<void>((resolve) => {
            options?.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
        },
      }),
      herdrSessions: harness.herdrSessions,
      index: {
        async handleHerdrEvent() {
          return undefined;
        },
        async refreshHerdrSession() {
          return [agentRecord(currentPaneId, currentPaneId.split(":")[0] ?? "unknown")];
        },
      } as unknown as ConstructorParameters<typeof HerdrSessionWatchManager>[0]["index"],
      intervalMs: 60_000,
      onAgentEvent() {},
      onAgentIndexRefreshed: ({ agents }) => {
        const paneId = agents[0]?.paneId;
        if (paneId) refreshedPaneIds.push(paneId);
      },
      sessionList: async () => [
        {
          name: "default",
          running: true,
          sessionDir: "/tmp/herdr",
          socketPath: "/tmp/herdr.sock",
        },
      ],
    });

    await manager.start();
    await waitFor(() => refreshedPaneIds.length === 1);
    currentPaneId = "wJ:p2";
    await manager.rescanNow();
    await waitFor(() => refreshedPaneIds.includes("wJ:p2"));
    await manager.stop();
    harness.sqlite.close();

    expect(refreshedPaneIds).toEqual(["wB:p2", "wJ:p2"]);
  });

  test("reconciles each refreshed snapshot before subscribing again after a pane move", async () => {
    const harness = openObservabilityDbHarness();
    const operations: string[] = [];
    let refreshCalls = 0;
    let subscribeCalls = 0;
    const manager = new HerdrSessionWatchManager({
      agents: harness.agents,
      clientFactory: () => ({
        close() {},
        async *subscribeEvents(_params, options) {
          subscribeCalls += 1;
          operations.push(`subscribe:${subscribeCalls}`);
          if (subscribeCalls === 1) {
            yield { type: "pane.moved" };
            return;
          }
          await new Promise<void>((resolve) => {
            options?.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
        },
      }),
      herdrSessions: harness.herdrSessions,
      index: {
        async handleHerdrEvent() {
          return undefined;
        },
        async refreshHerdrSession() {
          refreshCalls += 1;
          operations.push(`refresh:${refreshCalls}`);
          return [
            agentRecord(refreshCalls === 1 ? "wA:p1" : "wB:p3", refreshCalls === 1 ? "wA" : "wB"),
          ];
        },
      } as unknown as ConstructorParameters<typeof HerdrSessionWatchManager>[0]["index"],
      intervalMs: 60_000,
      onAgentEvent() {},
      onAgentIndexRefreshed: ({ agents, herdrSessionName }) => {
        operations.push(`reconcile:${herdrSessionName}:${agents[0]?.paneId}`);
      },
      reconnectDelayMs: 0,
      sessionList: async () => [
        {
          name: "default",
          running: true,
          sessionDir: "/tmp/herdr",
          socketPath: "/tmp/herdr.sock",
        },
      ],
    });

    await manager.start();
    await waitFor(() => subscribeCalls === 2);
    await manager.stop();
    harness.sqlite.close();

    expect(operations).toEqual([
      "refresh:1",
      "reconcile:default:wA:p1",
      "subscribe:1",
      "refresh:2",
      "reconcile:default:wB:p3",
      "subscribe:2",
    ]);
  });
});

function agentRecord(paneId: string, workspaceId: string): AgentIndexRecord {
  return {
    agent: "pi",
    agentSession: null,
    agentStatus: "working",
    cwd: null,
    firstSeenAt: new Date(0),
    focused: false,
    foregroundCwd: null,
    herdrSessionName: "default",
    id: "ag_1",
    lastSeenAt: new Date(0),
    paneId,
    tabId: null,
    terminalId: "term_1",
    workspaceId,
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition was not met");
}
