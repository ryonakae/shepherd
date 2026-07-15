export type AgentStatus = "blocked" | "done" | "idle" | "unknown" | "working";

export type HerdrSessionRecord = {
  lastScannedAt: Date | null;
  name: string;
  running: boolean;
  sessionDir: string;
  socketPath: string;
  updatedAt: Date;
};

export type HerdrWorkspaceRecord = {
  agentStatus: AgentStatus;
  focused: boolean;
  herdrSessionName: string;
  label: string | null;
  lastSeenAt: Date;
  workspaceId: string;
};

export type AgentSessionRef = {
  agent: string;
  kind: "id" | "path";
  source: string;
  value: string;
};

export type AgentIndexRecord = {
  agent: string | null;
  agentSession: AgentSessionRef | null;
  agentStatus: AgentStatus;
  cwd: string | null;
  firstSeenAt: Date;
  focused: boolean;
  foregroundCwd: string | null;
  herdrSessionName: string;
  id: string;
  lastSeenAt: Date;
  paneId: string;
  tabId: string | null;
  terminalId: string | null;
  workspaceId: string;
};

export type AgentHistoryRef = {
  kind: "agent_session" | "discovered_file";
  path?: string;
  source:
    | "claude-jsonl"
    | "codex-jsonl"
    | "gemini-json"
    | "opencode-sqlite"
    | "pi-jsonl"
    | "unknown";
  value: string;
};

export type AgentHistoryExcerpt = {
  ref: string;
  text: string;
  timestamp: string | null;
};

export type CompactToolResult = {
  compaction: {
    mode:
      | "failure_focus"
      | "grouped_matches"
      | "structured_summary"
      | "truncated_passthrough"
      | "web_sources"
      | "unknown";
    originalChars: number;
    returnedChars: number;
  };
  isError: boolean;
  ref: string;
  text: string;
  toolName: string;
};

export type CompactAgentHistory = {
  historyRef: AgentHistoryRef | null;
  lastAssistantMessage: AgentHistoryExcerpt | null;
  lastToolResult: CompactToolResult | null;
  lastUserMessage: AgentHistoryExcerpt | null;
  messageCount: number;
  source: string | null;
  updatedAt: string | null;
};

export type AgentHistoryMessage = {
  compact?: CompactToolResult;
  ref: string;
  role: "assistant" | "tool_result" | "user";
  text: string;
  timestamp: string | null;
  toolName?: string;
};

export type AgentListItem = AgentIndexRecord & {
  history: Pick<
    CompactAgentHistory,
    "lastAssistantMessage" | "lastUserMessage" | "source" | "updatedAt"
  >;
};

export type AgentGetResult = AgentIndexRecord & {
  history: CompactAgentHistory;
};

export type AgentReadResult = AgentIndexRecord & {
  historyRef: AgentHistoryRef | null;
  messages: AgentHistoryMessage[];
};

export type AgentEventType =
  | "agent.blocked"
  | "agent.done"
  | "agent.idle"
  | "agent.status.changed"
  | "agent.tool.failed";

export type AgentEventRecord = {
  agentId: string | null;
  compactHistory: CompactAgentHistory | null;
  createdAt: Date;
  herdrSessionName: string;
  id: number;
  paneId: string | null;
  payload: unknown;
  terminalId: string | null;
  type: AgentEventType;
  workspaceId: string | null;
};

export type AgentScope = {
  herdrSessionName: string;
  workspaceId: string;
};

export type AgentOrchestratorOwner = {
  paneId: string;
  terminalId: string;
};

export type AgentOrchestratorState = AgentScope & {
  ackedEventId: number;
  owner: AgentOrchestratorOwner | null;
  updatedAt: Date;
};

export type AgentOrchestratorWireState = AgentScope & {
  ackedEventId: number;
  owner: AgentOrchestratorOwner | null;
  updatedAt: string;
};

export type AgentOrchestratorChangeReason =
  | "claimed"
  | "disconnected"
  | "moved"
  | "released"
  | "startup_timeout";

export type AgentOrchestratorChanged = {
  current: AgentOrchestratorWireState;
  previous: AgentOrchestratorWireState;
  reason: AgentOrchestratorChangeReason;
};

export type PiPresenceRegistration = {
  herdrSocketPath: string;
  paneId: string;
  subscriberId: string;
  subscriberKind: "pi";
  workspaceId: string;
};

export type AgentTelemetryEvent =
  | {
      artifactRefs: string[];
      durationMs?: number;
      errorExcerpt?: string;
      inputPreview?: string;
      isError: boolean;
      occurredAt: string;
      outputExcerpt?: string;
      redactionApplied: boolean;
      runtime: string;
      sessionRef: AgentSessionRef | null;
      toolCallId: string;
      toolName: string;
      turnId: string;
      type: "agent.tool.completed";
    }
  | {
      blockedHint?: string;
      completionHint?: string;
      evidenceRefs: string[];
      needsInputHint?: string;
      occurredAt: string;
      redactionApplied: boolean;
      runtime: string;
      sessionRef: AgentSessionRef | null;
      stopReason: string;
      textExcerpt: string;
      turnId: string;
      type: "agent.message.final";
    };

export type AgentQueryScope = {
  all?: boolean;
  herdrSessionName?: string;
  workspaceId?: string;
};

export function parseAgentStatus(value: unknown): AgentStatus {
  return value === "blocked" ||
    value === "done" ||
    value === "idle" ||
    value === "unknown" ||
    value === "working"
    ? value
    : "unknown";
}
