import { createConnection, type Socket } from "node:net";

export type AgentEventWireRecord = {
  agentId?: string | null;
  compactHistory?: CompactAgentHistory | null;
  createdAt?: string;
  herdrSessionName?: string;
  id: number;
  paneId?: string | null;
  payload: unknown;
  terminalId?: string | null;
  type: string;
  workspaceId?: string | null;
};

export type CompactAgentHistory = {
  lastAssistantMessage?: { text?: string | null } | null;
  lastToolResult?: { text?: string; toolName?: string } | null;
  lastUserMessage?: { text?: string | null } | null;
  updatedAt?: string | null;
};

export type AgentContextListItem = {
  agent?: string | null;
  agentStatus?: string;
  history?: CompactAgentHistory;
  paneId?: string;
  terminalId?: string | null;
};

export type AgentWorkspaceContextSnapshot = {
  agents: AgentContextListItem[];
  herdrSessionName: string;
  updatedAt: string;
  workspaceId: string;
};

export type AgentOrchestratorOwner = {
  paneId: string;
  terminalId: string;
};

export type AgentOrchestratorWireState = {
  ackedEventId: number;
  herdrSessionName: string;
  owner: AgentOrchestratorOwner | null;
  updatedAt: string;
  workspaceId: string;
};

export type AgentOrchestratorChanged = {
  current: AgentOrchestratorWireState;
  previous: AgentOrchestratorWireState;
  reason: "claimed" | "disconnected" | "moved" | "released" | "startup_timeout";
};

export type DaemonStreamMessage =
  | { method: "agent.event"; params: { event: AgentEventWireRecord } }
  | {
      method: "agent.context.changed";
      params: {
        context: AgentWorkspaceContextSnapshot | null;
        herdrSessionName: string;
        workspaceId: string;
      };
    }
  | {
      method: "agent.orchestrator.changed";
      params: { change: AgentOrchestratorChanged };
    };

export type ReconnectingDaemonClientOptions = {
  reconnectDelaysMs?: readonly number[];
  socketPath: string;
};

type ClientState = "closed" | "connected" | "connecting" | "idle";

type PendingRequest = {
  reject(error: Error): void;
  resolve(value: unknown): void;
};

type RpcMessage = {
  error?: { message?: string };
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
};

const DEFAULT_RECONNECT_DELAYS_MS = [100, 250, 500, 1_000] as const;

export class ReconnectingDaemonClient {
  onConnected: (() => Promise<void> | void) | undefined;
  onDisconnected: ((error: Error) => void) | undefined;
  onStreamMessage: ((message: DaemonStreamMessage) => void) | undefined;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #reconnectDelaysMs: readonly number[];
  readonly #socketPath: string;
  #buffer = "";
  #generation = 0;
  #nextId = 1;
  #reconnectAttempt = 0;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #socket: Socket | undefined;
  #state: ClientState = "idle";

  constructor(options: ReconnectingDaemonClientOptions) {
    this.#socketPath = options.socketPath;
    this.#reconnectDelaysMs =
      options.reconnectDelaysMs && options.reconnectDelaysMs.length > 0
        ? options.reconnectDelaysMs
        : DEFAULT_RECONNECT_DELAYS_MS;
    queueMicrotask(() => this.#connect());
  }

  close(): void {
    if (this.#state === "closed") return;
    this.#state = "closed";
    this.#generation += 1;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = undefined;
    this.#socket?.destroy();
    this.#socket = undefined;
    this.#rejectAll(new Error("Shepherd daemon client is closed"));
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.#state === "closed") {
      return Promise.reject(new Error("Shepherd daemon client is closed"));
    }
    if (this.#state !== "connected" || !this.#socket) {
      return Promise.reject(new Error("Shepherd daemon client is not connected"));
    }
    const id = `pi-${this.#nextId}`;
    this.#nextId += 1;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { reject, resolve });
      this.#socket?.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  #connect(): void {
    if (this.#state === "closed" || this.#state === "connecting") return;
    this.#state = "connecting";
    this.#generation += 1;
    const generation = this.#generation;
    this.#buffer = "";
    const socket = createConnection(this.#socketPath);
    this.#socket = socket;
    let disconnected = false;
    const disconnect = (error: Error) => {
      if (disconnected || generation !== this.#generation || this.#state === "closed") return;
      disconnected = true;
      this.#handleDisconnect(error, generation);
    };
    socket.on("connect", () => {
      if (generation !== this.#generation || this.#state === "closed") return;
      this.#state = "connected";
      this.#reconnectAttempt = 0;
      Promise.resolve(this.onConnected?.()).catch((error) => {
        socket.destroy(asError(error));
      });
    });
    socket.on("data", (chunk) => {
      if (generation !== this.#generation || this.#state === "closed") return;
      try {
        this.#handleData(chunk.toString("utf8"));
      } catch (error) {
        socket.destroy(asError(error));
      }
    });
    socket.on("error", disconnect);
    socket.on("close", () => disconnect(new Error("Shepherd daemon socket closed")));
  }

  #handleDisconnect(error: Error, generation: number): void {
    if (generation !== this.#generation || this.#state === "closed") return;
    this.#state = "idle";
    this.#socket = undefined;
    this.#rejectAll(error);
    this.onDisconnected?.(error);
    const delay =
      this.#reconnectDelaysMs[
        Math.min(this.#reconnectAttempt, this.#reconnectDelaysMs.length - 1)
      ] ?? 1_000;
    this.#reconnectAttempt += 1;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      this.#connect();
    }, delay);
  }

  #handleData(chunk: string): void {
    this.#buffer += chunk;
    let newline = this.#buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      newline = this.#buffer.indexOf("\n");
      if (!line) continue;
      const message = JSON.parse(line) as RpcMessage;
      if (
        message.method === "agent.event" ||
        message.method === "agent.context.changed" ||
        message.method === "agent.orchestrator.changed"
      ) {
        this.onStreamMessage?.(message as DaemonStreamMessage);
        continue;
      }
      if (message.id === undefined) continue;
      const pending = this.#pending.get(String(message.id));
      if (!pending) continue;
      this.#pending.delete(String(message.id));
      if (message.error) pending.reject(new Error(message.error.message ?? "Shepherd RPC failed"));
      else pending.resolve(message.result);
    }
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
