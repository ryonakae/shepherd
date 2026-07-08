import type { AgentSessionRef, AgentTelemetryEvent } from "./contracts.js";

const maxExcerptLength = 4096;
const completionPattern = /\b(done|completed|完了|実装しました|修正しました)\b/i;
const needsInputPattern = /\b(blocked|ブロック|確認が必要|cannot proceed|need input)\b/i;

export function sanitizeTelemetryExcerpt(value: unknown): { redacted: boolean; text: string } {
  let text = typeof value === "string" ? value : JSON.stringify(value);
  if (text === undefined) text = String(value);
  let redacted = false;
  for (const pattern of [
    /(Authorization:\s*Bearer\s+)[^\s]+/gi,
    /\b(token=)[^\s&]+/gi,
    /\b(password=)[^\s&]+/gi,
    /\b(secret=)[^\s&]+/gi,
    /\b(api_key=)[^\s&]+/gi,
  ]) {
    text = text.replace(pattern, (_match, prefix: string) => {
      redacted = true;
      return `${prefix}[REDACTED]`;
    });
  }
  return {
    redacted,
    text: text.length > maxExcerptLength ? text.slice(0, maxExcerptLength) : text,
  };
}

export function piTelemetryIdempotencyKey(event: AgentTelemetryEvent): string {
  if (event.type === "agent.tool.completed") {
    return `telemetry:pi:${event.turnId}:tool:${event.toolCallId}:completed`;
  }
  return `telemetry:pi:${event.turnId}:message:final`;
}

export function normalizePiToolTelemetry(input: {
  artifactRefs?: string[];
  durationMs?: number;
  inputPreview?: unknown;
  isError: boolean;
  output: unknown;
  sessionRef: AgentSessionRef | null;
  toolCallId: string;
  toolName: string;
  turnId: string;
}): Extract<AgentTelemetryEvent, { type: "agent.tool.completed" }> {
  const output = sanitizeTelemetryExcerpt(input.output);
  const inputPreview =
    input.inputPreview === undefined ? undefined : sanitizeTelemetryExcerpt(input.inputPreview);
  return {
    artifactRefs: input.artifactRefs ?? [],
    ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
    ...(input.isError ? { errorExcerpt: output.text } : { outputExcerpt: output.text }),
    ...(inputPreview ? { inputPreview: inputPreview.text } : {}),
    isError: input.isError,
    occurredAt: new Date().toISOString(),
    redactionApplied: output.redacted || (inputPreview?.redacted ?? false),
    runtime: "pi",
    sessionRef: input.sessionRef,
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    turnId: input.turnId,
    type: "agent.tool.completed",
  };
}

export function normalizePiMessageFinalTelemetry(input: {
  sessionRef: AgentSessionRef | null;
  stopReason: string;
  text: unknown;
  turnId: string;
}): Extract<AgentTelemetryEvent, { type: "agent.message.final" }> {
  const excerpt = sanitizeTelemetryExcerpt(input.text);
  return {
    ...(completionPattern.test(excerpt.text) ? { completionHint: excerpt.text } : {}),
    evidenceRefs: [],
    ...(needsInputPattern.test(excerpt.text) ? { needsInputHint: excerpt.text } : {}),
    occurredAt: new Date().toISOString(),
    redactionApplied: excerpt.redacted,
    runtime: "pi",
    sessionRef: input.sessionRef,
    stopReason: input.stopReason,
    textExcerpt: excerpt.text,
    turnId: input.turnId,
    type: "agent.message.final",
  };
}
