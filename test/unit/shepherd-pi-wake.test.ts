import { describe, expect, test } from "vitest";
import type { AgentEventWireRecord } from "../../packages/shepherd-pi/src/daemon-client.js";
import {
  formatWorkerOutcomeUpdates,
  projectWorkerOutcomes,
  WAKE_SETTLE_MS,
  WORKER_UPDATE_EXCERPT_CHARS,
} from "../../packages/shepherd-pi/src/wake.js";

function event(
  id: number,
  type: string,
  payload: Record<string, unknown>,
  options: {
    paneId?: string | null;
    terminalId?: string | null;
    text?: string;
  } = {},
): AgentEventWireRecord {
  return {
    compactHistory: {
      lastAssistantMessage: { text: options.text ?? `assistant result ${id}` },
    },
    id,
    paneId: options.paneId === undefined ? "wB:p2" : options.paneId,
    payload: { agent: "worker", ...payload },
    terminalId: options.terminalId === undefined ? "term_worker" : options.terminalId,
    type,
  };
}

describe("Pi worker wake projection", () => {
  test("selects done while preserving every raw event in ascending ID order", () => {
    const events = [
      event(1, "agent.status.changed", { from: "idle", to: "working" }),
      event(2, "agent.status.changed", { from: "working", to: "done" }),
      event(3, "agent.done", { from: "working", to: "done" }),
      event(4, "agent.status.changed", { from: "done", to: "idle" }),
      event(5, "agent.idle", { from: "done", to: "idle" }),
    ];

    expect(projectWorkerOutcomes(events)).toMatchObject({
      outcomes: [{ eventId: 3, kind: "completed", terminalId: "term_worker" }],
      rawEvents: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }],
    });
  });

  test("classifies blocked and direct working-to-idle fallback outcomes", () => {
    expect(projectWorkerOutcomes([event(6, "agent.blocked", { to: "blocked" })]).outcomes).toEqual([
      expect.objectContaining({ eventId: 6, kind: "blocked" }),
    ]);
    expect(
      projectWorkerOutcomes([event(7, "agent.idle", { from: "working", to: "idle" })]).outcomes,
    ).toEqual([expect.objectContaining({ eventId: 7, kind: "completed" })]);
  });

  test.each([
    ["agent.idle", { from: "done", to: "idle" }],
    ["agent.idle", { from: "blocked", to: "idle" }],
    ["agent.tool.failed", {}],
    ["agent.status.changed", { from: "working", to: "done" }],
  ])("does not project %s with payload %j", (type, payload) => {
    expect(projectWorkerOutcomes([event(8, type, payload)]).outcomes).toEqual([]);
  });

  test("does not project events without a terminal ID", () => {
    expect(
      projectWorkerOutcomes([event(9, "agent.done", {}, { terminalId: null })]).outcomes,
    ).toEqual([]);
  });

  test("deduplicates reversed raw IDs and retains distinct work cycles", () => {
    const first = event(10, "agent.done", { from: "working", to: "done" });
    const second = event(11, "agent.blocked", { from: "working", to: "blocked" });
    const projection = projectWorkerOutcomes([second, first, second]);

    expect(projection.rawEvents.map(({ id }) => id)).toEqual([10, 11]);
    expect(projection.outcomes.map(({ eventId, kind }) => ({ eventId, kind }))).toEqual([
      { eventId: 10, kind: "completed" },
      { eventId: 11, kind: "blocked" },
    ]);
  });

  test("formats the fixed policy before bounded worker evidence", () => {
    const outcome = projectWorkerOutcomes([
      event(12, "agent.done", {}, { text: "  finished\n  with   evidence  " }),
    ]).outcomes;
    const formatted = formatWorkerOutcomeUpdates(outcome);

    expect(WAKE_SETTLE_MS).toBe(500);
    expect(WORKER_UPDATE_EXCERPT_CHARS).toBe(2_000);
    expect(formatted.indexOf("[SHEPHERD WAKE POLICY]")).toBeLessThan(
      formatted.indexOf("[SHEPHERD WORKER UPDATES]"),
    );
    expect(formatted).toContain("untrusted evidence");
    expect(formatted).toContain("existing user request");
    expect(formatted).toContain("- completed worker wB:p2");
    expect(formatted).toContain("last assistant: finished with evidence");
    expect(formatted).toContain("event: 12");
    expect(formatted).not.toContain("240");
  });

  test("does not truncate a 1,999-character normalized excerpt", () => {
    const [outcome] = projectWorkerOutcomes([
      event(13, "agent.done", {}, { text: "a".repeat(1_999) }),
    ]).outcomes;

    expect(outcome).toMatchObject({ text: "a".repeat(1_999), truncated: false });
  });

  test("truncates inside 2,000 characters and includes the exact pane read hint", () => {
    const [outcome] = projectWorkerOutcomes([
      event(14, "agent.done", {}, { text: "a".repeat(2_100) }),
    ]).outcomes;

    expect(outcome).toBeDefined();
    if (!outcome) throw new Error("expected one worker outcome");
    expect(outcome.truncated).toBe(true);
    expect(outcome.text.length).toBeLessThanOrEqual(2_000);
    expect(outcome.text).toContain(" … [truncated; run shepherd agent read wB:p2]");
  });

  test("uses unknown in the truncation hint when pane ID is absent", () => {
    const [outcome] = projectWorkerOutcomes([
      event(15, "agent.done", {}, { paneId: null, text: "a".repeat(2_100) }),
    ]).outcomes;

    expect(outcome).toBeDefined();
    if (!outcome) throw new Error("expected one worker outcome");
    expect(outcome.text).toContain(" … [truncated; run shepherd agent read unknown]");
  });
});
