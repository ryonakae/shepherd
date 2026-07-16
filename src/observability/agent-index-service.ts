import { type AgentHistoryService, createAgentHistoryService } from "@/agent-history/service.js";
import type { AgentEventStore } from "@/db/agent-events.js";
import type { AgentHistoryCacheStore } from "@/db/agent-history-cache.js";
import type { AgentStore, HerdrAgentLike } from "@/db/agents.js";
import type { HerdrSessionStore } from "@/db/herdr-sessions.js";
import type { HerdrWorkspaceStore } from "@/db/herdr-workspaces.js";
import { normalizeHerdrSessionSnapshot } from "@/herdr/session-snapshot.js";
import { HerdrSocketClient } from "@/herdr/socket-client.js";
import { AgentContextService } from "@/observability/agent-context-service.js";
import {
  type AgentEventRecord,
  type AgentIndexRecord,
  type AgentScope,
  type AgentSessionRef,
  type AgentStatus,
  parseAgentStatus,
} from "@/observability/contracts.js";

export type AgentIndexRefreshResult = {
  agents: AgentIndexRecord[];
  contextChangedScopes: AgentScope[];
  events: AgentEventRecord[];
};

export type AgentEventHandlingResult = {
  contextChangedScopes: AgentScope[];
  events: AgentEventRecord[];
};

export type PiSessionRefRegistrationResult = {
  agent: AgentIndexRecord | undefined;
  contextChangedScopes: AgentScope[];
};

export type AgentIndexServiceStores = {
  agentContextSnapshots?: ConstructorParameters<
    typeof AgentContextService
  >[0]["stores"]["agentContextSnapshots"];
  agentEvents: AgentEventStore;
  agentHistoryCache?: AgentHistoryCacheStore;
  agents: AgentStore;
  herdrSessions: HerdrSessionStore;
  herdrWorkspaces: HerdrWorkspaceStore;
};

type RefreshInput = {
  herdrSessionName: string;
  sessionDir: string;
  socketPath: string;
};

