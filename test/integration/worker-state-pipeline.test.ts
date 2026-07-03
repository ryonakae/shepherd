import { afterEach, describe, expect, test } from "vitest";
import { WorkerStatePipeline } from "@/observability/worker-state-pipeline.js";
import { cleanupTempDirs, openObservabilityDbHarness } from "./observability-db-harness.js";

afterEach(cleanupTempDirs);

describe("WorkerStatePipeline", () => {
  test("refreshes workspace agents into worker snapshots", async () => {
    const harness = openObservabilityDbHarness();
    const workspace = harness.workspaces.observe({ herdrSessionName: "main", workspaceId: "w1" });
    const pipeline = new WorkerStatePipeline({
      ...harness,
      herdrClientForWorkspace: () =>
        fakeHerdrClient({
          agents: [
            {
              agent: "pi",
              agent_status: "working",
              pane_id: "p1",
              workspace_id: "w1",
              agent_session: {
                source: "herdr:pi",
                agent: "pi",
                kind: "path",
                value: "/tmp/a.jsonl",
              },
            },
            { agent: "codex", agent_status: "idle", pane_id: "p2", workspace_id: "w1" },
          ],
          workspaces: [{ id: "w1", label: "Repo" }],
        }),
      transcriptAdapters: [],
    });

    await expect(pipeline.refreshWorkspace(workspace.id)).resolves.toHaveLength(2);
    expect(harness.workers.listForWorkspace(workspace.id)).toHaveLength(2);
    expect(harness.snapshots.listCurrent(workspace.id)).toHaveLength(2);
    harness.sqlite.close();
  });

  test("handles Herdr status events and failed telemetry", async () => {
    const harness = openObservabilityDbHarness();
    const workspace = harness.workspaces.observe({ herdrSessionName: "main", workspaceId: "w1" });
    const worker = harness.workers.upsertFromHerdrAgent({
      agent: {
        agent: "pi",
        agent_status: "idle",
        pane_id: "p1",
        workspace_id: "w1",
        agent_session: { source: "herdr:pi", agent: "pi", kind: "path", value: "/tmp/a.jsonl" },
      },
      observedWorkspace: workspace,
    });
    const pipeline = new WorkerStatePipeline({
      ...harness,
      herdrClientForWorkspace: () => fakeHerdrClient({ agents: [], workspaces: [{ id: "w1" }] }),
      transcriptAdapters: [],
    });

    await pipeline.handleHerdrEvent({
      event: {
        type: "pane.agent_status_changed",
        agent: "pi",
        agent_status: "working",
        pane_id: "p1",
        workspace_id: "w1",
      },
      observedWorkspaceId: workspace.id,
    });
    expect(harness.workerEvents.listAfter({ observedWorkspaceId: workspace.id })).toContainEqual(
      expect.objectContaining({ type: "worker.status.changed", workerId: worker.id }),
    );

    await pipeline.handleTelemetry({
      event: {
        artifactRefs: [],
        errorExcerpt: "failed",
        isError: true,
        occurredAt: "2026-07-02T00:00:00.000Z",
        redactionApplied: false,
        runtime: "pi",
        sessionRef: { source: "herdr:pi", agent: "pi", kind: "path", value: "/tmp/a.jsonl" },
        toolCallId: "tool-1",
        toolName: "bash",
        turnId: "turn-1",
        type: "worker.tool.completed",
        workerKey: null,
      },
      observedWorkspaceId: workspace.id,
    });
    await pipeline.handleTelemetry({
      event: {
        evidenceRefs: [],
        completionHint: "completed",
        occurredAt: "2026-07-02T00:00:01.000Z",
        redactionApplied: false,
        runtime: "pi",
        sessionRef: { source: "herdr:pi", agent: "pi", kind: "path", value: "/tmp/a.jsonl" },
        stopReason: "stop",
        textExcerpt: "completed",
        turnId: "turn-2",
        type: "worker.message.final",
        workerKey: null,
      },
      observedWorkspaceId: workspace.id,
    });

    const events = harness.workerEvents.listAfter({ observedWorkspaceId: workspace.id });
    expect(events).toContainEqual(
      expect.objectContaining({ type: "worker.tool.failed", workerId: worker.id }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: "worker.completed", workerId: worker.id }),
    );
    expect(harness.snapshots.listCurrent(workspace.id)[0]).toMatchObject({
      completion: "completed",
    });
    harness.sqlite.close();
  });

  test("dedupes repeated telemetry and marks missing workspace", async () => {
    const harness = openObservabilityDbHarness();
    const workspace = harness.workspaces.observe({ herdrSessionName: "main", workspaceId: "w1" });
    harness.workers.upsertFromHerdrAgent({
      agent: { agent: "pi", agent_status: "idle", pane_id: "p1", workspace_id: "w1" },
      observedWorkspace: workspace,
    });
    const pipeline = new WorkerStatePipeline({
      ...harness,
      herdrClientForWorkspace: () => fakeHerdrClient({ agents: [], workspaces: [] }),
      transcriptAdapters: [],
    });

    await pipeline.handleTelemetry({
      event: {
        artifactRefs: [],
        errorExcerpt: "failed",
        isError: true,
        occurredAt: "2026-07-02T00:00:00.000Z",
        redactionApplied: false,
        runtime: "pi",
        sessionRef: null,
        toolCallId: "tool-1",
        toolName: "bash",
        turnId: "turn-1",
        type: "worker.tool.completed",
        workerKey: "pane:main:w1:p1",
      },
      observedWorkspaceId: workspace.id,
    });
    await pipeline.handleTelemetry({
      event: {
        artifactRefs: [],
        errorExcerpt: "failed",
        isError: true,
        occurredAt: "2026-07-02T00:00:00.000Z",
        redactionApplied: false,
        runtime: "pi",
        sessionRef: null,
        toolCallId: "tool-1",
        toolName: "bash",
        turnId: "turn-1",
        type: "worker.tool.completed",
        workerKey: "pane:main:w1:p1",
      },
      observedWorkspaceId: workspace.id,
    });
    expect(
      harness.workerEvents
        .listAfter({ observedWorkspaceId: workspace.id })
        .filter((e) => e.type === "worker.tool.failed"),
    ).toHaveLength(1);

    await expect(pipeline.refreshWorkspace(workspace.id)).resolves.toEqual([]);
    expect(harness.workspaces.get(workspace.id).status).toBe("missing");
    harness.sqlite.close();
  });
});

function fakeHerdrClient(snapshot: { agents: unknown[]; workspaces: unknown[] }) {
  return {
    agentRead: async () => ({}),
    agentSend: async () => ({}),
    agentStart: async () => ({}),
    close: () => undefined,
    listAgents: async () => snapshot.agents,
    sessionSnapshot: async () => ({ snapshot: { ...snapshot, panes: [], tabs: [] } }),
    subscribeEvents: async function* () {},
  };
}
