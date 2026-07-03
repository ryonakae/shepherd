import { afterEach, describe, expect, test } from "vitest";
import { cleanupTempDirs, openObservabilityDbHarness } from "./observability-db-harness.js";

afterEach(cleanupTempDirs);

describe("WorkerEventStore", () => {
  test("dedupes idempotency keys per observed workspace and lists after cursor", () => {
    const { events, sqlite, workers, workspaces } = openObservabilityDbHarness();
    const workspace = workspaces.observe({ herdrSessionName: "main", workspaceId: "w1" });
    const otherWorkspace = workspaces.observe({ herdrSessionName: "other", workspaceId: "w1" });
    const worker = workers.upsertFromHerdrAgent({
      agent: { agent: "pi", agent_status: "working", pane_id: "p1", workspace_id: "w1" },
      observedWorkspace: workspace,
    });

    const first = events.append({
      idempotencyKey: "same",
      observedWorkspaceId: workspace.id,
      payload: { summary: "first" },
      type: "worker.summary.updated",
      workerId: worker.id,
    });
    const duplicate = events.append({
      idempotencyKey: "same",
      observedWorkspaceId: workspace.id,
      payload: { summary: "duplicate" },
      type: "worker.summary.updated",
      workerId: worker.id,
    });
    const other = events.append({
      idempotencyKey: "same",
      observedWorkspaceId: otherWorkspace.id,
      payload: { summary: "other" },
      type: "worker.summary.updated",
      workerId: null,
    });
    const second = events.append({
      observedWorkspaceId: workspace.id,
      payload: { status: "done" },
      type: "worker.completed",
      workerId: worker.id,
    });

    expect(duplicate.id).toBe(first.id);
    expect(other.id).not.toBe(first.id);
    expect(events.listAfter({ afterEventId: first.id, observedWorkspaceId: workspace.id })).toEqual(
      [second],
    );
    expect(events.latestEventId(workspace.id)).toBe(second.id);

    sqlite.close();
  });
});