export class AgentIndexService {
  readonly #clientFactory: (input: {
    socketPath: string;
  }) => Pick<HerdrSocketClient, "close" | "sessionSnapshot">;
  readonly #context: AgentContextService;
  readonly #stores: AgentIndexServiceStores;
  readonly #mutationEpochBySession = new Map<string, number>();
  readonly #pendingPiSessionRefs = new Map<string, AgentSessionRef>();
  readonly #refreshInFlightBySession = new Map<
    string,
    { epoch: number; promise: Promise<AgentIndexRefreshResult> }
  >();
  readonly #sessionOperationTail = new Map<string, Promise<void>>();
  #observationSequence = 0;

  constructor(options: {
    clientFactory?: (input: {
      socketPath: string;
    }) => Pick<HerdrSocketClient, "close" | "sessionSnapshot">;
    context?: AgentContextService;
    history?: AgentHistoryService;
    stores: AgentIndexServiceStores;
  }) {
    this.#clientFactory = options.clientFactory ?? ((input) => new HerdrSocketClient(input));
    this.#stores = options.stores;
    if (options.context) {
      this.#context = options.context;
    } else {
      if (!options.stores.agentContextSnapshots) {
        throw new Error("AgentIndexService requires context or agentContextSnapshots store");
      }
      const history =
        options.history ??
        createAgentHistoryService({
          ...(options.stores.agentHistoryCache ? { cache: options.stores.agentHistoryCache } : {}),
        });
      this.#context = new AgentContextService({
        history,
        stores: {
          agentContextSnapshots: options.stores.agentContextSnapshots,
          agents: options.stores.agents,
        },
      });
    }
  }

  refreshHerdrSession(input: RefreshInput): Promise<AgentIndexRefreshResult> {
    const epoch = this.#mutationEpochBySession.get(input.herdrSessionName) ?? 0;
    const existing = this.#refreshInFlightBySession.get(input.herdrSessionName);
    if (existing?.epoch === epoch) return existing.promise;
    const promise = this.#enqueueSessionOperation(input.herdrSessionName, () =>
      this.#refreshHerdrSessionNow(input),
    );
    this.#refreshInFlightBySession.set(input.herdrSessionName, { epoch, promise });
    const clear = () => {
      if (this.#refreshInFlightBySession.get(input.herdrSessionName)?.promise === promise) {
        this.#refreshInFlightBySession.delete(input.herdrSessionName);
      }
    };
    void promise.then(clear, clear);
    return promise;
  }

  handleHerdrEvent(input: {
    event: unknown;
    herdrSessionName: string;
    sessionDir: string;
    socketPath: string;
  }): Promise<AgentEventHandlingResult> {
    this.#incrementMutationEpoch(input.herdrSessionName);
    return this.#enqueueSessionOperation(input.herdrSessionName, () =>
      this.#handleHerdrEventNow(input),
    );
  }

  registerPiSessionRef(input: {
    herdrSessionName: string;
    sessionRef: AgentSessionRef;
    terminalId: string;
  }): Promise<PiSessionRefRegistrationResult> {
    this.#incrementMutationEpoch(input.herdrSessionName);
    return this.#enqueueSessionOperation(input.herdrSessionName, () =>
      this.#registerPiSessionRefNow(input),
    );
  }

  async #refreshHerdrSessionNow(input: RefreshInput): Promise<AgentIndexRefreshResult> {
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
      const revisionByPane = new Map(
        snapshot.panes.flatMap((pane) => {
          const value = record(pane);
          const paneId = stringValue(value.pane_id) ?? stringValue(value.paneId);
          const revision = integerValue(value.revision);
          return paneId && revision !== undefined ? ([[paneId, revision]] as const) : [];
        }),
      );
      const snapshotAgents = snapshot.agents.map((agent) =>
        withPaneRevision(agent, revisionByPane),
      );
      this.#stores.herdrSessions.upsertRunning({
        name: input.herdrSessionName,
        sessionDir: input.sessionDir,
        socketPath: input.socketPath,
      });
      this.#stores.herdrWorkspaces.replaceForSession({
        herdrSessionName: input.herdrSessionName,
        workspaces: snapshot.workspaces.map(record),
      });
      const indexedAgents = this.#stores.agents.replaceForSession({
        agents: snapshotAgents,
        herdrSessionName: input.herdrSessionName,
      });
      const agents = indexedAgents.map((agent) => {
        if (!agent.terminalId) return agent;
        const key = terminalSessionKey(input.herdrSessionName, agent.terminalId);
        const pending = this.#pendingPiSessionRefs.get(key);
        if (!pending) return agent;
        this.#pendingPiSessionRefs.delete(key);
        return (
          this.#stores.agents.setSessionRefByTerminal({
            agentSession: pending,
            herdrSessionName: input.herdrSessionName,
            terminalId: agent.terminalId,
          }) ?? agent
        );
      });
      const scopes = new Map<string, AgentScope>();
      const events: AgentEventRecord[] = [];
      const currentIds = new Set(agents.map((agent) => agent.id));
      for (const prior of previous) {
        if (!currentIds.has(prior.id)) addScope(scopes, scopeOf(prior));
      }
      for (const agent of agents) {
        const prior = matchingPrior(agent, previousByTerminal, previousByPane);
        const identityChanged = !prior || !sameIdentity(prior, agent);
        const metadataChanged = !prior || !sameContextMetadata(prior, agent);
        const cached = this.#context.getAgentSnapshot(agent.id);
        const dirty =
          !cached ||
          agent.paneRevision === null ||
          cached.paneRevision !== agent.paneRevision ||
          identityChanged;
        let refreshed = cached;
        if (dirty) {
          const result = await this.#context.refreshAgent({ agent, identityChanged });
          refreshed = result.snapshot;
          if (result.changed) addScope(scopes, scopeOf(agent));
        }
        if (metadataChanged) {
          if (prior && !sameScope(scopeOf(prior), scopeOf(agent))) addScope(scopes, scopeOf(prior));
          addScope(scopes, scopeOf(agent));
        }
        if (prior && prior.agentStatus !== agent.agentStatus) {
          const event = this.#appendStatusEvents({
            agent,
            compactHistory:
              refreshed?.compactHistory ?? this.#context.getAgentSnapshot(agent.id)?.compactHistory,
            evidence: { id: `snapshot:${agent.lastSeenAt.getTime()}` },
            from: prior.agentStatus,
            to: agent.agentStatus,
          });
          if (event) events.push(event);
          addScope(scopes, scopeOf(agent));
        }
      }
      return {
        agents,
        contextChangedScopes: sortedScopes(scopes),
        events,
      };
    } finally {
      client.close();
    }
  }

  async #handleHerdrEventNow(input: {
    event: unknown;
    herdrSessionName: string;
    sessionDir: string;
    socketPath: string;
  }): Promise<AgentEventHandlingResult> {
    const event = record(input.event);
    if (event.type !== "pane.agent_status_changed") return { contextChangedScopes: [], events: [] };
    const paneId = stringValue(event.pane_id) ?? stringValue(event.paneId);
    if (!paneId) return { contextChangedScopes: [], events: [] };
    let agent = this.#stores.agents.findByPane({
      herdrSessionName: input.herdrSessionName,
      paneId,
    });
    let recovered: AgentIndexRefreshResult | undefined;
    if (!agent) {
      recovered = await this.#refreshHerdrSessionNow(input);
      agent = this.#stores.agents.findByPane({ herdrSessionName: input.herdrSessionName, paneId });
    }
    if (!agent) {
      return recovered
        ? { contextChangedScopes: recovered.contextChangedScopes, events: recovered.events }
        : { contextChangedScopes: [], events: [] };
    }
    const from = recovered ? "unknown" : agent.agentStatus;
    const to = parseAgentStatus(event.agent_status);
    const updated = this.#stores.agents.updateStatus({
      agentStatus: to,
      herdrSessionName: input.herdrSessionName,
      paneId,
    });
    const current = updated ?? { ...agent, agentStatus: to };
    const refreshed = await this.#context.refreshAgent({ agent: current, identityChanged: false });
    const scopes = new Map<string, AgentScope>();
    for (const scope of recovered?.contextChangedScopes ?? []) addScope(scopes, scope);
    if (refreshed.changed || from !== to) addScope(scopes, scopeOf(current));
    const events = [...(recovered?.events ?? [])];
    const equivalent = events.some(
      (candidate) =>
        candidate.agentId === current.id &&
        candidate.type === statusEventType(to) &&
        (candidate.payload as { to?: AgentStatus }).to === to,
    );
    if (!equivalent) {
      const statusEvent = this.#appendStatusEvents({
        agent: current,
        compactHistory: refreshed.snapshot.compactHistory,
        evidence: event,
        from,
        to,
      });
      if (statusEvent) events.push(statusEvent);
    }
    return { contextChangedScopes: sortedScopes(scopes), events };
  }

  async #registerPiSessionRefNow(input: {
    herdrSessionName: string;
    sessionRef: AgentSessionRef;
    terminalId: string;
  }): Promise<PiSessionRefRegistrationResult> {
    const key = terminalSessionKey(input.herdrSessionName, input.terminalId);
    const previous = this.#stores.agents.findByTerminal(input);
    if (!previous) {
      this.#pendingPiSessionRefs.set(key, input.sessionRef);
      return { agent: undefined, contextChangedScopes: [] };
    }
    const agent = this.#stores.agents.setSessionRefByTerminal({
      agentSession: input.sessionRef,
      herdrSessionName: input.herdrSessionName,
      terminalId: input.terminalId,
    });
    this.#pendingPiSessionRefs.delete(key);
    if (!agent || sameAgentSession(previous.agentSession, agent.agentSession)) {
      return { agent, contextChangedScopes: [] };
    }
    const refreshed = await this.#context.refreshAgent({ agent, identityChanged: true });
    return {
      agent,
      contextChangedScopes: refreshed.changed ? [scopeOf(agent)] : [],
    };
  }

  #incrementMutationEpoch(sessionName: string): void {
    this.#mutationEpochBySession.set(
      sessionName,
      (this.#mutationEpochBySession.get(sessionName) ?? 0) + 1,
    );
  }

  #enqueueSessionOperation<T>(sessionName: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.#sessionOperationTail.get(sessionName) ?? Promise.resolve();
    const result = prior.catch(() => undefined).then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.#sessionOperationTail.set(sessionName, tail);
    void tail.finally(() => {
      if (this.#sessionOperationTail.get(sessionName) === tail) {
        this.#sessionOperationTail.delete(sessionName);
      }
    });
    return result;
  }

  #appendStatusEvents(input: {
    agent: AgentIndexRecord;
    compactHistory:
      | NonNullable<ReturnType<AgentContextService["getAgentSnapshot"]>>["compactHistory"]
      | undefined;
    evidence: Record<string, unknown>;
    from: AgentStatus;
    to: AgentStatus;
  }): AgentEventRecord | undefined {
    if (input.from === input.to || !input.compactHistory) return undefined;
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
}

