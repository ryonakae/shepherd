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
    const baseline = appendEvent(harness, { terminalId: "term_agent" });

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
    harness.agentEvents.append({
      herdrSessionName: "default",
      payload: {},
      terminalId: null,
      type: "agent.done",
      workspaceId: "wB",
    });
    const agentEvent = appendEvent(harness, { terminalId: "term_agent" });
    appendEvent(harness, { terminalId: "term_other", workspaceId: "wC" });

    expect(service.pending({ ...scope, terminalId: "term_owner" })).toEqual([
      expect.objectContaining({ id: agentEvent.id }),
    ]);
    expect(service.pending({ ...scope, terminalId: "term_agent" })).toEqual([]);
  });

  test("drops ownerless events but preserves direct replacement events", () => {
    const { harness, service } = openService();
    service.claim({ ...scope, paneId: "wB:p1", terminalId: "term_a" });
    service.release({ ...scope, reason: "released", terminalId: "term_a" });
    appendEvent(harness, { terminalId: "term_agent" });
    const ownerlessLater = appendEvent(harness, { terminalId: "term_agent_2" });
    const reclaimed = service.claim({ ...scope, paneId: "wB:p2", terminalId: "term_b" });

    expect(reclaimed.current.ackedEventId).toBe(ownerlessLater.id);
    expect(service.pending({ ...scope, terminalId: "term_b" })).toEqual([]);

    const pending = appendEvent(harness, { terminalId: "term_agent" });
    const later = appendEvent(harness, { terminalId: "term_agent_2" });
    service.claim({ ...scope, paneId: "wB:p3", terminalId: "term_c" });
    expect(service.pending({ ...scope, terminalId: "term_c" })).toMatchObject([
      { id: pending.id },
      { id: later.id },
    ]);
    expect(() => service.ack({ ...scope, eventId: later.id, terminalId: "term_c" })).toThrow(
      "Only the next pending orchestrator event can be acknowledged",
    );
    expect(() =>
      service.ack({ ...scope, eventId: later.id + 10_000, terminalId: "term_c" }),
    ).toThrow("Only the next pending orchestrator event can be acknowledged");
    expect(service.ack({ ...scope, eventId: pending.id, terminalId: "term_c" }).ackedEventId).toBe(
      pending.id,
    );
    expect(service.ack({ ...scope, eventId: pending.id, terminalId: "term_c" }).ackedEventId).toBe(
      pending.id,
    );
    expect(() => service.ack({ ...scope, eventId: later.id, terminalId: "term_b" })).toThrow(
      "Only the current orchestrator can acknowledge notifications",
    );
  });

  test("moves ownership with target ownerless-drop and active-owner preservation", () => {
    const { harness, service } = openService();
    service.claim({ ...scope, paneId: "wB:p1", terminalId: "term_a" });
    const sourceEvent = appendEvent(harness, { terminalId: "term_agent" });
    service.ack({ ...scope, eventId: sourceEvent.id, terminalId: "term_a" });
    const target = { herdrSessionName: "default", workspaceId: "wC" };
    service.claim({ ...target, paneId: "wC:p1", terminalId: "term_c" });
    service.release({ ...target, reason: "released", terminalId: "term_c" });
    const ownerlessTargetEvent = appendEvent(harness, {
      terminalId: "term_agent",
      workspaceId: "wC",
    });

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
        current: {
          ackedEventId: ownerlessTargetEvent.id,
          owner: { paneId: "wC:p2", terminalId: "term_a" },
        },
        previous: { owner: null },
        reason: "moved",
      },
    ]);
    expect(service.pending({ ...target, terminalId: "term_a" })).toEqual([]);

    const ownedTarget = { herdrSessionName: "default", workspaceId: "wD" };
    service.claim({ ...ownedTarget, paneId: "wD:p1", terminalId: "term_d" });
    const pendingTargetEvent = appendEvent(harness, {
      terminalId: "term_agent",
      workspaceId: "wD",
    });
    service.move({ from: target, paneId: "wD:p2", terminalId: "term_a", to: ownedTarget });
    expect(service.pending({ ...ownedTarget, terminalId: "term_a" })).toMatchObject([
      { id: pendingTargetEvent.id },
    ]);

    const unseen = { herdrSessionName: "default", workspaceId: "wE" };
    const unseenBaseline = appendEvent(harness, { terminalId: "term_agent", workspaceId: "wE" });
    service.move({ from: ownedTarget, paneId: "wE:p1", terminalId: "term_a", to: unseen });
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
