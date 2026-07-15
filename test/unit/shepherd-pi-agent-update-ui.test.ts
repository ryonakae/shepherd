import { initTheme } from "@earendil-works/pi-coding-agent";
import { beforeAll, describe, expect, test } from "vitest";
import {
  agentDisplayName,
  formatShepherdFooterStatus,
  renderAgentUpdateMessage,
} from "../../packages/shepherd-pi/src/agent-update-ui.js";
import type { AgentOutcome } from "../../packages/shepherd-pi/src/wake.js";

const theme = {
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  fg: (_color: string, text: string) => text,
};

function outcome(eventId: number, options: Partial<AgentOutcome> = {}): AgentOutcome {
  return {
    agent: "claude",
    eventId,
    kind: "completed",
    paneId: "wB:p2",
    terminalId: "term_agent",
    text: `response ${eventId}`,
    truncated: false,
    ...options,
  };
}

function render(
  outcomes: AgentOutcome[],
  expanded = false,
  eventIds = outcomes.map(({ eventId }) => eventId),
): string {
  return renderAgentUpdateMessage(
    { content: "ignored", details: { eventIds, outcomes } },
    { expanded },
    theme,
  )
    .render(100)
    .join("\n");
}

describe("Shepherd Pi agent update UI", () => {
  beforeAll(() => initTheme("dark"));

  test("uses product casing for known agents and preserves unknown names", () => {
    expect(agentDisplayName("claude")).toBe("Claude");
    expect(agentDisplayName("PI")).toBe("Pi");
    expect(agentDisplayName("codex")).toBe("Codex");
    expect(agentDisplayName("gemini")).toBe("Gemini");
    expect(agentDisplayName("opencode")).toBe("OpenCode");
    expect(agentDisplayName("custom-agent")).toBe("custom-agent");
  });

  test("renders a themed collapsed summary without event IDs", () => {
    const text = render([
      outcome(41),
      outcome(42, { agent: "codex", kind: "blocked", paneId: "wB:p3" }),
    ]);

    expect(text).toContain("◆ Shepherd · 2 agent updates");
    expect(text).toContain("✓ Claude · completed · wB:p2");
    expect(text).toContain("! Codex · blocked · wB:p3");
    expect(text).toContain("to expand");
    expect(text).not.toContain("41");
    expect(text).not.toContain("42");
  });

  test("limits collapsed cards to three outcome rows", () => {
    const text = render([
      outcome(51, { paneId: "wB:p1" }),
      outcome(52, { paneId: "wB:p2" }),
      outcome(53, { paneId: "wB:p3" }),
      outcome(54, { paneId: "wB:p4" }),
      outcome(55, { paneId: "wB:p5" }),
    ]);

    expect(text).toContain("◆ Shepherd · 5 agent updates");
    expect(text).toContain("wB:p1");
    expect(text).toContain("wB:p3");
    expect(text).not.toContain("wB:p4");
    expect(text).toContain("… 2 more");
  });

  test("expands every outcome with its bounded final response", () => {
    const text = render(
      [
        outcome(61, { paneId: "wB:p1", text: "first response" }),
        outcome(62, { paneId: "wB:p2", text: "" }),
        outcome(63, { paneId: "wB:p3" }),
        outcome(64, { paneId: "wB:p4", text: "fourth response" }),
      ],
      true,
    );

    expect(text).toContain("wB:p4");
    expect(text).not.toContain("… 1 more");
    expect(text).toContain("Last response  first response");
    expect(text).toContain("Last response  No final response");
    expect(text).toContain("to collapse");
  });

  test("renders legacy event-only details without exposing old content", () => {
    const text = renderAgentUpdateMessage(
      {
        content: "Shepherd received 2 worker updates.",
        details: { eventIds: [71, 72] },
      },
      { expanded: false },
      theme,
    )
      .render(100)
      .join("\n");

    expect(text).toContain("◆ Shepherd · 2 agent updates");
    expect(text).not.toContain("worker");
    expect(text).not.toContain("to expand");
  });

  test("contains malformed custom message details", () => {
    expect(() =>
      renderAgentUpdateMessage(
        { content: "ignored", details: { eventIds: ["bad"], outcomes: [null, {}] } },
        { expanded: false },
        theme,
      ).render(100),
    ).not.toThrow();
  });

  test("strips terminal controls again at the rendering boundary", () => {
    const unsafe =
      "\u001b[31mred\u001b[0m \u001b]8;;https://example.com\u0007link\u001b]8;;\u0007 \u0000response\u0085";
    const text = render([outcome(81, { text: unsafe })], true);

    expect(text).toContain("Last response  red link response");
    expect(text).not.toContain("\u001b[31m");
    expect(text).not.toContain("https://example.com");
    expect(text).not.toContain("\u0000");
    expect(text).not.toContain("\u0085");
  });

  test("formats every unified Shepherd footer state", () => {
    expect(formatShepherdFooterStatus({ kind: "off" }, theme)).toBeUndefined();
    expect(formatShepherdFooterStatus({ kind: "on", updateCount: 0 }, theme)).toBe("◆ Shepherd");
    expect(formatShepherdFooterStatus({ kind: "on", updateCount: 1 }, theme)).toBe(
      "◆ Shepherd · 1 agent update",
    );
    expect(formatShepherdFooterStatus({ kind: "on", updateCount: 2 }, theme)).toBe(
      "◆ Shepherd · 2 agent updates",
    );
    expect(formatShepherdFooterStatus({ kind: "reconnecting" }, theme)).toBe(
      "◇ Shepherd · reconnecting",
    );
  });
});
