import { describe, expect, test } from "vitest";
import { HerdrSessionWatchManager } from "@/daemon/herdr-session-watch-manager.js";
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
            type: "agent.idle",
            workspaceId: "wB",
          };
        },
        async refreshHerdrSession() {},
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
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition was not met");
}