function withPaneRevision(agent: unknown, revisionByPane: Map<string, number>): HerdrAgentLike {
  const raw = record(agent);
  if (integerValue(raw.revision) !== undefined) return raw;
  const paneId = stringValue(raw.pane_id) ?? stringValue(raw.paneId);
  const revision = paneId ? revisionByPane.get(paneId) : undefined;
  return revision === undefined ? raw : { ...raw, revision };
}

function matchingPrior(
  agent: AgentIndexRecord,
  previousByTerminal: Map<string, AgentIndexRecord>,
  previousByPane: Map<string, AgentIndexRecord>,
): AgentIndexRecord | undefined {
  const terminalMatch = agent.terminalId ? previousByTerminal.get(agent.terminalId) : undefined;
  const paneMatch = previousByPane.get(agent.paneId);
  const canUsePaneFallback = paneMatch && (!agent.terminalId || !paneMatch.terminalId);
  return terminalMatch ?? (canUsePaneFallback ? paneMatch : undefined);
}

function sameIdentity(left: AgentIndexRecord, right: AgentIndexRecord): boolean {
  return (
    left.agent === right.agent &&
    left.terminalId === right.terminalId &&
    left.cwd === right.cwd &&
    left.foregroundCwd === right.foregroundCwd &&
    sameAgentSession(left.agentSession, right.agentSession)
  );
}

