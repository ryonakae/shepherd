import { existsSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { type ConfigLoadResult, loadShepherdConfig } from "@/config/load.js";
import type { EventRecord, EventStore } from "@/db/event-store.js";
import type { GatewayMessage, GatewayRunner } from "@/gateway/runner.js";
import { encodeJsonLine, JsonLineDecoder } from "./json-lines.js";

type ShepherdDaemonServerOptions = {
  configPath?: string;
  gatewayRunner?: GatewayTurnRunner;
  socketPath: string;
  store: EventStore;
};

type GatewayTurnRunner = Pick<GatewayRunner, "runTurn">;

type RpcRequest = {
  id?: string | number;
  method?: string;
  params?: unknown;
};

type EventWireRecord = Omit<EventRecord, "createdAt"> & {
  createdAt: string;
};

export class ShepherdDaemonServer {
  readonly #configPath: string | undefined;
  readonly #server: Server;
  readonly #socketPath: string;
  readonly #sockets = new Set<Socket>();
  readonly #gatewayRunner: GatewayTurnRunner | undefined;
  readonly #store: EventStore;
  readonly #subscriptions = new Map<string, Set<Socket>>();
  #config: ConfigLoadResult | undefined;

  constructor(options: ShepherdDaemonServerOptions) {
    this.#configPath = options.configPath;
    this.#gatewayRunner = options.gatewayRunner;
    this.#socketPath = options.socketPath;
    this.#store = options.store;
    this.#server = createServer((socket) => this.#handleConnection(socket));
  }

  start(): Promise<void> {
    if (existsSync(this.#socketPath)) {
      unlinkSync(this.#socketPath);
    }

    return new Promise((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(this.#socketPath, () => {
        this.#server.off("error", reject);
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    for (const socket of this.#sockets) {
      socket.destroy();
    }
    this.#sockets.clear();
    this.#subscriptions.clear();

    return new Promise((resolve, reject) => {
      if (!this.#server.listening) {
        resolve();
        return;
      }

      this.#server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  #handleConnection(socket: Socket): void {
    const decoder = new JsonLineDecoder();
    this.#sockets.add(socket);

    socket.on("data", (chunk) => {
      try {
        for (const message of decoder.push(chunk.toString("utf8"))) {
          this.#handleMessage(socket, message);
        }
      } catch (error) {
        this.#write(socket, {
          error: { message: error instanceof Error ? error.message : "Invalid JSON frame" },
        });
      }
    });

    socket.on("close", () => this.#removeSocket(socket));
    socket.on("error", () => this.#removeSocket(socket));
  }

  #handleMessage(socket: Socket, message: unknown): void {
    const request = message as RpcRequest;

    if (request.method === "session.subscribe") {
      this.#subscribe(socket, request);
      return;
    }

    if (request.method === "session.append_event") {
      this.#appendEvent(socket, request);
      return;
    }

    if (request.method === "config.reload") {
      this.#reloadConfig(socket, request);
      return;
    }

    if (request.method === "gateway.run_turn") {
      void this.#runGatewayTurn(socket, request);
      return;
    }

    this.#write(socket, {
      error: { message: `Unknown method: ${String(request.method)}` },
      id: request.id,
    });
  }

  #subscribe(socket: Socket, request: RpcRequest): void {
    const params = request.params as { afterEventId?: number; sessionId?: string };
    if (!params?.sessionId) {
      this.#write(socket, { error: { message: "sessionId is required" }, id: request.id });
      return;
    }

    const replay = this.#store.listEvents(params.sessionId, params.afterEventId ?? 0);
    const subscribers = this.#subscriptions.get(params.sessionId) ?? new Set<Socket>();
    subscribers.add(socket);
    this.#subscriptions.set(params.sessionId, subscribers);

    this.#write(socket, {
      id: request.id,
      result: { replayed: replay.length, subscribed: true },
    });

    for (const event of replay) {
      this.#writeEvent(socket, event);
    }
  }

  #appendEvent(socket: Socket, request: RpcRequest): void {
    const params = request.params as {
      actorId?: string;
      idempotencyKey?: string;
      payload?: unknown;
      sessionId?: string;
      type?: string;
    };

    if (!params?.sessionId || !params.type) {
      this.#write(socket, {
        error: { message: "sessionId and type are required" },
        id: request.id,
      });
      return;
    }

    const appendInput = {
      payload: params.payload ?? {},
      sessionId: params.sessionId,
      type: params.type,
      ...(params.actorId ? { actorId: params.actorId } : {}),
      ...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
    };

    const event = this.#store.appendEvent(appendInput);

    this.#write(socket, {
      id: request.id,
      result: { event: toWireEvent(event) },
    });
    this.#broadcastEvent(event);
  }

  #reloadConfig(socket: Socket, request: RpcRequest): void {
    if (!this.#configPath) {
      this.#write(socket, {
        error: { message: "No config path configured" },
        id: request.id,
      });
      return;
    }

    this.#config = loadShepherdConfig(this.#configPath);
    this.#write(socket, {
      id: request.id,
      result: { ok: this.#config.ok },
    });
  }

  async #runGatewayTurn(socket: Socket, request: RpcRequest): Promise<void> {
    if (!this.#gatewayRunner) {
      this.#write(socket, {
        error: { message: "Gateway runner is not configured" },
        id: request.id,
      });
      return;
    }

    const params = request.params as { messages?: unknown; sessionId?: string };
    if (!params?.sessionId || !isGatewayMessages(params.messages)) {
      this.#write(socket, {
        error: { message: "sessionId and messages are required" },
        id: request.id,
      });
      return;
    }

    const afterEventId = this.#store.getLatestEventId(params.sessionId);

    try {
      const output = await this.#gatewayRunner.runTurn({
        messages: params.messages,
        sessionId: params.sessionId,
      });
      this.#write(socket, {
        id: request.id,
        result: output,
      });

      for (const event of this.#store.listEvents(params.sessionId, afterEventId, 500)) {
        this.#broadcastEvent(event);
      }
    } catch (error) {
      this.#write(socket, {
        error: { message: error instanceof Error ? error.message : String(error) },
        id: request.id,
      });
    }
  }

  #broadcastEvent(event: EventRecord): void {
    for (const socket of this.#subscriptions.get(event.sessionId) ?? []) {
      this.#writeEvent(socket, event);
    }
  }

  #writeEvent(socket: Socket, event: EventRecord): void {
    this.#write(socket, {
      method: "session.event",
      params: { event: toWireEvent(event) },
    });
  }

  #write(socket: Socket, message: unknown): void {
    socket.write(encodeJsonLine(message));
  }

  #removeSocket(socket: Socket): void {
    this.#sockets.delete(socket);
    for (const subscribers of this.#subscriptions.values()) {
      subscribers.delete(socket);
    }
  }
}

function isGatewayMessages(value: unknown): value is GatewayMessage[] {
  if (!Array.isArray(value)) {
    return false;
  }

  return value.every(
    (message) =>
      typeof message === "object" &&
      message !== null &&
      typeof (message as GatewayMessage).content === "string" &&
      ["assistant", "system", "user"].includes((message as GatewayMessage).role),
  );
}

function toWireEvent(event: EventRecord): EventWireRecord {
  return {
    ...event,
    createdAt: event.createdAt.toISOString(),
  };
}
