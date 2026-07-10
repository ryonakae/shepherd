import { afterEach, describe, expect, test } from "vitest";
import { AgentOrchestratorService } from "@/observability/agent-orchestrator-service.js";
import { cleanupTempDirs, openObservabilityDbHarness } from "./observability-db-harness.js";

afterEach(cleanupTempDirs);

const scope = { herdrSessionName: "default", workspaceId: "wB" };

function openService() {
  const harness = openObservabilityDbHarness();
  harness.herdrSessions.upsertRunning({
    name: "default",
    sessionDir: "/tmp/herdr",
    socketPath: "/tmp/herdr.sock",
  });
  const service = new AgentOrchestratorService({
    agentEvents: harness.agentEvents,
    agents: harness.agents,
    scopes: harness.agentOrchestratorScopes,
  });
  return { harness, service };
}

function appendEvent(
  harness: ReturnType<typeof openObservabilityDbHarness>,
  input: { terminalId: string; workspaceId?: string },
) {
  return harness.agentEvents.append({
    herdrSessionName: "default",
    paneId: `${input.workspaceId ?? "wB"}:pane`,
    payload: {},
    terminalId: input.terminalId,
    type: "agent.done",
    workspaceId: input.workspaceId ?? "wB",
  });
}

describe("AgentOrchestratorService", () => {
  test("initializes once, replaces owners, and releases only the current owner", () => {
    const { harness, service } = openService();
    const baseline = appendEvent(harness, { terminalId: "term_worker" });

    expect(service.status(scope)).toBeUndefined();
    const first = service.claim({ ...scope, paneId: "wB:p1", terminalId: "term_a" });
    expect(first).toMatchObject({
      current: { ackedEventId: baseline.id, owner: { paneId: "wB:p1", terminalId: "term_a" } },
      previous: { ackedEventId: baseline.id, owner: null },
      reason: "claimed",
    });

    const same = service.claim({ ...scope, paneId: "wB:p1", terminalId: "term_a" });
    expect(same.current).toMatchObject({ ackedEventId: baseline.id, owner: same.previous.owner });
    const replacement = service.claim({ ...scope, paneId: "wB:p2", terminalId: "term_b" });
    expect(replacement).toMatchObject({
      current: { ackedEventId: baseline.id, owner: { terminalId: "term_b" } },
      previous: { owner: { terminalId: "term_a" } },
    });
    expect(service.release({ ...scope, reason: "released", terminalId: "term_a" })).toBeUndefined();
    expect(service.release({ ...scope, reason: "released", terminalId: "term_b" })).toMatchObject({
      current: { owner: null },
      reason: "released",
    });
  });

  test("returns ordered non-self pending events across bounded scan pages", () => {
    const { harness, service } = openService();
    service.claim({ ...scope, paneId: "wB:p1", terminalId: "term_owner" });
    for (let index = 0; index < 105; index += 1) {
      appendEvent(harness, { terminalId: "term_owner" });
    }
    const worker = appendEvent(harness, { terminalId: "term_worker" });
    appendEvent(harness, { terminalId: "term_other", workspaceId: "wC" });

    expect(service.pending({ ...scope, terminalId: "term_owner" })).toEqual([
      expect.objectContaining({ id: worker.id }),
    ]);
    expect(service.pending({ ...scope, terminalId: "term_worker" })).toEqual([]);
  });

  test("keeps ownerless events pending and acknowledges monotonically", () => {
    const { harness, service } = openService();
    service.claim({ ...scope, paneId: "wB:p1", terminalId: "term_a" });
    service.release({ ...scope, reason: "released", terminalId: "term_a" });
    const pending = appendEvent(harness, { terminalId: "term_worker" });
    service.claim({ ...scope, paneId: "wB:p2", terminalId: "term_b" });

    expect(service.pending({ ...scope, terminalId: "term_b" })).toMatchObject([{ id: pending.id }]);
    expect(service.ack({ ...scope, eventId: pending.id, terminalId: "term_b" }).ackedEventId).toBe(
      pending.id,
    );
    expect(
      service.ack({ ...scope, eventId: pending.id - 1, terminalId: "term_b" }).ackedEventId,
    ).toBe(pending.id);
    expect(() => service.ack({ ...scope, eventId: pending.id + 1, terminalId: "term_a" })).toThrow(
      "Only the current orchestrator can acknowledge notifications",
    );
  });

  test("moves ownership while preserving initialized cursors", () => {
    const { harness, service } = openService();
    service.claim({ ...scope, paneId: "wB:p1", terminalId: "term_a" });
    const sourceEvent = appendEvent(harness, { terminalId: "term_worker" });
    service.ack({ ...scope, eventId: sourceEvent.id, terminalId: "term_a" });
    const target = { herdrSessionName: "default", workspaceId: "wC" };
    service.claim({ ...target, paneId: "wC:p1", terminalId: "term_c" });
    service.release({ ...target, reason: "released", terminalId: "term_c" });
    const targetEvent = appendEvent(harness, { terminalId: "term_worker", workspaceId: "wC" });

    expect(
      service.move({
        from: scope,
        paneId: "wC:p2",
        terminalId: "term_a",
        to: target,
      }),
    ).toMatchObject([
      { current: { ackedEventId: sourceEvent.id, owner: null }, reason: "moved" },
      {
        current: { owner: { paneId: "wC:p2", terminalId: "term_a" } },
        previous: { owner: null },
        reason: "moved",
      },
    ]);
    expect(service.pending({ ...target, terminalId: "term_a" })).toMatchObject([
      { id: targetEvent.id },
    ]);

    const unseen = { herdrSessionName: "default", workspaceId: "wD" };
    const unseenBaseline = appendEvent(harness, { terminalId: "term_worker", workspaceId: "wD" });
    service.move({ from: target, paneId: "wD:p1", terminalId: "term_a", to: unseen });
    expect(service.status(unseen)).toMatchObject({ ackedEventId: unseenBaseline.id });
  });

  test("lists persisted owners across sessions", () => {
    const { harness, service } = openService();
    harness.herdrSessions.upsertRunning({
      name: "other",
      sessionDir: "/tmp/other",
      socketPath: "/tmp/other.sock",
    });
    service.claim({ ...scope, paneId: "wB:p1", terminalId: "term_a" });
    service.claim({
      herdrSessionName: "other",
      paneId: "wX:p1",
      terminalId: "term_x",
      workspaceId: "wX",
    });

    expect(service.persistedOwners()).toHaveLength(2);
  });
});
