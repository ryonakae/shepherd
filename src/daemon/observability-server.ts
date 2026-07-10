import { existsSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { Value } from "@sinclair/typebox/value";
import type { AgentHistoryService } from "@/agent-history/service.js";
import type { AgentEventStore } from "@/db/agent-events.js";
import type { AgentStore } from "@/db/agents.js";
import type { HerdrSessionStore } from "@/db/herdr-sessions.js";
import type { HerdrWorkspaceStore } from "@/db/herdr-workspaces.js";
import {
  type HerdrPaneIdentity,
  resolveHerdrPaneIdentity,
} from "@/herdr/pane-identity-resolver.js";
import type { AgentOrchestratorService } from "@/observability/agent-orchestrator-service.js";
import type {
  AgentEventRecord,
  AgentIndexRecord,
  AgentOrchestratorChanged,
  AgentOrchestratorState,
  AgentOrchestratorWireState,
  AgentQueryScope,
  AgentScope,
  PiPresenceRegistration,
} from "@/observability/contracts.js";
import {
  agentEventsInputSchema,
  agentGetInputSchema,
  agentListInputSchema,
  agentOrchestratorAckInputSchema,
  agentOrchestratorGetInputSchema,
  agentOrchestratorRegisterInputSchema,
  agentOrchestratorSetInputSchema,
  agentReadInputSchema,
  agentTelemetryInputSchema,
} from "@/observability/schemas.js";
import { encodeJsonLine, JsonLineDecoder } from "@/shared/json-lines.js";

export const DISCONNECT_GRACE_MS = 5_000;
export const STARTUP_RECONNECT_GRACE_MS = 10_000;

type RpcRequest = { id?: number | string; method?: string; params?: unknown };

type AgentStores = {
  agentEvents: AgentEventStore;
  agents: AgentStore;
  herdrSessions: HerdrSessionStore;
  herdrWorkspaces: HerdrWorkspaceStore;
};

export type PiPresence = AgentScope & {
  autoResume: boolean;
  connectedAt: number;
  paneId: string;
  subscriberId: string;
  terminalId: string;
};

type AgentOrchestratorConnectionStateResult = {
  events: AgentEventRecord[];
  presence: PiPresence;
  state: AgentOrchestratorWireState | null;
};

type TimerHandle = ReturnType<typeof setTimeout>;

type GraceTimer = {
  handle: TimerHandle;
};

export class ObservabilityRpcServer {
  readonly #clearTimeout: (handle: TimerHandle) => void;
  readonly #connectionOrderBySocket = new Map<Socket, number>();
  readonly #disconnectGraceMs: number;
  readonly #disconnectTimers = new Map<string, GraceTimer>();
  readonly #history: AgentHistoryService;
  readonly #now: () => number;
  readonly #orchestrator: AgentOrchestratorService;
  readonly #piPresenceBySocket = new Map<Socket, PiPresence>();
  readonly #resolvePaneIdentity: (input: {
    paneId: string;
    socketPath: string;
  }) => Promise<HerdrPaneIdentity>;
  readonly #server: Server;
  readonly #setTimeout: (callback: () => void, delay: number) => TimerHandle;
  readonly #socketPath: string;
  readonly #sockets = new Set<Socket>();
  readonly #startupReconnectGraceMs: number;
  readonly #startupTimers = new Map<string, GraceTimer>();
  readonly #stores: AgentStores;
  #connectionSequence = 0;
  #stopping = false;

  constructor(options: {
    clearTimeout?: (handle: TimerHandle) => void;
    disconnectGraceMs?: number;
    history: AgentHistoryService;
    now?: () => number;
    orchestrator: AgentOrchestratorService;
    resolvePaneIdentity?: (input: {
      paneId: string;
      socketPath: string;
    }) => Promise<HerdrPaneIdentity>;
    setTimeout?: (callback: () => void, delay: number) => TimerHandle;
    socketPath: string;
    startupReconnectGraceMs?: number;
    stores: AgentStores;
  }) {
    this.#clearTimeout = options.clearTimeout ?? clearTimeout;
    this.#disconnectGraceMs = options.disconnectGraceMs ?? DISCONNECT_GRACE_MS;
    this.#history = options.history;
    this.#now = options.now ?? Date.now;
    this.#orchestrator = options.orchestrator;
    this.#resolvePaneIdentity = options.resolvePaneIdentity ?? resolveHerdrPaneIdentity;
    this.#setTimeout = options.setTimeout ?? setTimeout;
    this.#socketPath = options.socketPath;
    this.#startupReconnectGraceMs = options.startupReconnectGraceMs ?? STARTUP_RECONNECT_GRACE_MS;
    this.#stores = options.stores;
    this.#server = createServer((socket) => this.#handleConnection(socket));
  }

  async start(): Promise<void> {
    this.#stopping = false;
    if (existsSync(this.#socketPath)) unlinkSync(this.#socketPath);
    await new Promise<void>((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(this.#socketPath, () => {
        this.#server.off("error", reject);
        resolve();
      });
    });
    this.#armStartupGrace();
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    this.#clearGraceTimers(this.#disconnectTimers);
    this.#clearGraceTimers(this.#startupTimers);
    for (const socket of this.#sockets) socket.destroy();
    this.#sockets.clear();
    this.#piPresenceBySocket.clear();
    this.#connectionOrderBySocket.clear();
    await new Promise<void>((resolve, reject) => {
      if (!this.#server.listening) {
        resolve();
        return;
      }
      this.#server.close((error) => (error ? reject(error) : resolve()));
    });
    if (existsSync(this.#socketPath)) unlinkSync(this.#socketPath);
  }

  publishAgentEvent(event: AgentEventRecord): void {
    if (!event.workspaceId || !event.terminalId) return;
    const scope = { herdrSessionName: event.herdrSessionName, workspaceId: event.workspaceId };
    const owner = this.#orchestrator.status(scope)?.owner;
    if (!owner || event.terminalId === owner.terminalId) return;
    const socket = this.#newestSocketForTerminal({ ...scope, terminalId: owner.terminalId });
    if (socket) this.#write(socket, { method: "agent.event", params: { event } });
  }

  reconcileAgentLocations(input: { agents: AgentIndexRecord[]; herdrSessionName: string }): void {
    const byTerminal = new Map(
      input.agents.flatMap((agent) =>
        agent.terminalId ? ([[agent.terminalId, agent]] as const) : [],
      ),
    );
    const owners = this.#orchestrator
      .persistedOwners()
      .filter((state) => state.herdrSessionName === input.herdrSessionName);

    for (const [socket, presence] of this.#piPresenceBySocket) {
      if (presence.herdrSessionName !== input.herdrSessionName) continue;
      const agent = byTerminal.get(presence.terminalId);
      if (!agent) continue;
      this.#piPresenceBySocket.set(socket, {
        ...presence,
        paneId: agent.paneId,
        workspaceId: agent.workspaceId,
      });
    }

    for (const ownerState of owners) {
      const owner = ownerState.owner;
      if (!owner) continue;
      const current = this.#orchestrator.status(ownerState);
      if (current?.owner?.terminalId !== owner.terminalId) continue;
      const agent = byTerminal.get(owner.terminalId);
      if (!agent) continue;
      if (agent.workspaceId === ownerState.workspaceId) {
        if (agent.paneId === owner.paneId) continue;
        const change = this.#orchestrator.claim({
          ...ownerState,
          paneId: agent.paneId,
          terminalId: owner.terminalId,
        });
        this.#publishOrchestratorChange(toWireChange({ ...change, reason: "moved" }));
        continue;
      }
      const changes = this.#orchestrator.move({
        from: ownerState,
        paneId: agent.paneId,
        terminalId: owner.terminalId,
        to: {
          herdrSessionName: input.herdrSessionName,
          workspaceId: agent.workspaceId,
        },
      });
      for (const change of changes) {
        this.#publishOrchestratorChange(toWireChange(change));
      }
    }
  }

  #handleConnection(socket: Socket): void {
    this.#sockets.add(socket);
    this.#connectionSequence += 1;
    this.#connectionOrderBySocket.set(socket, this.#connectionSequence);
    const decoder = new JsonLineDecoder();
    socket.on("data", (chunk) => {
      for (const message of decoder.push(chunk.toString("utf8"))) {
        void this.#handleRequest(socket, message as RpcRequest);
      }
    });
    socket.on("close", () => this.#handleSocketClose(socket));
    socket.on("error", () => undefined);
  }

  async #handleRequest(socket: Socket, request: RpcRequest): Promise<void> {
    try {
      if (!request.method) throw new Error("Missing method");
      const result = await this.#dispatch(socket, request.method, request.params ?? {});
      this.#write(socket, { id: request.id, result });
    } catch (error) {
      this.#write(socket, {
        error: { message: error instanceof Error ? error.message : String(error) },
        id: request.id,
      });
    }
  }

  async #dispatch(socket: Socket, method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "agent.list": {
        assertSchema(agentListInputSchema, params);
        const scope = this.#resolveScope(params as AgentQueryScope);
        const agents = this.#stores.agents.list(scope);
        return {
          agents: await Promise.all(
            agents.map(async (agent) => {
              const history = await this.#history.getCompactHistory(historyInput(agent));
              return {
                ...agent,
                history: {
                  lastAssistantMessage: history.lastAssistantMessage,
                  lastUserMessage: history.lastUserMessage,
                  source: history.source,
                  updatedAt: history.updatedAt,
                },
              };
            }),
          ),
        };
      }
      case "agent.get": {
        assertSchema(agentGetInputSchema, params);
        const input = params as AgentQueryScope & { target: string };
        const scope = this.#resolveScope(input);
        const agent = this.#stores.agents.resolveTarget(scope, input.target);
        return {
          agent: { ...agent, history: await this.#history.getCompactHistory(historyInput(agent)) },
        };
      }
      case "agent.read": {
        assertSchema(agentReadInputSchema, params);
        const input = params as AgentQueryScope & { limit?: number; target: string };
        const scope = this.#resolveScope(input);
        const agent = this.#stores.agents.resolveTarget(scope, input.target);
        const read = await this.#history.read(historyInput(agent), { limit: input.limit ?? 20 });
        return { agent: { ...agent, historyRef: read.historyRef, messages: read.messages } };
      }
      case "agent.events": {
        assertSchema(agentEventsInputSchema, params);
        const input = params as AgentQueryScope & { afterEventId?: number; limit?: number };
        return { events: this.#stores.agentEvents.listAfter(input) };
      }
      case "agent.orchestrator.register": {
        assertSchema(agentOrchestratorRegisterInputSchema, params);
        const previous = this.#piPresenceBySocket.get(socket);
        const presence = await this.#resolvePiPresence(params as PiPresenceRegistration);
        this.#piPresenceBySocket.set(socket, presence);
        this.#cancelGraceForTerminal(presence);
        if (previous && terminalPresenceKey(previous) !== terminalPresenceKey(presence)) {
          this.#scheduleDisconnect(previous);
        }
        return this.#connectionState(presence);
      }
      case "agent.orchestrator.get": {
        assertSchema(agentOrchestratorGetInputSchema, params);
        return this.#connectionState(this.#requirePiPresence(socket));
      }
      case "agent.orchestrator.set": {
        assertSchema(agentOrchestratorSetInputSchema, params);
        const presence = this.#requirePiPresence(socket);
        const enabled = (params as { enabled: boolean }).enabled;
        let changed = false;
        if (enabled) {
          const change = this.#orchestrator.claim(presence);
          changed = !sameOwner(change.current.owner, change.previous.owner);
          if (changed) this.#publishOrchestratorChange(toWireChange(change));
        } else {
          const change = this.#orchestrator.release({
            ...presence,
            reason: "released",
          });
          changed = change !== undefined;
          if (change) this.#publishOrchestratorChange(toWireChange(change));
        }
        return { ...this.#connectionState(presence), changed };
      }
      case "agent.notifications.ack": {
        assertSchema(agentOrchestratorAckInputSchema, params);
        const presence = this.#requirePiPresence(socket);
        const state = this.#orchestrator.ack({
          ...presence,
          eventId: (params as { eventId: number }).eventId,
        });
        return { acknowledged: true, state: toWireState(state) };
      }
      case "agent.telemetry": {
        assertSchema(agentTelemetryInputSchema, params);
        return { accepted: true };
      }
      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }

  async #resolvePiPresence(input: PiPresenceRegistration): Promise<PiPresence> {
    const session = this.#stores.herdrSessions.findRunningBySocketPath(input.herdrSocketPath);
    if (!session) throw new Error("Herdr socket is not registered as a running session");
    const indexed = this.#stores.agents.findByPane({
      herdrSessionName: session.name,
      paneId: input.paneId,
    });
    if (indexed?.workspaceId === input.workspaceId && indexed.terminalId) {
      return {
        autoResume: input.autoResume ?? false,
        connectedAt: this.#now(),
        herdrSessionName: session.name,
        paneId: indexed.paneId,
        subscriberId: input.subscriberId,
        terminalId: indexed.terminalId,
        workspaceId: indexed.workspaceId,
      };
    }

    try {
      const live = await this.#resolvePaneIdentity({
        paneId: input.paneId,
        socketPath: session.socketPath,
      });
      return {
        autoResume: input.autoResume ?? false,
        connectedAt: this.#now(),
        herdrSessionName: session.name,
        paneId: live.paneId,
        subscriberId: input.subscriberId,
        terminalId: live.terminalId,
        workspaceId: live.workspaceId,
      };
    } catch {
      if (!indexed) throw new Error("Herdr pane is not indexed yet");
      if (indexed.workspaceId !== input.workspaceId) {
        throw new Error("Pi presence workspace does not match indexed Herdr pane");
      }
      throw new Error("Herdr pane has no terminal identity");
    }
  }

  #connectionState(presence: PiPresence): AgentOrchestratorConnectionStateResult {
    const state = this.#orchestrator.status(presence);
    return {
      events: this.#orchestrator.pending({ ...presence, limit: 100 }),
      presence,
      state: state ? toWireState(state) : null,
    };
  }

  #requirePiPresence(socket: Socket): PiPresence {
    const presence = this.#piPresenceBySocket.get(socket);
    if (!presence) throw new Error("Pi presence is not registered for this connection");
    return presence;
  }

  #publishOrchestratorChange(change: AgentOrchestratorChanged): void {
    for (const [socket, presence] of this.#piPresenceBySocket) {
      if (sameScope(presence, change.previous) || sameScope(presence, change.current)) {
        this.#write(socket, { method: "agent.orchestrator.changed", params: { change } });
      }
    }
  }

  #newestSocketForTerminal(input: AgentScope & { terminalId: string }): Socket | undefined {
    let newest: { order: number; socket: Socket } | undefined;
    for (const [socket, presence] of this.#piPresenceBySocket) {
      if (
        sameScope(presence, input) &&
        presence.terminalId === input.terminalId &&
        !socket.destroyed
      ) {
        const order = this.#connectionOrderBySocket.get(socket) ?? 0;
        if (!newest || order > newest.order) newest = { order, socket };
      }
    }
    return newest?.socket;
  }

  #handleSocketClose(socket: Socket): void {
    if (!this.#sockets.delete(socket)) return;
    this.#connectionOrderBySocket.delete(socket);
    const presence = this.#piPresenceBySocket.get(socket);
    this.#piPresenceBySocket.delete(socket);
    if (!this.#stopping && presence) this.#scheduleDisconnect(presence);
  }

  #scheduleDisconnect(presence: PiPresence): void {
    const key = terminalPresenceKey(presence);
    if (this.#hasTerminalPresence(presence) || this.#disconnectTimers.has(key)) return;
    const handle = this.#setTimeout(() => {
      this.#disconnectTimers.delete(key);
      if (this.#stopping || this.#hasTerminalPresence(presence)) return;
      this.#releaseCurrentOwnersForTerminal({
        ...presence,
        reason: "disconnected",
      });
    }, this.#disconnectGraceMs);
    this.#disconnectTimers.set(key, { handle });
  }

  #armStartupGrace(): void {
    for (const state of this.#orchestrator.persistedOwners()) {
      if (!state.owner) continue;
      const key = terminalPresenceKey({ ...state, terminalId: state.owner.terminalId });
      const handle = this.#setTimeout(() => {
        this.#startupTimers.delete(key);
        if (
          this.#stopping ||
          this.#hasTerminalPresence({ ...state, terminalId: state.owner?.terminalId ?? "" })
        ) {
          return;
        }
        this.#releaseCurrentOwnersForTerminal({
          herdrSessionName: state.herdrSessionName,
          reason: "startup_timeout",
          terminalId: state.owner?.terminalId ?? "",
        });
      }, this.#startupReconnectGraceMs);
      this.#startupTimers.set(key, { handle });
    }
  }

  #releaseCurrentOwnersForTerminal(input: {
    herdrSessionName: string;
    reason: "disconnected" | "startup_timeout";
    terminalId: string;
  }): void {
    const owners = this.#orchestrator
      .persistedOwners()
      .filter(
        (state) =>
          state.herdrSessionName === input.herdrSessionName &&
          state.owner?.terminalId === input.terminalId,
      );
    for (const owner of owners) {
      const change = this.#orchestrator.release({
        ...owner,
        reason: input.reason,
        terminalId: input.terminalId,
      });
      if (change) this.#publishOrchestratorChange(toWireChange(change));
    }
  }

  #cancelGraceForTerminal(presence: AgentScope & { terminalId: string }): void {
    const key = terminalPresenceKey(presence);
    this.#cancelTimer(this.#disconnectTimers, key);
    this.#cancelTimer(this.#startupTimers, key);
  }

  #hasTerminalPresence(input: AgentScope & { terminalId: string }): boolean {
    for (const presence of this.#piPresenceBySocket.values()) {
      if (
        presence.herdrSessionName === input.herdrSessionName &&
        presence.terminalId === input.terminalId
      ) {
        return true;
      }
    }
    return false;
  }

  #cancelTimer(registry: Map<string, GraceTimer>, key: string): void {
    const timer = registry.get(key);
    if (!timer) return;
    this.#clearTimeout(timer.handle);
    registry.delete(key);
  }

  #clearGraceTimers(registry: Map<string, GraceTimer>): void {
    for (const timer of registry.values()) this.#clearTimeout(timer.handle);
    registry.clear();
  }

  #write(socket: Socket, message: unknown): void {
    if (!socket.destroyed) socket.write(encodeJsonLine(message));
  }

  #resolveScope(input: AgentQueryScope): AgentQueryScope {
    if (input.all)
      return {
        all: true,
        ...(input.herdrSessionName ? { herdrSessionName: input.herdrSessionName } : {}),
      };
    if (input.workspaceId && !input.herdrSessionName) {
      const sessions = new Set(
        this.#stores.agents
          .list({ workspaceId: input.workspaceId })
          .map((agent) => agent.herdrSessionName),
      );
      if (sessions.size > 1) {
        throw new Error(
          `workspace ${input.workspaceId} exists in multiple Herdr sessions; pass --session <name>: ${[...sessions].join(", ")}`,
        );
      }
    }
    if (input.workspaceId || input.herdrSessionName) {
      return {
        ...(input.herdrSessionName ? { herdrSessionName: input.herdrSessionName } : {}),
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      };
    }
    throw new Error(
      "agent scope requires current Herdr workspace, --workspace, --session, or --all",
    );
  }
}

