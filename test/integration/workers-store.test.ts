import { afterEach, describe, expect, test } from "vitest";
import { cleanupTempDirs, openObservabilityDbHarness } from "./observability-db-harness.js";

afterEach(cleanupTempDirs);

describe("WorkerStore", () => {
  test("uses agent session identity when present", () => {
    const { sqlite, workers, workspaces } = openObservabilityDbHarness();
    const workspace = workspaces.observe({ herdrSessionName: "main", workspaceId: "w1" });

    const worker = workers.upsertFromHerdrAgent({
      agent: {
        agent: "pi",
        agent_session: {
          source: "herdr:pi",
          agent: "pi",
          kind: "path",
          value: "/tmp/session.jsonl",
        },
        agent_status: "working",
        pane_id: "p1",
        tab_id: "t1",
        workspace_id: "w1",
      },
      observedWorkspace: workspace,
    });

    expect(worker).toMatchObject({
      agentName: "pi",
      identityKind: "agent_session",
      observedWorkspaceId: workspace.id,
      runtime: "pi",
      status: "working",
      workerKey: "session:herdr:pi:pi:path:/tmp/session.jsonl",
    });
    expect(worker.id).toMatch(/^wk_/);
    expect(
      workers.findByWorkerKey({ observedWorkspaceId: workspace.id, workerKey: worker.workerKey })
        ?.id,
    ).toBe(worker.id);

    sqlite.close();
  });

  test("falls back to live pane identity when agent session is missing", () => {
    const { sqlite, workers, workspaces } = openObservabilityDbHarness();
    const workspace = workspaces.observe({ herdrSessionName: "main", workspaceId: "w1" });

    const first = workers.upsertFromHerdrAgent({
      agent: {
        agent: "codex",
        agent_status: "idle",
        pane_id: "p1",
        tab_id: "t1",
        workspace_id: "w1",
      },
      observedWorkspace: workspace,
    });
    const second = workers.upsertFromHerdrAgent({
      agent: {
        agent: "codex",
        agent_status: "working",
        pane_id: "p1",
        tab_id: "t2",
        workspace_id: "w1",
      },
      observedWorkspace: workspace,
    });

    expect(first).toMatchObject({
      identityKind: "live_pane",
      workerKey: "pane:main:w1:p1",
    });
    expect(second.id).toBe(first.id);
    expect(second).toMatchObject({ currentTabId: "t2", status: "working" });
    expect(workers.listForWorkspace(workspace.id)).toHaveLength(1);

    sqlite.close();
  });
});
