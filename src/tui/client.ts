import { createConnection, type Socket } from "node:net";
import { encodeJsonLine, JsonLineDecoder } from "@/daemon/json-lines.js";
import type { EventRecord } from "@/db/event-store.js";

export type WireEventRecord = Omit<EventRecord, "createdAt"> & {
  createdAt: string;
};

export type SubscribeInput = {
  afterEventId?: number;
  onEvent(event: WireEventRecord): void;
  sessionId: string;
};

export type SendUserMessageInput = {
  actorId?: string;
  idempotencyKey?: string;
  presentation?: unknown;
  sessionId: string;
  text: string;
};

export type RenameSessionInput = {
  sessionId: string;
  title: string | null;
};

type PendingRequest = {
  reject(error: Error): void;
  resolve(value: unknown): void;
};

type RpcResponse = {
  error?: { message?: string };
  id?: string | number;
  result?: unknown;
};

type SessionEventMessage = {
  method?: string;
  params?: {
    event?: WireEventRecord;
  };
};

export class ShepherdSessionClient {
  readonly #decoder = new JsonLineDecoder();
  readonly #pending = new Map<string, PendingRequest>();
  readonly #socket: Socket;
  readonly #subscribers = new Map<string, Set<(event: WireEventRecord) => void>>();
  #nextRequestId = 1;

  private constructor(socket: Socket) {
    this.#socket = socket;
    this.#socket.on("data", (chunk) => this.#handleData(chunk));
    this.#socket.on("error", (error) => this.#rejectAll(error));
    this.#socket.on("close", () => this.#rejectAll(new Error("Shepherd daemon socket closed")));
  }

  static connect(socketPath: string): Promise<ShepherdSessionClient> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(socketPath);
      socket.once("connect", () => resolve(new ShepherdSessionClient(socket)));
      socket.once("error", reject);
    });
  }

  async close(): Promise<void> {
    if (this.#socket.destroyed) {
      return;
    }

    await new Promise<void>((resolve) => {
      this.#socket.once("close", () => resolve());
      this.#socket.destroy();
    });
  }

  async sendUserMessage(input: SendUserMessageInput): Promise<{ event: WireEventRecord }> {
    return (await this.#request("session.user_message", input)) as { event: WireEventRecord };
  }

  async renameSession(input: RenameSessionInput): Promise<{
    session: {
      createdAt: string;
      id: string;
      status: "active" | "archived";
      title: string | null;
      updatedAt: string;
      workingContextId: string | null;
    };
  }> {
    return (await this.#request("session.rename", input)) as {
      session: {
        createdAt: string;
        id: string;
        status: "active" | "archived";
        title: string | null;
        updatedAt: string;
        workingContextId: string | null;
      };
    };
  }

  async subscribe(input: SubscribeInput): Promise<{ replayed: number; subscribed: true }> {
    const subscribers = this.#subscribers.get(input.sessionId) ?? new Set();
    subscribers.add(input.onEvent);
    this.#subscribers.set(input.sessionId, subscribers);

    return (await this.#request("session.subscribe", {
      afterEventId: input.afterEventId ?? 0,
      sessionId: input.sessionId,
    })) as { replayed: number; subscribed: true };
  }

  #handleData(chunk: Buffer): void {
    try {
      for (const message of this.#decoder.push(chunk.toString("utf8"))) {
        this.#handleMessage(message);
      }
    } catch (error) {
      this.#rejectAll(error instanceof Error ? error : new Error("Invalid JSON frame"));
    }
  }

  #handleMessage(message: unknown): void {
    const event = (message as SessionEventMessage).params?.event;
    if ((message as SessionEventMessage).method === "session.event" && event) {
      for (const listener of this.#subscribers.get(event.sessionId) ?? []) {
        listener(event);
      }
      return;
    }

    const response = message as RpcResponse;
    if (response.id === undefined) {
      return;
    }

    const pending = this.#pending.get(String(response.id));
    if (!pending) {
      return;
    }

    this.#pending.delete(String(response.id));
    if (response.error) {
      pending.reject(new Error(response.error.message ?? "Shepherd RPC failed"));
      return;
    }

    pending.resolve(response.result);
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #request(method: string, params: unknown): Promise<unknown> {
    const id = String(this.#nextRequestId);
    this.#nextRequestId += 1;

    return new Promise((resolve, reject) => {
      this.#pending.set(id, { reject, resolve });
      this.#socket.write(encodeJsonLine({ id, method, params }));
    });
  }
}
