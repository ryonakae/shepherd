import { type AgentHistoryService, createAgentHistoryService } from "@/agent-history/service.js";
import type { AgentEventStore } from "@/db/agent-events.js";
import type { AgentHistoryCacheStore } from "@/db/agent-history-cache.js";
import type { AgentStore } from "@/db/agents.js";
import type { HerdrSessionStore } from "@/db/herdr-sessions.js";
import type { HerdrWorkspaceStore } from "@/db/herdr-workspaces.js";
import { normalizeHerdrSessionSnapshot } from "@/herdr/session-snapshot.js";
import { HerdrSocketClient } from "@/herdr/socket-client.js";
import {
  type AgentEventRecord,
  type AgentIndexRecord,
  type AgentStatus,
  type CompactAgentHistory,
  parseAgentStatus,
} from "@/observability/contracts.js";

export type AgentIndexServiceStores = {
  agentEvents: AgentEventStore;
  agentHistoryCache?: AgentHistoryCacheStore;
  agents: AgentStore;
  herdrSessions: HerdrSessionStore;
  herdrWorkspaces: HerdrWorkspaceStore;
};

export class AgentIndexService {
  readonly #clientFactory: (input: {
    socketPath: string;
  }) => Pick<HerdrSocketClient, "close" | "sessionSnapshot">;
  readonly #history: AgentHistoryService;
  readonly #stores: AgentIndexServiceStores;
  #observationSequence = 0;

  constructor(options: {
    clientFactory?: (input: {
      socketPath: string;
    }) => Pick<HerdrSocketClient, "close" | "sessionSnapshot">;
    history?: AgentHistoryService;
    stores: AgentIndexServiceStores;
  }) {
    this.#clientFactory = options.clientFactory ?? ((input) => new HerdrSocketClient(input));
    this.#history =
      options.history ??
      createAgentHistoryService({
        ...(options.stores.agentHistoryCache ? { cache: options.stores.agentHistoryCache } : {}),
      });
    this.#stores = options.stores;
  }

  async refreshHerdrSession(input: {
    herdrSessionName: string;
    onAgentEvent?(event: AgentEventRecord): void;
    sessionDir: string;
    socketPath: string;
  }): Promise<AgentIndexRecord[]> {
    const client = this.#clientFactory({ socketPath: input.socketPath });
    try {
      const previous = this.#stores.agents.listForHerdrSession(input.herdrSessionName);
      const previousByPane = new Map(previous.map((agent) => [agent.paneId, agent]));
      const previousByTerminal = new Map(
        previous.flatMap((agent) =>
          agent.terminalId ? ([[agent.terminalId, agent]] as const) : [],
        ),
      );
      const snapshot = normalizeHerdrSessionSnapshot(await client.sessionSnapshot());
      this.#stores.herdrSessions.upsertRunning({
        name: input.herdrSessionName,
        sessionDir: input.sessionDir,
        socketPath: input.socketPath,
      });
      this.#stores.herdrWorkspaces.replaceForSession({
        herdrSessionName: input.herdrSessionName,
        workspaces: snapshot.workspaces.map(record),
      });
      const agents = this.#stores.agents.replaceForSession({
        agents: snapshot.agents.map(record),
        herdrSessionName: input.herdrSessionName,
      });
      for (const agent of agents) {
        const compactHistory = await this.#compactHistory(agent);
        const prior =
          (agent.terminalId ? previousByTerminal.get(agent.terminalId) : undefined) ??
          previousByPane.get(agent.paneId);
        if (!prior || prior.agentStatus === agent.agentStatus) continue;
        const event = this.#appendStatusEvents({
          agent,
          compactHistory,
          evidence: { id: `snapshot:${agent.lastSeenAt.getTime()}` },
          from: prior.agentStatus,
          to: agent.agentStatus,
        });
        if (event) input.onAgentEvent?.(event);
      }
      return agents;
    } finally {
      client.close();
    }
  }

  async handleHerdrEvent(input: {
    event: unknown;
    herdrSessionName: string;
    refresh?: () => Promise<void>;
  }): Promise<AgentEventRecord | undefined> {
    const event = record(input.event);
    if (event.type !== "pane.agent_status_changed") return undefined;
    const paneId = stringValue(event.pane_id) ?? stringValue(event.paneId);
    if (!paneId) return undefined;
    let agent = this.#stores.agents.findByPane({
      herdrSessionName: input.herdrSessionName,
      paneId,
    });
    if (!agent && input.refresh) {
      await input.refresh();
      agent = this.#stores.agents.findByPane({ herdrSessionName: input.herdrSessionName, paneId });
    }
    if (!agent) return undefined;
    const from = agent.agentStatus;
    const to = parseAgentStatus(event.agent_status);
    const updated = this.#stores.agents.updateStatus({
      agentStatus: to,
      herdrSessionName: input.herdrSessionName,
      paneId,
    });
    const current = updated ?? { ...agent, agentStatus: to };
    const compactHistory = await this.#compactHistory(current);
    return this.#appendStatusEvents({
      agent: current,
      compactHistory,
      evidence: event,
      from,
      to,
    });
  }

  #appendStatusEvents(input: {
    agent: AgentIndexRecord;
    compactHistory: CompactAgentHistory;
    evidence: Record<string, unknown>;
    from: AgentStatus;
    to: AgentStatus;
  }): AgentEventRecord | undefined {
    if (input.from === input.to) return undefined;
    const observationId =
      eventIdentity(input.evidence) ??
      `observed:${input.agent.lastSeenAt.getTime()}:${this.#observationSequence++}`;
    let lastEvent = this.#stores.agentEvents.append({
      agentId: input.agent.id,
      compactHistory: input.compactHistory,
      herdrSessionName: input.agent.herdrSessionName,
      idempotencyKey: idempotencyKey(
        "agent.status.changed",
        input.agent,
        input.from,
        input.to,
        observationId,
      ),
      paneId: input.agent.paneId,
      payload: payload(input.agent, input.from, input.to),
      terminalId: input.agent.terminalId,
      type: "agent.status.changed",
      workspaceId: input.agent.workspaceId,
    });
    const statusType = statusEventType(input.to);
    if (statusType) {
      lastEvent = this.#stores.agentEvents.append({
        agentId: input.agent.id,
        compactHistory: input.compactHistory,
        herdrSessionName: input.agent.herdrSessionName,
        idempotencyKey: idempotencyKey(
          statusType,
          input.agent,
          input.from,
          input.to,
          observationId,
        ),
        paneId: input.agent.paneId,
        payload: payload(input.agent, input.from, input.to),
        terminalId: input.agent.terminalId,
        type: statusType,
        workspaceId: input.agent.workspaceId,
      });
    }
    return lastEvent;
  }

  async #compactHistory(agent: AgentIndexRecord) {
    return this.#history.getCompactHistory({
      agent: agent.agent,
      agentSession: agent.agentSession,
      cwd: agent.cwd,
      foregroundCwd: agent.foregroundCwd,
    });
  }
}

function statusEventType(
  status: AgentStatus,
): "agent.blocked" | "agent.done" | "agent.idle" | undefined {
  if (status === "blocked") return "agent.blocked";
  if (status === "done") return "agent.done";
  if (status === "idle") return "agent.idle";
  return undefined;
}

function payload(agent: AgentIndexRecord, from: AgentStatus, to: AgentStatus) {
  return {
    agent: agent.agent,
    from,
    herdrSessionName: agent.herdrSessionName,
    paneId: agent.paneId,
    terminalId: agent.terminalId,
    to,
    workspaceId: agent.workspaceId,
  };
}

function idempotencyKey(
  type: string,
  agent: AgentIndexRecord,
  from: AgentStatus,
  to: AgentStatus,
  observationId: string,
): string {
  return `${type}:${agent.herdrSessionName}:${agent.paneId}:${from}:${to}:${observationId}`;
}

function eventIdentity(event: Record<string, unknown>): string | null {
  for (const value of [event.seq, event.id, event.timestamp]) {
    if (typeof value === "string" && value.length > 0) return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
