import { createConnection, type Socket } from "node:net";
import { encodeJsonLine, JsonLineDecoder } from "@/shared/json-lines.js";

type Pending = { reject(error: Error): void; resolve(value: unknown): void };

type RpcResponse = { error?: { message?: string }; id?: number | string; result?: unknown };

export class ObservabilityRpcClient {
  readonly #decoder = new JsonLineDecoder();
  readonly #pending = new Map<string, Pending>();
  readonly #socket: Socket;
  #nextId = 1;

  constructor(options: { socketPath: string }) {
    this.#socket = createConnection(options.socketPath);
    this.#socket.on("data", (chunk) => this.#handleData(chunk));
    this.#socket.on("error", (error) => this.#rejectAll(error));
    this.#socket.on("close", () => this.#rejectAll(new Error("Observability RPC socket closed")));
  }

  close(): void {
    this.#socket.destroy();
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.#nextId;
    this.#nextId += 1;
    return new Promise((resolve, reject) => {
      this.#pending.set(String(id), { reject, resolve });
      this.#socket.write(encodeJsonLine({ id, method, params }));
    });
  }

  #handleData(chunk: Buffer): void {
    for (const message of this.#decoder.push(chunk.toString("utf8"))) {
      const response = message as RpcResponse;
      if (response.id === undefined) {
        continue;
      }
      const pending = this.#pending.get(String(response.id));
      if (!pending) {
        continue;
      }
      this.#pending.delete(String(response.id));
      if (response.error) {
        pending.reject(new Error(response.error.message ?? "Observability RPC failed"));
      } else {
        pending.resolve(response.result);
      }
    }
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      pending.reject(error);
    }
    this.#pending.clear();
  }
}
