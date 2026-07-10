import { createConnection, type Socket } from "node:net";
import { encodeJsonLine, JsonLineDecoder } from "@/shared/json-lines.js";

type Pending = {
  reject(error: Error): void;
  resolve(value: unknown): void;
};

type RpcMessage = {
  error?: { message?: string };
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
};

export class RpcTestClient {
  readonly notifications: RpcMessage[] = [];
  readonly #decoder = new JsonLineDecoder();
  readonly #pending = new Map<number, Pending>();
  readonly #socket: Socket;
  #nextId = 1;

  private constructor(socketPath: string) {
    this.#socket = createConnection(socketPath);
    this.#socket.on("data", (chunk) => this.#handleData(chunk));
    this.#socket.on("error", (error) => this.#rejectAll(error));
    this.#socket.on("close", () => this.#rejectAll(new Error("RPC test socket closed")));
  }

  static async connect(socketPath: string): Promise<RpcTestClient> {
    const client = new RpcTestClient(socketPath);
    await new Promise<void>((resolve, reject) => {
      client.#socket.once("connect", resolve);
      client.#socket.once("error", reject);
    });
    return client;
  }

  close(): void {
    this.#socket.destroy();
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.#nextId;
    this.#nextId += 1;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { reject, resolve });
      this.#socket.write(encodeJsonLine({ id, method, params }));
    });
  }

  async waitForNotification(method: string): Promise<RpcMessage> {
    for (let attempts = 0; attempts < 100; attempts += 1) {
      const index = this.notifications.findIndex((message) => message.method === method);
      if (index >= 0) return this.notifications.splice(index, 1)[0] as RpcMessage;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    throw new Error(`Timed out waiting for ${method}`);
  }

  clearNotifications(): void {
    this.notifications.length = 0;
  }

  #handleData(chunk: Buffer): void {
    for (const decoded of this.#decoder.push(chunk.toString("utf8"))) {
      const message = decoded as RpcMessage;
      if (message.id === undefined) {
        this.notifications.push(message);
        continue;
      }
      const pending = this.#pending.get(message.id);
      if (!pending) continue;
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message ?? "RPC request failed"));
      else pending.resolve(message.result);
    }
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}
