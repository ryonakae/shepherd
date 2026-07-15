import { stripVTControlCharacters } from "node:util";
import { Box, type Component, Text } from "@earendil-works/pi-tui";
import type { AgentOutcome } from "./wake.js";

export const COLLAPSED_AGENT_UPDATE_LIMIT = 3;

export type AgentUpdateMessageDetails = {
  eventIds: number[];
  outcomes: AgentOutcome[];
};

export type ShepherdFooterState =
  | { kind: "off" }
  | { kind: "on"; updateCount: number }
  | { kind: "reconnecting" };

type MessageLike = {
  content: string;
  details?: unknown;
};

type RenderOptions = { expanded: boolean };

type ThemeLike = {
  bg(color: string, text: string): string;
  bold(text: string): string;
  fg(color: string, text: string): string;
};

const AGENT_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  claude: "Claude",
  codex: "Codex",
  gemini: "Gemini",
  opencode: "OpenCode",
  pi: "Pi",
};

export function agentDisplayName(agent: string): string {
  return AGENT_DISPLAY_NAMES[agent.toLowerCase()] ?? agent;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isAgentOutcome(value: unknown): value is AgentOutcome {
  const candidate = record(value);
  return (
    typeof candidate.agent === "string" &&
    typeof candidate.eventId === "number" &&
    (candidate.kind === "blocked" || candidate.kind === "completed") &&
    (candidate.paneId === null || typeof candidate.paneId === "string") &&
    typeof candidate.terminalId === "string" &&
    typeof candidate.text === "string" &&
    typeof candidate.truncated === "boolean"
  );
}

function messageDetails(value: unknown): AgentUpdateMessageDetails {
  const details = record(value);
  return {
    eventIds: Array.isArray(details.eventIds)
      ? details.eventIds.filter((eventId): eventId is number => typeof eventId === "number")
      : [],
    outcomes: Array.isArray(details.outcomes) ? details.outcomes.filter(isAgentOutcome) : [],
  };
}

function cleanDisplayText(value: string): string {
  return stripVTControlCharacters(value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function updateCountLabel(count: number): string {
  return `${count} agent update${count === 1 ? "" : "s"}`;
}

export function formatShepherdFooterStatus(
  state: ShepherdFooterState,
): string | undefined {
  if (state.kind === "off") return undefined;
  if (state.kind === "reconnecting") return "◇ Shepherd · reconnecting";

  const label = "◆ Shepherd";
  if (state.updateCount === 0) return label;
  return `${label} · ${updateCountLabel(state.updateCount)}`;
}

export function renderAgentUpdateMessage(
  message: MessageLike,
  options: RenderOptions,
  theme: ThemeLike,
): Component {
  const details = messageDetails(message.details);
  const count = details.outcomes.length > 0 ? details.outcomes.length : details.eventIds.length;
  const heading =
    theme.fg("customMessageLabel", `◆ ${theme.bold("Shepherd")}`) +
    theme.fg("muted", ` ${updateCountLabel(count)}`);
  const visibleOutcomes = options.expanded
    ? details.outcomes
    : details.outcomes.slice(0, COLLAPSED_AGENT_UPDATE_LIMIT);
  const rows = visibleOutcomes.flatMap((outcome) => {
    const completed = outcome.kind === "completed";
    const color = completed ? "success" : "warning";
    const glyph = completed ? "✓" : "!";
    const summary = [
      theme.fg(color, glyph),
      theme.bold(agentDisplayName(cleanDisplayText(outcome.agent))),
      theme.fg(color, outcome.kind),
      theme.fg("muted", cleanDisplayText(outcome.paneId ?? "unknown")),
    ].join(" ");
    if (!options.expanded) return [summary];
    const cleanedResponse = cleanDisplayText(outcome.text);
    const response = cleanedResponse.length > 0 ? cleanedResponse : "No final response";
    return [summary, theme.fg("muted", `  Last response  ${response}`)];
  });
  const hiddenCount = details.outcomes.length - visibleOutcomes.length;
  const omission = hiddenCount > 0 ? theme.fg("muted", `… ${hiddenCount} more`) : undefined;
  const text = [heading, ...rows, omission].filter((line) => line !== undefined).join("\n");
  const box = new Box(1, 1, (value) => theme.bg("customMessageBg", value));
  box.addChild(new Text(text, 0, 0));
  return box;
}
