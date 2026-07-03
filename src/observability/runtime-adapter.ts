import type { AgentSessionRef, WorkerSnapshot, WorkerTelemetryEvent } from "./contracts.js";

export type TranscriptBackfill = {
  evidence: WorkerSnapshot["evidence"];
  lastMessageExcerpt: string | null;
  lastTool: WorkerSnapshot["lastTool"];
  statusHints: {
    blockedReason?: string;
    completion?: string;
    needsInput?: boolean;
  };
};

export interface TranscriptAdapter {
  canRead(session: AgentSessionRef): boolean;
  read(session: AgentSessionRef): Promise<TranscriptBackfill>;
}

export interface WorkerRuntimeAdapter {
  readonly runtime: string;
  readonly transcript?: TranscriptAdapter;
  normalizeTelemetry(input: unknown): WorkerTelemetryEvent;
}
