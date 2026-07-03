import type {
  AgentSessionRef,
  WorkerEventType,
  WorkerSnapshot,
  WorkerStatus,
  WorkerTelemetryEvent,
} from "@/observability/contracts.js";
import type { TranscriptBackfill } from "@/observability/runtime-adapter.js";

export type WorkerRuleInput = {
  agentInfo?: unknown;
  previousSnapshot?: WorkerSnapshot;
  telemetry?: WorkerTelemetryEvent;
  transcript?: TranscriptBackfill;
  worker: {
    agentName: string | null;
    id: string;
    observedWorkspaceId: string;
    sessionRef: AgentSessionRef | null;
  };
};

export type WorkerRuleOutput = {
  events: Array<{ idempotencyKey: string; payload: unknown; type: WorkerEventType }>;
  snapshot: WorkerSnapshot;
};

const statuses = new Set<WorkerStatus>(["blocked", "done", "idle", "unknown", "working"]);

export function evaluateWorkerState(input: WorkerRuleInput): WorkerRuleOutput {
  const agent = record(input.agentInfo);
  const telemetry = input.telemetry;
  const transcript = input.transcript;
  let status = parseStatus(agent.agent_status) ?? input.previousSnapshot?.status ?? "unknown";
  let confidence: WorkerSnapshot["confidence"] = parseStatus(agent.agent_status) ? "high" : "low";
  let blockedReason: string | null = stringValue(agent.custom_status);
  let completion: string | null = null;
  const currentWork: string | null = null;
  let lastMessageExcerpt = transcript?.lastMessageExcerpt ?? null;
  let lastTool = transcript?.lastTool ?? null;
  let needsInput = false;
  const evidence: WorkerSnapshot["evidence"] = [];
  const events: WorkerRuleOutput["events"] = [];

  if (transcript?.lastMessageExcerpt) {
    evidence.push({ excerpt: bound(transcript.lastMessageExcerpt), source: "transcript" });
  }
  if (transcript?.statusHints.blockedReason) {
    blockedReason = transcript.statusHints.blockedReason;
    needsInput = transcript.statusHints.needsInput ?? true;
    status = "blocked";
    confidence = confidence === "high" ? "high" : "medium";
  }
  if (transcript?.statusHints.completion) {
    completion = transcript.statusHints.completion;
  }

  if (telemetry?.type === "worker.tool.completed") {
    lastTool = {
      ...(telemetry.durationMs !== undefined ? { durationMs: telemetry.durationMs } : {}),
      ...(telemetry.errorExcerpt ? { errorExcerpt: bound(telemetry.errorExcerpt) } : {}),
      ...(telemetry.inputPreview ? { inputPreview: bound(telemetry.inputPreview) } : {}),
      isError: telemetry.isError,
      name: telemetry.toolName,
      ...(telemetry.outputExcerpt ? { outputExcerpt: bound(telemetry.outputExcerpt) } : {}),
      toolCallId: telemetry.toolCallId,
    };
    evidence.push({
      excerpt: bound(
        telemetry.errorExcerpt ?? telemetry.outputExcerpt ?? telemetry.inputPreview ?? "",
      ),
      ...(telemetry.artifactRefs[0] ? { ref: telemetry.artifactRefs[0] } : {}),
      source: "pi",
      timestamp: telemetry.occurredAt,
    });
    if (telemetry.isError) {
      events.push(event("worker.tool.failed", input.worker.id, telemetry.turnId, { lastTool }));
    }
  }

  if (telemetry?.type === "worker.message.final") {
    lastMessageExcerpt = bound(telemetry.textExcerpt);
    evidence.push({
      excerpt: lastMessageExcerpt,
      ...(telemetry.evidenceRefs[0] ? { ref: telemetry.evidenceRefs[0] } : {}),
      source: "pi",
      timestamp: telemetry.occurredAt,
    });
    if (telemetry.blockedHint || /^blocked:/i.test(telemetry.textExcerpt)) {
      blockedReason = telemetry.blockedHint ?? telemetry.textExcerpt;
      needsInput = true;
      status = "blocked";
      confidence = confidence === "high" ? "high" : "medium";
    }
    if (telemetry.completionHint) {
      completion = telemetry.completionHint;
      if (status === "idle" || status === "done" || !parseStatus(agent.agent_status)) {
        status = "done";
        confidence = confidence === "high" ? "high" : "medium";
      }
    }
    if (telemetry.needsInputHint) {
      needsInput = true;
    }
  }

  if (status === "blocked") {
    events.push(
      event("worker.blocked", input.worker.id, blockedReason ?? "blocked", { blockedReason }),
    );
  }
  if (completion) {
    events.push(event("worker.completed", input.worker.id, completion, { completion }));
  }
  if (needsInput) {
    events.push(
      event(
        "worker.needs_input",
        input.worker.id,
        blockedReason ?? lastMessageExcerpt ?? "needs-input",
        { blockedReason },
      ),
    );
  }
  if (input.previousSnapshot && input.previousSnapshot.status !== status) {
    events.push(
      event(
        "worker.status.changed",
        input.worker.id,
        `${input.previousSnapshot.status}:${status}`,
        {
          from: input.previousSnapshot.status,
          to: status,
        },
      ),
    );
  }

  const snapshot: WorkerSnapshot = {
    agent: input.worker.agentName,
    blockedReason,
    completion,
    confidence,
    currentWork,
    evidence: evidence.slice(-5).map((item) => ({
      ...(item.excerpt ? { excerpt: bound(item.excerpt) } : {}),
      ...(item.ref ? { ref: item.ref } : {}),
      source: item.source,
      ...(item.timestamp ? { timestamp: item.timestamp } : {}),
    })),
    id: input.worker.id,
    lastActivityAt: telemetry && "occurredAt" in telemetry ? telemetry.occurredAt : null,
    lastMessageExcerpt,
    lastTool,
    needsInput,
    observedWorkspaceId: input.worker.observedWorkspaceId,
    pane: null,
    recommendedAction: needsInput ? "ask-orchestrator-for-input" : null,
    sessionRef: input.worker.sessionRef,
    status,
    summary: lastMessageExcerpt ?? currentWork,
  };

  return { events: dedupeEvents(events), snapshot };
}

function event(type: WorkerEventType, workerId: string, suffix: string, payload: unknown) {
  return { idempotencyKey: `${type}:${workerId}:${suffix}`, payload, type };
}

function dedupeEvents(events: WorkerRuleOutput["events"]): WorkerRuleOutput["events"] {
  const seen = new Set<string>();
  return events.filter((item) => {
    if (seen.has(item.idempotencyKey)) {
      return false;
    }
    seen.add(item.idempotencyKey);
    return true;
  });
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseStatus(value: unknown): WorkerStatus | null {
  return typeof value === "string" && statuses.has(value as WorkerStatus)
    ? (value as WorkerStatus)
    : null;
}

function bound(value: string): string {
  return value.length > 4096 ? value.slice(0, 4096) : value;
}
