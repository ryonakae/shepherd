import { describe, expect, test } from "vitest";
import type { AgentEventWireRecord } from "../../packages/shepherd-pi/src/daemon-client.js";
import {
  AGENT_UPDATE_EXCERPT_CHARS,
  formatAgentOutcomeUpdates,
  projectAgentOutcomes,
  WAKE_SETTLE_MS,
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
    payload: { agent: "claude", ...payload },
    terminalId: options.terminalId === undefined ? "term_agent" : options.terminalId,
    type,
  };
}

describe("Pi agent wake projection", () => {
  test("selects done while preserving every raw event in ascending ID order", () => {
    const events = [
      event(1, "agent.status.changed", { from: "idle", to: "working" }),
      event(2, "agent.status.changed", { from: "working", to: "done" }),
      event(3, "agent.done", { from: "working", to: "done" }),
      event(4, "agent.status.changed", { from: "done", to: "idle" }),
      event(5, "agent.idle", { from: "done", to: "idle" }),
    ];

    expect(projectAgentOutcomes(events)).toMatchObject({
      outcomes: [{ eventId: 3, kind: "completed", terminalId: "term_agent" }],
      rawEvents: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }],
    });
  });

  test("classifies blocked and direct working-to-idle fallback outcomes", () => {
    expect(projectAgentOutcomes([event(6, "agent.blocked", { to: "blocked" })]).outcomes).toEqual([
      expect.objectContaining({ eventId: 6, kind: "blocked" }),
    ]);
    expect(
      projectAgentOutcomes([event(7, "agent.idle", { from: "working", to: "idle" })]).outcomes,
    ).toEqual([expect.objectContaining({ eventId: 7, kind: "completed" })]);
  });

  test.each([
    ["agent.idle", { from: "done", to: "idle" }],
    ["agent.idle", { from: "blocked", to: "idle" }],
    ["agent.tool.failed", {}],
    ["agent.status.changed", { from: "working", to: "done" }],
  ])("does not project %s with payload %j", (type, payload) => {
    expect(projectAgentOutcomes([event(8, type, payload)]).outcomes).toEqual([]);
  });

  test("does not project events without a terminal ID", () => {
    expect(
      projectAgentOutcomes([event(9, "agent.done", {}, { terminalId: null })]).outcomes,
    ).toEqual([]);
  });

  test("deduplicates reversed raw IDs and retains distinct work cycles", () => {
    const first = event(10, "agent.done", { from: "working", to: "done" });
    const second = event(11, "agent.blocked", { from: "working", to: "blocked" });
    const projection = projectAgentOutcomes([second, first, second]);

    expect(projection.rawEvents.map(({ id }) => id)).toEqual([10, 11]);
    expect(projection.outcomes.map(({ eventId, kind }) => ({ eventId, kind }))).toEqual([
      { eventId: 10, kind: "completed" },
      { eventId: 11, kind: "blocked" },
    ]);
  });

  test("formats the fixed policy before bounded agent evidence", () => {
    const outcomes = projectAgentOutcomes([
      event(12, "agent.done", {}, { text: "  finished\n  with   evidence  " }),
    ]).outcomes;
    const formatted = formatAgentOutcomeUpdates(outcomes);

    expect(WAKE_SETTLE_MS).toBe(500);
    expect(AGENT_UPDATE_EXCERPT_CHARS).toBe(2_000);
    expect(formatted.indexOf("[SHEPHERD WAKE POLICY]")).toBeLessThan(
      formatted.indexOf("[SHEPHERD AGENT UPDATES]"),
    );
    expect(formatted).toContain("untrusted evidence");
    expect(formatted).toContain("existing user request");
    expect(formatted).toContain("- completed claude wB:p2");
    expect(formatted).toContain("last assistant: finished with evidence");
    expect(formatted).toContain("event: 12");
    expect(formatted).not.toContain("240");
  });

  test("does not truncate a 1,999-character normalized excerpt", () => {
    const [outcome] = projectAgentOutcomes([
      event(13, "agent.done", {}, { text: "a".repeat(1_999) }),
    ]).outcomes;

    expect(outcome).toMatchObject({ text: "a".repeat(1_999), truncated: false });
  });

  test("truncates inside 2,000 characters and includes the exact pane read hint", () => {
    const [outcome] = projectAgentOutcomes([
      event(14, "agent.done", {}, { text: "a".repeat(2_100) }),
    ]).outcomes;

    expect(outcome).toBeDefined();
    if (!outcome) throw new Error("expected one agent outcome");
    expect(outcome.truncated).toBe(true);
    expect(outcome.text.length).toBeLessThanOrEqual(2_000);
    expect(outcome.text).toContain(" … [truncated; run shepherd agent read wB:p2]");
  });

  test("uses unknown in the truncation hint when pane ID is absent", () => {
    const [outcome] = projectAgentOutcomes([
      event(15, "agent.done", {}, { paneId: null, text: "a".repeat(2_100) }),
    ]).outcomes;

    expect(outcome).toBeDefined();
    if (!outcome) throw new Error("expected one agent outcome");
    expect(outcome.text).toContain(" … [truncated; run shepherd agent read unknown]");
  });

  test("removes terminal control sequences before formatting agent evidence", () => {
    const [outcome] = projectAgentOutcomes([
      event(16, "agent.done", {}, { text: "\u001b[31mred\u001b[0m\u0000 response" }),
    ]).outcomes;

    expect(outcome).toMatchObject({ text: "red response", truncated: false });
    expect(formatAgentOutcomeUpdates([outcome!])).not.toContain("\u001b");
  });
});