function sameContextMetadata(left: AgentIndexRecord, right: AgentIndexRecord): boolean {
  return (
    sameIdentity(left, right) &&
    left.agentStatus === right.agentStatus &&
    left.paneId === right.paneId &&
    left.tabId === right.tabId &&
    left.workspaceId === right.workspaceId
  );
}

function sameAgentSession(left: AgentSessionRef | null, right: AgentSessionRef | null): boolean {
  return (
    left?.agent === right?.agent &&
    left?.kind === right?.kind &&
    left?.source === right?.source &&
    left?.value === right?.value
  );
}

function terminalSessionKey(herdrSessionName: string, terminalId: string): string {
  return `${herdrSessionName}\0${terminalId}`;
}

function scopeOf(agent: AgentIndexRecord): AgentScope {
  return { herdrSessionName: agent.herdrSessionName, workspaceId: agent.workspaceId };
}

function addScope(scopes: Map<string, AgentScope>, scope: AgentScope): void {
  scopes.set(`${scope.herdrSessionName}\0${scope.workspaceId}`, scope);
}

function sameScope(left: AgentScope, right: AgentScope): boolean {
  return left.herdrSessionName === right.herdrSessionName && left.workspaceId === right.workspaceId;
}

function sortedScopes(scopes: Map<string, AgentScope>): AgentScope[] {
  return [...scopes.values()].sort(
    (left, right) =>
      left.herdrSessionName.localeCompare(right.herdrSessionName) ||
      left.workspaceId.localeCompare(right.workspaceId),
  );
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

function integerValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}