function historyInput(agent: AgentIndexRecord) {
  return {
    agent: agent.agent,
    agentSession: agent.agentSession,
    cwd: agent.cwd,
    foregroundCwd: agent.foregroundCwd,
  };
}

function assertSchema(schema: Parameters<typeof Value.Check>[0], value: unknown): void {
  if (!Value.Check(schema, value)) throw new Error("Invalid RPC params");
}

function toWireState(state: AgentOrchestratorState): AgentOrchestratorWireState {
  return { ...state, updatedAt: state.updatedAt.toISOString() };
}

function toWireChange(change: {
  current: AgentOrchestratorState;
  previous: AgentOrchestratorState;
  reason: AgentOrchestratorChanged["reason"];
}): AgentOrchestratorChanged {
  return {
    current: toWireState(change.current),
    previous: toWireState(change.previous),
    reason: change.reason,
  };
}

function sameScope(left: AgentScope, right: AgentScope): boolean {
  return left.herdrSessionName === right.herdrSessionName && left.workspaceId === right.workspaceId;
}

function sameOwner(
  left: AgentOrchestratorState["owner"],
  right: AgentOrchestratorState["owner"],
): boolean {
  return left?.terminalId === right?.terminalId && left?.paneId === right?.paneId;
}

function terminalPresenceKey(input: { herdrSessionName: string; terminalId: string }): string {
  return `${input.herdrSessionName}\0${input.terminalId}`;
}
