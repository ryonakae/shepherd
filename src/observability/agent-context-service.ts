import { stat } from "node:fs/promises";
import { historySourceFromSessionRef } from "@/agent-history/discovery.js";
import type { AgentHistoryService } from "@/agent-history/service.js";
import { emptyCompactHistory } from "@/agent-history/service.js";
import type { AgentContextSnapshotStore } from "@/db/agent-context-snapshots.js";
import type { AgentStore } from "@/db/agents.js";
import type {
  AgentContextSnapshotRecord,
  AgentHistoryRef,
  AgentHistorySourceFingerprint,
  AgentIndexRecord,
  AgentListItem,
  AgentQueryScope,
  AgentScope,
  AgentWorkspaceContextSnapshot,
  CompactAgentHistory,
} from "./contracts.js";

export type RefreshAgentContextInput = {
  agent: AgentIndexRecord;
  identityChanged: boolean;
};

export type RefreshAgentContextResult = {
  changed: boolean;
  snapshot: AgentContextSnapshotRecord;
};

export class AgentContextService {
  readonly #history: AgentHistoryService;
  readonly #stores: {
    agentContextSnapshots: AgentContextSnapshotStore;
    agents: AgentStore;
  };

  constructor(options: {
    history: AgentHistoryService;
    stores: {
      agentContextSnapshots: AgentContextSnapshotStore;
      agents: AgentStore;
    };
  }) {
    this.#history = options.history;
    this.#stores = options.stores;
  }

  async refreshAgent(input: RefreshAgentContextInput): Promise<RefreshAgentContextResult> {
    const previous = this.#stores.agentContextSnapshots.get(input.agent.id);
    const directAuthoritativeRef = pathHistoryRefFromAgent(input.agent);
    const preferredRef =
      directAuthoritativeRef ??
      matchingAuthoritativeIdRef(input.agent, previous?.historyRef ?? null) ??
      (input.agent.agentSession ? null : (previous?.historyRef ?? null));
    const forceDiscovery = await shouldForceDiscovery({
      agent: input.agent,
      directAuthoritativeRef,
      identityChanged: input.identityChanged,
      preferredRef,
      previous,
    });
    const resolved = bindAuthoritativeId(
      input.agent,
      await this.#history.resolveCompactHistory(historyLookup(input.agent), {
        forceDiscovery,
        ...(preferredRef ? { preferredRef } : {}),
      }),
    );
    const next = {
      agentId: input.agent.id,
      compactHistory: resolved.compactHistory,
      historyRef: resolved.historyRef,
      paneRevision: input.agent.paneRevision,
      sourceFingerprint: resolved.sourceFingerprint,
    };
    if (previous && sameSnapshotPayload(previous, next)) {
      return { changed: false, snapshot: previous };
    }
    return { changed: true, snapshot: this.#stores.agentContextSnapshots.put(next) };
  }

  getAgentSnapshot(agentId: string): AgentContextSnapshotRecord | undefined {
    return this.#stores.agentContextSnapshots.get(agentId);
  }

  listAgents(scope: AgentQueryScope): AgentListItem[] {
    const agents = this.#stores.agents.list(scope);
    const snapshots = new Map(
      this.#stores.agentContextSnapshots
        .listByAgentIds(agents.map((agent) => agent.id))
        .map((snapshot) => [snapshot.agentId, snapshot]),
    );
    return agents.map((agent) => listItem(agent, snapshots.get(agent.id)?.compactHistory));
  }

  workspaceSnapshot(
    input: AgentScope & { excludeTerminalId: string },
  ): AgentWorkspaceContextSnapshot | null {
    const agents = this.#stores.agents
      .list({ herdrSessionName: input.herdrSessionName, workspaceId: input.workspaceId })
      .filter((agent) => agent.terminalId !== input.excludeTerminalId);
    const snapshots = this.#stores.agentContextSnapshots.listByAgentIds(
      agents.map((agent) => agent.id),
    );
    if (snapshots.length === 0) return null;
    const firstSnapshot = snapshots[0];
    if (!firstSnapshot) return null;
    const byAgentId = new Map(snapshots.map((snapshot) => [snapshot.agentId, snapshot]));
    const updatedAt = snapshots.reduce(
      (latest, snapshot) => (snapshot.updatedAt > latest ? snapshot.updatedAt : latest),
      firstSnapshot.updatedAt,
    );
    return {
      agents: agents.map((agent) => listItem(agent, byAgentId.get(agent.id)?.compactHistory)),
      herdrSessionName: input.herdrSessionName,
      updatedAt: updatedAt.toISOString(),
      workspaceId: input.workspaceId,
    };
  }
}

