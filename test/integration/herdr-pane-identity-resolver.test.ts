import { afterEach, describe, expect, test, vi } from "vitest";
import { resolveHerdrPaneIdentity } from "@/herdr/pane-identity-resolver.js";
import { cleanupTempDirs, openObservabilityDbHarness } from "./observability-db-harness.js";

afterEach(cleanupTempDirs);

describe("Herdr pane identity", () => {
  test("finds only running sessions by exact socket path", () => {
    const harness = openObservabilityDbHarness();
    harness.herdrSessions.upsertRunning({
      name: "default",
      sessionDir: "/tmp/herdr",
      socketPath: "/tmp/herdr.sock",
    });
    harness.herdrSessions.upsertRunning({
      name: "stopped",
      sessionDir: "/tmp/stopped",
      socketPath: "/tmp/stopped.sock",
    });
    harness.herdrSessions.markStoppedMissingFrom(["default"]);

    expect(harness.herdrSessions.findRunningBySocketPath("/tmp/herdr.sock")?.name).toBe("default");
    expect(harness.herdrSessions.findRunningBySocketPath("/tmp/stopped.sock")).toBeUndefined();
    expect(harness.herdrSessions.findRunningBySocketPath("/tmp/herdr.sock.other")).toBeUndefined();
  });

  test.each([
    {
      pane_id: "wB:p2",
      terminal_id: "term_2",
      workspace_id: "wB",
    },
    {
      pane: {
        paneId: "wB:p2",
        terminalId: "term_2",
        workspaceId: "wB",
      },
    },
  ])("normalizes direct and wrapped pane results", async (result) => {
    const close = vi.fn();
    const getPane = vi.fn().mockResolvedValue(result);

    await expect(
      resolveHerdrPaneIdentity({
        clientFactory: () => ({ close, getPane }),
        paneId: "wA:p1",
        socketPath: "/tmp/herdr.sock",
      }),
    ).resolves.toEqual({ paneId: "wB:p2", terminalId: "term_2", workspaceId: "wB" });
    expect(getPane).toHaveBeenCalledWith({ pane_id: "wA:p1" });
    expect(close).toHaveBeenCalledOnce();
  });

  test("rejects incomplete identity and always closes the client", async () => {
    const close = vi.fn();
    await expect(
      resolveHerdrPaneIdentity({
        clientFactory: () => ({ close, getPane: vi.fn().mockResolvedValue({ pane_id: "wB:p2" }) }),
        paneId: "wB:p2",
        socketPath: "/tmp/herdr.sock",
      }),
    ).rejects.toThrow("Herdr pane response has no terminal identity");
    expect(close).toHaveBeenCalledOnce();
  });
});
