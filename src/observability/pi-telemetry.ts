import type {
  AgentSessionRef,
  WorkerMessageFinalTelemetryEvent,
  WorkerTelemetryEvent,
  WorkerToolTelemetryEvent,
} from "@/observability/contracts.js";

const maxExcerptLength = 4096;
const secretPatterns = [
  /(Authorization:\s*Bearer\s+)[^\s]+/gi,
  /\b(token=)[^\s&]+/gi,
  /\b(password=)[^\s&]+/gi,
  /\b(secret=)[^\s&]+/gi,
  /\b(api_key=)[^\s&]+/gi,
];
const blockedPattern = /\b(blocked|cannot proceed)\b|ブロック|確認が必要/i;
const completionPattern = /\b(done|completed)\b|完了|実装しました|修正しました/i;
const needsInputPattern = /\b(need input|needs input|confirm|confirmation|確認が必要)\b/i;

export function sanitizeTelemetryExcerpt(
  value: unknown,
  options: { maxLength?: number } = {},
): { redacted: boolean; text: string } {
  const maxLength = options.maxLength ?? maxExcerptLength;
  let text = typeof value === "string" ? value : JSON.stringify(value);
  if (text === undefined) {
    text = String(value);
  }

  let redacted = false;
  for (const pattern of secretPatterns) {
    text = text.replace(pattern, (_match, prefix: string) => {
      redacted = true;
      return `${prefix}[REDACTED]`;
    });
  }

  if (text.length > maxLength) {
    text = text.slice(0, maxLength);
  }

  return { redacted, text };
}

export function piTelemetryIdempotencyKey(event: WorkerTelemetryEvent): string {
  if (event.type === "worker.tool.completed") {
    return `telemetry:pi:${event.turnId}:tool:${event.toolCallId}:completed`;
  }
  if (event.type === "worker.message.final") {
    return `telemetry:pi:${event.turnId}:message:final`;
  }
  return `telemetry:pi:${event.workerKey ?? event.sessionRef?.value ?? "unknown"}:lifecycle:${event.status}`;
}

export function normalizePiToolTelemetry(input: {
  artifactRefs?: string[];
  durationMs?: number;
  inputPreview?: unknown;
  isError: boolean;
  occurredAt?: string;
  output?: unknown;
  runtime?: string;
  sessionRef: AgentSessionRef | null;
  toolCallId: string;
  toolName: string;
  turnId: string;
  workerKey?: string | null;
}): WorkerToolTelemetryEvent {
  const inputPreview = sanitizeTelemetryExcerpt(input.inputPreview ?? "");
  const output = sanitizeTelemetryExcerpt(input.output ?? "");
  return {
    artifactRefs: input.artifactRefs ?? [],
    ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
    ...(input.isError ? { errorExcerpt: output.text } : { outputExcerpt: output.text }),
    inputPreview: inputPreview.text,
    isError: input.isError,
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    redactionApplied: inputPreview.redacted || output.redacted,
    runtime: input.runtime ?? "pi",
    sessionRef: input.sessionRef,
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    turnId: input.turnId,
    type: "worker.tool.completed",
    workerKey: input.workerKey ?? null,
  };
}

export function normalizePiMessageFinalTelemetry(input: {
  evidenceRefs?: string[];
  occurredAt?: string;
  runtime?: string;
  sessionRef: AgentSessionRef | null;
  stopReason: string;
  text: unknown;
  turnId: string;
  workerKey?: string | null;
}): WorkerMessageFinalTelemetryEvent {
  const excerpt = sanitizeTelemetryExcerpt(input.text);
  return {
    ...(blockedPattern.test(excerpt.text) ? { blockedHint: excerpt.text } : {}),
    ...(completionPattern.test(excerpt.text) ? { completionHint: excerpt.text } : {}),
    evidenceRefs: input.evidenceRefs ?? [],
    ...(needsInputPattern.test(excerpt.text) ? { needsInputHint: excerpt.text } : {}),
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    redactionApplied: excerpt.redacted,
    runtime: input.runtime ?? "pi",
    sessionRef: input.sessionRef,
    stopReason: input.stopReason,
    textExcerpt: excerpt.text,
    turnId: input.turnId,
    type: "worker.message.final",
    workerKey: input.workerKey ?? null,
  };
}
