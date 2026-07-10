import { afterEach, describe, expect, test } from "vitest";
import { cleanupTempDirs, openObservabilityDbHarness } from "./observability-db-harness.js";

afterEach(cleanupTempDirs);

const defaultScope = { herdrSessionName: "default", workspaceId: "wB" };

function openStore() {
  const harness = openObservabilityDbHarness();
  harness.herdrSessions.upsertRunning({
    name: "default",
    sessionDir: "/tmp/herdr",
    socketPath: "/tmp/herdr.sock",
  });
  harness.herdrSessions.upsertRunning({
    name: "other",
    sessionDir: "/tmp/other-herdr",
    socketPath: "/tmp/other-herdr.sock",
  });
  return harness.agentOrchestratorScopes;
}

describe("AgentOrchestratorScopeStore", () => {
  test("is absent before its first claim", () => {
    const store = openStore();

    expect(store.get(defaultScope)).toBeUndefined();
  });

  test("initializes the cursor once and replaces the owner without resetting it", () => {
    const store = openStore();

    const first = store.claim({
      ...defaultScope,
      initialAckedEventId: 12,
      paneId: "wB:p1",
      terminalId: "term_1",
    });
    expect(first.current).toMatchObject({
      ackedEventId: 12,
      ...defaultScope,
      owner: { paneId: "wB:p1", terminalId: "term_1" },
    });
    expect(first.previous).toMatchObject({ ackedEventId: 12, ...defaultScope, owner: null });
    expect(first.previous.updatedAt).toEqual(first.current.updatedAt);

    const replacement = store.claim({
      ...defaultScope,
      initialAckedEventId: 99,
      paneId: "wB:p2",
      terminalId: "term_2",
    });
    expect(replacement.previous.owner).toEqual({ paneId: "wB:p1", terminalId: "term_1" });
    expect(replacement.current).toMatchObject({
      ackedEventId: 12,
      owner: { paneId: "wB:p2", terminalId: "term_2" },
    });

    const movedPane = store.claim({
      ...defaultScope,
      initialAckedEventId: 99,
      paneId: "wB:p3",
      terminalId: "term_2",
    });
    expect(movedPane.current).toMatchObject({
      ackedEventId: 12,
      owner: { paneId: "wB:p3", terminalId: "term_2" },
    });
  });

  test("releases only the current owner and preserves its cursor", () => {
    const store = openStore();
    store.claim({
      ...defaultScope,
      initialAckedEventId: 12,
      paneId: "wB:p1",
      terminalId: "term_1",
    });

    expect(store.releaseIfOwner({ ...defaultScope, terminalId: "term_2" })).toMatchObject({
      changed: false,
      current: { owner: { paneId: "wB:p1", terminalId: "term_1" } },
    });
    expect(store.releaseIfOwner({ ...defaultScope, terminalId: "term_1" })).toMatchObject({
      changed: true,
      current: { ackedEventId: 12, owner: null },
      previous: { owner: { paneId: "wB:p1", terminalId: "term_1" } },
    });
  });

  test("acknowledges monotonically and only for the current owner", () => {
    const store = openStore();
    store.claim({
      ...defaultScope,
      initialAckedEventId: 12,
      paneId: "wB:p1",
      terminalId: "term_1",
    });

    expect(store.ack({ ...defaultScope, eventId: 20, terminalId: "term_1" }).ackedEventId).toBe(20);
    expect(store.ack({ ...defaultScope, eventId: 18, terminalId: "term_1" }).ackedEventId).toBe(20);
    expect(() => store.ack({ ...defaultScope, eventId: 21, terminalId: "term_2" })).toThrow(
      "Only the current orchestrator can acknowledge notifications",
    );
  });

  test("moves ownership atomically while preserving initialized cursors", () => {
    const store = openStore();
    store.claim({
      ...defaultScope,
      initialAckedEventId: 12,
      paneId: "wB:p1",
      terminalId: "term_1",
    });
    store.ack({ ...defaultScope, eventId: 20, terminalId: "term_1" });
    const target = { herdrSessionName: "default", workspaceId: "wC" };
    store.claim({ ...target, initialAckedEventId: 5, paneId: "wC:p2", terminalId: "term_2" });

    const changes = store.moveOwner({
      from: defaultScope,
      initialTargetAckedEventId: 99,
      paneId: "wC:p3",
      terminalId: "term_1",
      to: target,
    });
    expect(changes).toMatchObject([
      { current: { ackedEventId: 20, owner: null } },
      {
        current: { ackedEventId: 5, owner: { paneId: "wC:p3", terminalId: "term_1" } },
        previous: { owner: { paneId: "wC:p2", terminalId: "term_2" } },
      },
    ]);

    const newTarget = { herdrSessionName: "default", workspaceId: "wD" };
    store.moveOwner({
      from: target,
      initialTargetAckedEventId: 31,
      paneId: "wD:p1",
      terminalId: "term_1",
      to: newTarget,
    });
    expect(store.get(newTarget)).toMatchObject({
      ackedEventId: 31,
      owner: { paneId: "wD:p1", terminalId: "term_1" },
    });
  });

  test("lists only owned scopes for the requested Herdr session", () => {
    const store = openStore();
    store.claim({ ...defaultScope, initialAckedEventId: 1, paneId: "wB:p1", terminalId: "term_1" });
    store.claim({
      herdrSessionName: "default",
      initialAckedEventId: 1,
      paneId: "wC:p1",
      terminalId: "term_2",
      workspaceId: "wC",
    });
    store.releaseIfOwner({
      herdrSessionName: "default",
      terminalId: "term_2",
      workspaceId: "wC",
    });
    store.claim({
      herdrSessionName: "other",
      initialAckedEventId: 1,
      paneId: "wB:p1",
      terminalId: "term_3",
      workspaceId: "wB",
    });

    expect(store.listOwnedForSession("default")).toMatchObject([
      { ...defaultScope, owner: { paneId: "wB:p1", terminalId: "term_1" } },
    ]);
  });
});
