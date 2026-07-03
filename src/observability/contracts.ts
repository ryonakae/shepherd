export type ObservedWorkspaceStatus = "active" | "ambiguous" | "missing";
export type WorkerStatus = "blocked" | "done" | "idle" | "unknown" | "working";
export type WorkerEventType =
  | "worker.blocked"
  | "worker.completed"
  | "worker.needs_input"
  | "worker.status.changed"
  | "worker.summary.updated"
  | "worker.tool.failed";

export type AgentSessionRef = {
  agent: string;
  kind: "id" | "path";
  source: string;
  value: string;
};

export type WorkerIdentity =
  | { key: string; kind: "agent_session"; session: AgentSessionRef }
  | {
      fallback: {
        herdrSessionName?: string;
        paneId: string;
        socketPath?: string;
        workspaceId: string;
      };
      key: string;
      kind: "live_pane";
    };

export type ObservedWorkspaceRecord = {
  createdAt: Date;
  herdrSessionName: string | null;
  id: string;
  lastResolvedAt: Date | null;
  liveWorkspaceId: string | null;
  metadata: ObservedWorkspaceMetadata;
  socketPath: string | null;
  status: ObservedWorkspaceStatus;
  updatedAt: Date;
};

export type ObservedWorkspaceMetadata = {
  label?: string;
  workspaceCwd?: string;
  worktree?: {
    checkoutPath: string;
    isLinkedWorktree: boolean;
    repoKey: string;
    repoName: string;
    repoRoot: string;
  };
};

export type WorkerEvidence = {
  excerpt?: string;
  ref?: string;
  source: "herdr" | "pi" | "transcript" | "rule";
  timestamp?: string;
};

export type WorkerSnapshot = {
  agent: string | null;
  blockedReason: string | null;
  completion: string | null;
  confidence: "high" | "low" | "medium";
  currentWork: string | null;
  evidence: WorkerEvidence[];
  id: string;
  lastActivityAt: string | null;
  lastMessageExcerpt: string | null;
  lastTool: WorkerToolSummary | null;
  needsInput: boolean;
  observedWorkspaceId: string;
  pane: { paneId: string; tabId: string | null; workspaceId: string | null } | null;
  recommendedAction: string | null;
  sessionRef: AgentSessionRef | null;
  status: WorkerStatus;
  summary: string | null;
};

export type WorkerToolSummary = {
  durationMs?: number;
  errorExcerpt?: string;
  inputPreview?: string;
  isError: boolean;
  name: string;
  outputExcerpt?: string;
  toolCallId: string;
};

export type WorkerTelemetryEvent =
  | WorkerToolTelemetryEvent
  | WorkerMessageFinalTelemetryEvent
  | WorkerLifecycleTelemetryEvent;

export type WorkerToolTelemetryEvent = {
  artifactRefs: string[];
  durationMs?: number;
  errorExcerpt?: string;
  inputPreview?: string;
  isError: boolean;
  occurredAt: string;
  outputExcerpt?: string;
  redactionApplied: boolean;
  runtime: "pi" | string;
  sessionRef: AgentSessionRef | null;
  toolCallId: string;
  toolName: string;
  turnId: string;
  type: "worker.tool.completed";
  workerKey: string | null;
};

export type WorkerMessageFinalTelemetryEvent = {
  blockedHint?: string;
  completionHint?: string;
  evidenceRefs: string[];
  needsInputHint?: string;
  occurredAt: string;
  redactionApplied: boolean;
  runtime: "pi" | string;
  sessionRef: AgentSessionRef | null;
  stopReason: "aborted" | "error" | "length" | "stop" | "toolUse" | string;
  textExcerpt: string;
  turnId: string;
  type: "worker.message.final";
  workerKey: string | null;
};

export type WorkerLifecycleTelemetryEvent = {
  occurredAt: string;
  runtime: "pi" | string;
  sessionRef: AgentSessionRef | null;
  status: WorkerStatus;
  type: "worker.lifecycle";
  workerKey: string | null;
};

export type WorkerEventWireRecord = {
  createdAt: string;
  id: number;
  observedWorkspaceId: string;
  payload: unknown;
  type: WorkerEventType;
  workerId: string | null;
};

export type HerdrControlClientWithSnapshot = {
  agentRead(params: {
    lines?: number;
    source?: "detection" | "recent" | "recent-unwrapped" | "visible";
    target: string;
  }): Promise<unknown>;
  agentSend(params: { target: string; text: string }): Promise<unknown>;
  agentStart(params: {
    argv: string[];
    cwd?: string;
    env?: Record<string, string>;
    name: string;
    tab_id?: string;
    workspace_id?: string;
  }): Promise<unknown>;
  close(): void;
  listAgents(): Promise<unknown>;
  sessionSnapshot(): Promise<unknown>;
  subscribeEvents(
    params: { paneIds: string[]; workspaceId: string },
    options?: { signal?: AbortSignal },
  ): AsyncIterable<unknown>;
};

export type WorkerIdentityInput =
  | { kind: "agent_session"; session: AgentSessionRef }
  | {
      fallback: {
        herdrSessionName?: string;
        paneId: string;
        socketPath?: string;
        workspaceId: string;
      };
      kind: "live_pane";
    };

export function workerIdentityKey(input: WorkerIdentityInput): string {
  if (input.kind === "agent_session") {
    const session = input.session;
    return `session:${session.source}:${session.agent}:${session.kind}:${session.value}`;
  }

  const scope = input.fallback.herdrSessionName ?? input.fallback.socketPath ?? "unknown-herdr";
  return `pane:${scope}:${input.fallback.workspaceId}:${input.fallback.paneId}`;
}
