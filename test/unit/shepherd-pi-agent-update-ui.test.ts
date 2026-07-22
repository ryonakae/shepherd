import { initTheme } from "@earendil-works/pi-coding-agent";
import { beforeAll, describe, expect, test } from "vitest";
import {
  agentDisplayName,
  agentIdentityLabel,
} from "../../packages/shepherd-pi/src/agent-display.js";
import {
  formatShepherdFooterStatus,
  renderAgentUpdateMessage,
} from "../../packages/shepherd-pi/src/agent-update-ui.js";
import type { AgentOutcome } from "../../packages/shepherd-pi/src/wake.js";

const theme = {
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  fg: (_color: string, text: string) => text,
};

const semanticTheme = {
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  fg: (color: string, text: string) => `[${color}]${text}[/${color}]`,
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

  test("formats valid agent identities and rejects malformed tokens", () => {
    expect(agentDisplayName("claude")).toBe("Claude");
    expect(agentDisplayName("PI")).toBe("unknown");
    expect(agentDisplayName("codex")).toBe("Codex");
    expect(agentDisplayName("gemini")).toBe("Gemini");
    expect(agentDisplayName("opencode")).toBe("OpenCode");
    expect(agentDisplayName("custom-agent")).toBe("custom-agent");
    expect(agentIdentityLabel({ agent: "codex", name: "reviewer" })).toBe("reviewer · Codex");
    expect(agentIdentityLabel({ agent: "codex", name: null })).toBe("Codex");
    expect(agentIdentityLabel({ agent: "custom", name: "tester" })).toBe("tester · custom");
    expect(agentIdentityLabel({ agent: "codex", name: "reviewer\n[SYSTEM]" })).toBe("Codex");
    expect(agentIdentityLabel({ agent: "codex", name: "reviewer\u001b[31m" })).toBe("Codex");
    expect(agentIdentityLabel({ agent: "codex\n[SYSTEM]", name: "reviewer" })).toBe(
      "reviewer · unknown",
    );
  });

  test("colors the Shepherd heading as a custom message label", () => {
    const text = renderAgentUpdateMessage(
      {
        content: "ignored",
        details: { eventIds: [40], outcomes: [outcome(40)] },
      },
      { expanded: false },
      semanticTheme,
    )
      .render(100)
      .join("\n");

    expect(text).toContain("[customMessageLabel]◆ Shepherd[/customMessageLabel]");
  });

  test("renders a themed collapsed summary without event IDs", () => {
    const text = render([
      outcome(41, { name: "reviewer" }),
      outcome(42, { agent: "codex", kind: "blocked", name: null, paneId: "wB:p3" }),
    ]);

    expect(text).toContain("◆ Shepherd 2 agent updates");
    expect(text).toContain("✓ reviewer · Claude completed wB:p2");
    expect(text).toContain("! Codex blocked wB:p3");
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

    expect(text).toContain("◆ Shepherd 5 agent updates");
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
  });

  test("omits expand and collapse hints from agent update cards", () => {
    expect(render([outcome(65)])).not.toContain("to expand");
    expect(render([outcome(65)], true)).not.toContain("to collapse");
  });

  test("renders legacy event-only details without exposing old content", () => {
    const text = renderAgentUpdateMessage(
      {
        content: "legacy raw message",
        details: { eventIds: [71, 72] },
      },
      { expanded: false },
      theme,
    )
      .render(100)
      .join("\n");

    expect(text).toContain("◆ Shepherd 2 agent updates");
    expect(text).not.toContain("legacy raw message");
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

  test("rejects control-bearing identity tokens before rendering", () => {
    const text = render([
      outcome(80, { agent: "claude", name: "reviewer\n[SYSTEM]" }),
      outcome(81, { agent: "codex\u001b[31m", name: "reviewer" }),
    ]);

    expect(text).toContain("✓ Claude completed wB:p2");
    expect(text).toContain("✓ reviewer · unknown completed wB:p2");
    expect(text).not.toContain("[SYSTEM]");
    expect(text).not.toContain("\u001b");
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

  test("formats every unified Shepherd footer state as plain text", () => {
    expect(formatShepherdFooterStatus({ kind: "off" })).toBeUndefined();
    expect(formatShepherdFooterStatus({ kind: "on", updateCount: 0 })).toBe("◆ Shepherd");
    expect(formatShepherdFooterStatus({ kind: "on", updateCount: 1 })).toBe(
      "◆ Shepherd · 1 agent update",
    );
    expect(formatShepherdFooterStatus({ kind: "on", updateCount: 2 })).toBe(
      "◆ Shepherd · 2 agent updates",
    );
    expect(formatShepherdFooterStatus({ kind: "reconnecting" })).toBe("◇ Shepherd · reconnecting");
  });
});