async function shouldForceDiscovery(input: {
  agent: AgentIndexRecord;
  directAuthoritativeRef: AgentHistoryRef | null;
  identityChanged: boolean;
  preferredRef: AgentHistoryRef | null;
  previous: AgentContextSnapshotRecord | undefined;
}): Promise<boolean> {
  if (input.directAuthoritativeRef) return false;
  if (input.agent.agentSession?.kind === "id") return input.preferredRef === null;
  if (input.identityChanged || !input.previous?.historyRef) return true;
  if (paneRevisionDecreased(input.agent.paneRevision, input.previous.paneRevision)) return true;
  if (!paneRevisionIncreased(input.agent.paneRevision, input.previous.paneRevision)) return false;
  const fingerprint = input.previous.sourceFingerprint;
  if (!fingerprint) return true;
  const current = await sourceFingerprint(fingerprint.path);
  return !current || sameFingerprint(fingerprint, current);
}

function pathHistoryRefFromAgent(agent: AgentIndexRecord): AgentHistoryRef | null {
  if (agent.agentSession?.kind !== "path") return null;
  return {
    kind: "agent_session",
    path: agent.agentSession.value,
    source: historySourceFromSessionRef(agent.agentSession),
    value: agent.agentSession.value,
  };
}

function matchingAuthoritativeIdRef(
  agent: AgentIndexRecord,
  previous: AgentHistoryRef | null,
): AgentHistoryRef | null {
  const session = agent.agentSession;
  if (
    session?.kind !== "id" ||
    previous?.kind !== "agent_session" ||
    !previous.path ||
    previous.source !== historySourceFromSessionRef(session) ||
    previous.value !== session.value
  ) {
    return null;
  }
  return previous;
}

function bindAuthoritativeId(
  agent: AgentIndexRecord,
  resolved: Awaited<ReturnType<AgentHistoryService["resolveCompactHistory"]>>,
): Awaited<ReturnType<AgentHistoryService["resolveCompactHistory"]>> {
  const session = agent.agentSession;
  if (session?.kind !== "id" || !resolved.historyRef?.path) return resolved;
  const historyRef: AgentHistoryRef = {
    kind: "agent_session",
    path: resolved.historyRef.path,
    source: historySourceFromSessionRef(session),
    value: session.value,
  };
  return {
    ...resolved,
    compactHistory: { ...resolved.compactHistory, historyRef },
    historyRef,
  };
}

function historyLookup(agent: AgentIndexRecord) {
  return {
    agent: agent.agent,
    agentSession: agent.agentSession,
    cwd: agent.cwd,
    foregroundCwd: agent.foregroundCwd,
  };
}

async function sourceFingerprint(path: string): Promise<AgentHistorySourceFingerprint | null> {
  const source = await stat(path).catch(() => null);
  return source ? { mtimeMs: Math.trunc(source.mtimeMs), path, size: source.size } : null;
}

function paneRevisionIncreased(current: number | null, previous: number | null): boolean {
  return current !== null && previous !== null && current > previous;
}

function paneRevisionDecreased(current: number | null, previous: number | null): boolean {
  return current !== null && previous !== null && current < previous;
}

function sameSnapshotPayload(
  previous: AgentContextSnapshotRecord,
  next: Omit<AgentContextSnapshotRecord, "updatedAt">,
): boolean {
  return (
    JSON.stringify(previous.compactHistory) === JSON.stringify(next.compactHistory) &&
    sameHistoryRef(previous.historyRef, next.historyRef) &&
    sameFingerprint(previous.sourceFingerprint, next.sourceFingerprint) &&
    previous.paneRevision === next.paneRevision
  );
}

function sameFingerprint(
  left: AgentHistorySourceFingerprint | null,
  right: AgentHistorySourceFingerprint | null,
): boolean {
  return (
    left?.path === right?.path && left?.mtimeMs === right?.mtimeMs && left?.size === right?.size
  );
}

function sameHistoryRef(left: AgentHistoryRef | null, right: AgentHistoryRef | null): boolean {
  return (
    left?.kind === right?.kind &&
    left?.path === right?.path &&
    left?.source === right?.source &&
    left?.value === right?.value
  );
}

function listItem(
  agent: AgentIndexRecord,
  compactHistory: CompactAgentHistory | undefined,
): AgentListItem {
  const compact = compactHistory ?? emptyCompactHistory();
  return {
    ...agent,
    history: {
      lastAssistantMessage: compact.lastAssistantMessage,
      lastUserMessage: compact.lastUserMessage,
      source: compact.source,
      updatedAt: compact.updatedAt,
    },
  };
}
