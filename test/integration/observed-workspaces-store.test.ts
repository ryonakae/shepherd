import { afterEach, describe, expect, test } from "vitest";
import { cleanupTempDirs, openObservabilityDbHarness } from "./observability-db-harness.js";

afterEach(cleanupTempDirs);

describe("ObservedWorkspaceStore", () => {
  test("observes a Herdr workspace and reuses the same record", () => {
    const { sqlite, workspaces } = openObservabilityDbHarness();

    const first = workspaces.observe({
      herdrSessionName: "main",
      metadata: { label: "Main workspace", workspaceCwd: "/repo" },
      workspaceId: "w1",
    });
    const second = workspaces.observe({ herdrSessionName: "main", workspaceId: "w1" });

    expect(first).toMatchObject({
      herdrSessionName: "main",
      liveWorkspaceId: "w1",
      metadata: { label: "Main workspace", workspaceCwd: "/repo" },
      socketPath: null,
      status: "active",
    });
    expect(first.id).toMatch(/^ow_/);
    expect(second.id).toBe(first.id);
    expect(workspaces.listActive().map((workspace) => workspace.id)).toEqual([first.id]);

    sqlite.close();
  });

  test("updates resolution state", () => {
    const { sqlite, workspaces } = openObservabilityDbHarness();
    const observed = workspaces.observe({ herdrSessionName: "main", workspaceId: "w1" });

    const updated = workspaces.markResolution({
      id: observed.id,
      liveWorkspaceId: "w2",
      metadata: { label: "Moved" },
      status: "ambiguous",
    });

    expect(updated).toMatchObject({
      id: observed.id,
      liveWorkspaceId: "w2",
      metadata: { label: "Moved" },
      status: "ambiguous",
    });
    expect(updated.lastResolvedAt).toBeInstanceOf(Date);

    sqlite.close();
  });
});
