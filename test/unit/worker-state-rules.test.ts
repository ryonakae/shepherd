import { describe, expect, test } from "vitest";
import type { WorkerSnapshot } from "@/observability/contracts.js";
import { evaluateWorkerState } from "@/observability/rules.js";

const worker = { agentName: "pi", id: "wk_1", observedWorkspaceId: "ow_1", sessionRef: null };

describe("worker state rules", () => {
  test("emits blocked from Herdr status with high confidence", () => {
    const result = evaluateWorkerState({
      agentInfo: { agent_status: "blocked", custom_status: "waiting" },
      worker,
    });
    expect(result.snapshot).toMatchObject({
      blockedReason: "waiting",
      confidence: "high",
      status: "blocked",
    });
    expect(result.events).toContainEqual(expect.objectContaining({ type: "worker.blocked" }));
  });

  test("emits blocked from Pi final text with medium confidence", () => {
    const result = evaluateWorkerState({
      telemetry: {
        evidenceRefs: [],
        occurredAt: "2026-07-02T00:00:00.000Z",
        redactionApplied: false,
        runtime: "pi",
        sessionRef: null,
        stopReason: "stop",
        textExcerpt: "Blocked: need input",
        turnId: "turn-1",
        type: "worker.message.final",
        workerKey: null,
      },
      worker,
    });
    expect(result.snapshot).toMatchObject({ confidence: "medium", status: "blocked" });
    expect(result.events).toContainEqual(expect.objectContaining({ type: "worker.blocked" }));
  });

  test("emits tool failed", () => {
    const result = evaluateWorkerState({
      telemetry: {
        artifactRefs: [],
        errorExcerpt: "x".repeat(5000),
        isError: true,
        occurredAt: "2026-07-02T00:00:00.000Z",
        redactionApplied: false,
        runtime: "pi",
        sessionRef: null,
        toolCallId: "tool-1",
        toolName: "bash",
        turnId: "turn-1",
        type: "worker.tool.completed",
        workerKey: null,
      },
      worker,
    });
    expect(result.events).toContainEqual(expect.objectContaining({ type: "worker.tool.failed" }));
    expect(result.snapshot.evidence[0]?.excerpt).toHaveLength(4096);
  });

  test("emits completed and needs input from final text", () => {
    const completed = evaluateWorkerState({
      agentInfo: { agent_status: "idle" },
      telemetry: {
        completionHint: "completed",
        evidenceRefs: [],
        occurredAt: "2026-07-02T00:00:00.000Z",
        redactionApplied: false,
        runtime: "pi",
        sessionRef: null,
        stopReason: "stop",
        textExcerpt: "completed",
        turnId: "turn-1",
        type: "worker.message.final",
        workerKey: null,
      },
      worker,
    });
    expect(completed.events).toContainEqual(expect.objectContaining({ type: "worker.completed" }));

    const needsInput = evaluateWorkerState({
      telemetry: {
        evidenceRefs: [],
        needsInputHint: "please confirm",
        occurredAt: "2026-07-02T00:00:00.000Z",
        redactionApplied: false,
        runtime: "pi",
        sessionRef: null,
        stopReason: "stop",
        textExcerpt: "please confirm",
        turnId: "turn-2",
        type: "worker.message.final",
        workerKey: null,
      },
      worker,
    });
    expect(needsInput.events).toContainEqual(
      expect.objectContaining({ type: "worker.needs_input" }),
    );
  });

  test("status changed only when status differs", () => {
    const previousSnapshot = { id: "wk_1", status: "idle" } as WorkerSnapshot;
    expect(
      evaluateWorkerState({ agentInfo: { agent_status: "working" }, previousSnapshot, worker })
        .events,
    ).toContainEqual(expect.objectContaining({ type: "worker.status.changed" }));
    expect(
      evaluateWorkerState({ agentInfo: { agent_status: "idle" }, previousSnapshot, worker }).events,
    ).not.toContainEqual(expect.objectContaining({ type: "worker.status.changed" }));
  });
});
