import { createConnection, type Socket } from "node:net";
import { encodeJsonLine, JsonLineDecoder } from "@/daemon/json-lines.js";

export type HerdrRequestId = string;

export type HerdrSocketClientOptions = {
  socketPath: string;
};

type PendingRequest = {
  reject: (error: Error) => void;
  resolve: (value: unknown) => void;
};

type HerdrResponse = {
  error?: { message?: string };
  id?: string;
  result?: unknown;
};

export class HerdrSocketClient {
  readonly #decoder = new JsonLineDecoder();
  readonly #pending = new Map<HerdrRequestId, PendingRequest>();
  readonly #socket: Socket;
  #nextId = 1;

  constructor(options: HerdrSocketClientOptions) {
    this.#socket = createConnection(options.socketPath);
    this.#socket.on("data", (chunk) => this.#handleData(chunk));
    this.#socket.on("error", (error) => this.#rejectAll(error));
    this.#socket.on("close", () => this.#rejectAll(new Error("Herdr socket closed")));
  }

  close(): void {
    this.#socket.destroy();
  }

  request(method: string, params: unknown = {}): Promise<unknown> {
    const id = `shepherd-${this.#nextId}`;
    this.#nextId += 1;

    return new Promise((resolve, reject) => {
      this.#pending.set(id, { reject, resolve });
      this.#socket.write(encodeJsonLine({ id, method, params }));
    });
  }

  createWorkspace(params: { cwd: string; label: string }): Promise<unknown> {
    return this.request("workspace.create", params);
  }

  createTab(params: { label: string; workspace_id?: string }): Promise<unknown> {
    return this.request("tab.create", params);
  }

  runPaneCommand(params: { command: string; pane_id: string }): Promise<unknown> {
    return this.request("pane.run", params);
  }

  readPane(params: {
    lines?: number;
    pane_id: string;
    source?: "all" | "recent";
  }): Promise<unknown> {
    return this.request("pane.read", params);
  }

  readAgent(params: {
    lines?: number;
    source?: "detection" | "recent" | "recent-unwrapped" | "visible";
    target: string;
  }): Promise<unknown> {
    return this.request("agent.read", params);
  }

  startAgent(params: {
    args?: string[];
    command: string;
    cwd?: string;
    name: string;
    tab_id?: string;
    workspace_id?: string;
  }): Promise<unknown> {
    return this.request("agent.start", params);
  }

  sendAgentMessage(params: { target: string; text: string }): Promise<unknown> {
    return this.request("agent.send", params);
  }

  #handleData(chunk: Buffer): void {
    for (const message of this.#decoder.push(chunk.toString("utf8"))) {
      const response = message as HerdrResponse;
      if (!response.id) {
        continue;
      }

      const pending = this.#pending.get(response.id);
      if (!pending) {
        continue;
      }

      this.#pending.delete(response.id);
      if (response.error) {
        pending.reject(new Error(response.error.message ?? "Herdr request failed"));
        continue;
      }

      pending.resolve(response.result);
    }
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      pending.reject(error);
    }
    this.#pending.clear();
  }
}
