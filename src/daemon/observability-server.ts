import { existsSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { Value } from "@sinclair/typebox/value";
import type { AgentHistoryService } from "@/agent-history/service.js";
import type { AgentEventStore } from "@/db/agent-events.js";
import type { AgentStore } from "@/db/agents.js";
import type { HerdrWorkspaceStore } from "@/db/herdr-workspaces.js";
import type { AgentNotificationService } from "@/observability/agent-notification-service.js";
import type {
  AgentEventRecord,
  AgentIndexRecord,
  AgentQueryScope,
} from "@/observability/contracts.js";
import {
  agentEventsInputSchema,
  agentGetInputSchema,
  agentListInputSchema,
  agentNotificationAckInputSchema,
  agentNotificationSubscribeInputSchema,
  agentReadInputSchema,
  agentTelemetryInputSchema,
} from "@/observability/schemas.js";
import { encodeJsonLine, JsonLineDecoder } from "@/shared/json-lines.js";

type RpcRequest = { id?: number | string; method?: string; params?: unknown };

type AgentStores = {
  agentEvents: AgentEventStore;
  agents: AgentStore;
  herdrWorkspaces: HerdrWorkspaceStore;
};

export class ObservabilityRpcServer {
  readonly #history: AgentHistoryService;
  readonly #notifications: AgentNotificationService;
  readonly #server: Server;
  readonly #socketPath: string;
  readonly #sockets = new Set<Socket>();
  readonly #stores: AgentStores;

  constructor(options: {
    history: AgentHistoryService;
    notifications: AgentNotificationService;
    socketPath: string;
    stores: AgentStores;
  }) {
    this.#history = options.history;
    this.#notifications = options.notifications;
    this.#socketPath = options.socketPath;
    this.#stores = options.stores;
    this.#server = createServer((socket) => this.#handleConnection(socket));
  }

  start(): Promise<void> {
    if (existsSync(this.#socketPath)) unlinkSync(this.#socketPath);
    return new Promise((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(this.#socketPath, () => {
        this.#server.off("error", reject);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    for (const socket of this.#sockets) socket.destroy();
    this.#sockets.clear();
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
    for (const socket of this.#sockets) {
      socket.write(encodeJsonLine({ method: "agent.event", params: { event } }));
    }
  }

  #handleConnection(socket: Socket): void {
    this.#sockets.add(socket);
    const decoder = new JsonLineDecoder();
    socket.on("data", (chunk) => {
      for (const message of decoder.push(chunk.toString("utf8"))) {
        void this.#handleRequest(socket, message as RpcRequest);
      }
    });
    socket.on("close", () => this.#sockets.delete(socket));
    socket.on("error", () => this.#sockets.delete(socket));
  }

  async #handleRequest(socket: Socket, request: RpcRequest): Promise<void> {
    try {
      if (!request.method) throw new Error("Missing method");
      const result = await this.#dispatch(request.method, request.params ?? {});
      socket.write(encodeJsonLine({ id: request.id, result }));
    } catch (error) {
      socket.write(
        encodeJsonLine({
          error: { message: error instanceof Error ? error.message : String(error) },
          id: request.id,
        }),
      );
    }
  }

  async #dispatch(method: string, params: unknown): Promise<unknown> {
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
      case "agent.notifications.subscribe": {
        assertSchema(agentNotificationSubscribeInputSchema, params);
        const input = params as {
          autoResume?: boolean;
          herdrSessionName?: string;
          subscriberId: string;
          subscriberKind: string;
          workspaceId?: string;
        };
        const subscription = this.#notifications.subscribe({
          autoResume: input.autoResume ?? false,
          herdrSessionName: input.herdrSessionName ?? null,
          subscriberId: input.subscriberId,
          subscriberKind: input.subscriberKind,
          workspaceId: input.workspaceId ?? null,
        });
        return {
          events: this.#notifications.pending({ subscriptionId: subscription.id }),
          subscription,
        };
      }
      case "agent.notifications.ack": {
        assertSchema(agentNotificationAckInputSchema, params);
        this.#notifications.ack(params as { eventId: number; subscriptionId: string });
        return { acknowledged: true };
      }
      case "agent.telemetry": {
        assertSchema(agentTelemetryInputSchema, params);
        return { accepted: true };
      }
      default:
        throw new Error(`Unknown method: ${method}`);
    }
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
