import { describe, expect, test } from "vitest";
import { HerdrProgressSubscriptionManager } from "@/herdr/progress-subscriptions.js";

describe("HerdrProgressSubscriptionManager", () => {
  test("starts one Herdr event wait loop per binding and forwards progress", async () => {
    const received: unknown[] = [];
    const waitParams: unknown[] = [];
    const manager = new HerdrProgressSubscriptionManager({
      pollTimeoutMs: 1000,
      receiveProgress: async (input) => {
        received.push(input);
      },
      sourceForSession() {
        let emitted = false;
        return {
          async waitForEvent(params) {
            waitParams.push(params);
            if (emitted) {
              return new Promise(() => undefined);
            }
            emitted = true;
            return { id: "evt-1", type: "agent.status" };
          },
        };
      },
    });

    expect(
      manager.subscribe({
        herdrSessionName: "shepherd-api",
        sessionId: "session-1",
        workspaceId: "w1",
      }),
    ).toBe(true);
    expect(
      manager.subscribe({
        herdrSessionName: "shepherd-api",
        sessionId: "session-1",
        workspaceId: "w1",
      }),
    ).toBe(false);

    await waitFor(() => received.length === 1);
    manager.close();

    expect(waitParams[0]).toEqual({ timeout_ms: 1000, workspace_id: "w1" });
    expect(received).toEqual([
      {
        herdrSessionName: "shepherd-api",
        rawEvent: { id: "evt-1", type: "agent.status" },
        sessionId: "session-1",
        workspaceId: "w1",
      },
    ]);
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > 1_000) {
      throw new Error("Timed out while waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
