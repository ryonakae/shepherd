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
    sessionDir: string;
    socketPath: string;
  }): Promise<void> {
    const client = this.#clientFactory({ socketPath: input.socketPath });
    try {
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
        await this.#compactHistory(agent);
      }
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
    let lastEvent: AgentEventRecord | undefined;
    if (from !== to) {
      lastEvent = this.#stores.agentEvents.append({
        agentId: current.id,
        compactHistory,
        herdrSessionName: input.herdrSessionName,
        idempotencyKey: idempotencyKey("agent.status.changed", current, from, to, event),
        paneId,
        payload: payload(current, from, to),
        type: "agent.status.changed",
        workspaceId: current.workspaceId,
      });
    }
    const statusType = statusEventType(to);
    if (statusType) {
      lastEvent = this.#stores.agentEvents.append({
        agentId: current.id,
        compactHistory,
        herdrSessionName: input.herdrSessionName,
        idempotencyKey: idempotencyKey(statusType, current, from, to, event),
        paneId,
        payload: payload(current, from, to),
        type: statusType,
        workspaceId: current.workspaceId,
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
  event: Record<string, unknown>,
): string {
  const seq =
    stringValue(event.seq) ??
    stringValue(event.id) ??
    stringValue(event.timestamp) ??
    `${from}:${to}`;
  return `${type}:${agent.herdrSessionName}:${agent.paneId}:${from}:${to}:${seq}`;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
