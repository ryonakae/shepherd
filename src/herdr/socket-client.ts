import { createConnection, type Socket } from "node:net";
import { encodeJsonLine, JsonLineDecoder } from "@/gateway/json-lines.js";

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
  method?: string;
  params?: unknown;
  result?: unknown;
};

type EventSubscriber = {
  push(event: unknown): void;
};

export class HerdrSocketClient {
  readonly #decoder = new JsonLineDecoder();
  readonly #pending = new Map<HerdrRequestId, PendingRequest>();
  readonly #subscribers = new Set<EventSubscriber>();
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

  listWorkspaces(): Promise<unknown> {
    return this.request("workspace.list");
  }

  getWorkspace(params: { workspace_id: string }): Promise<unknown> {
    return this.request("workspace.get", params);
  }

  focusWorkspace(params: { workspace_id: string }): Promise<unknown> {
    return this.request("workspace.focus", params);
  }

  createTab(params: { label: string; workspace_id?: string }): Promise<unknown> {
    return this.request("tab.create", params);
  }

  listTabs(params: { workspace_id?: string } = {}): Promise<unknown> {
    return this.request("tab.list", params);
  }

  getTab(params: { tab_id: string }): Promise<unknown> {
    return this.request("tab.get", params);
  }

  splitPane(params: {
    cwd?: string;
    direction: "down" | "right";
    focus?: boolean;
    pane_id?: string;
    ratio?: number;
    tab_id?: string;
    workspace_id?: string;
  }): Promise<unknown> {
    return this.request("pane.split", params);
  }

  listPanes(params: { tab_id?: string; workspace_id?: string } = {}): Promise<unknown> {
    return this.request("pane.list", params);
  }

  getPane(params: { pane_id: string }): Promise<unknown> {
    return this.request("pane.get", params);
  }

  sendPaneInput(params: { pane_id: string; text: string }): Promise<unknown> {
    return this.request("pane.send_input", params);
  }

  sendPaneText(params: { pane_id: string; text: string }): Promise<unknown> {
    return this.sendPaneInput(params);
  }

  runPaneCommand(params: { command: string; pane_id: string }): Promise<unknown> {
    return this.sendPaneInput({ pane_id: params.pane_id, text: params.command });
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

  listAgents(params: { workspace_id?: string } = {}): Promise<unknown> {
    return this.request("agent.list", params);
  }

  getAgent(params: { target: string }): Promise<unknown> {
    return this.request("agent.get", params);
  }

  focusAgent(params: { target: string }): Promise<unknown> {
    return this.request("agent.focus", params);
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

  waitForAgent(params: {
    status: "blocked" | "done" | "idle" | "unknown" | "working";
    target: string;
    timeout_ms?: number;
  }): Promise<unknown> {
    return this.request("agent.wait", params);
  }

  waitForOutput(params: {
    lines?: number;
    match: string;
    pane_id: string;
    regex?: boolean;
    source?: "recent" | "recent-unwrapped" | "visible";
    timeout_ms?: number;
  }): Promise<unknown> {
    return this.request("pane.wait_for_output", {
      ...(params.lines !== undefined ? { lines: params.lines } : {}),
      match:
        params.regex === true
          ? { type: "regex", value: params.match }
          : { type: "substring", value: params.match },
      pane_id: params.pane_id,
      source: params.source ?? "recent",
      ...(params.timeout_ms !== undefined ? { timeout_ms: params.timeout_ms } : {}),
    });
  }

  waitForEvent(params: Record<string, unknown> = {}): Promise<unknown> {
    return this.request("events.wait", params);
  }

  sessionSnapshot(): Promise<unknown> {
    return this.request("session.snapshot");
  }

  async *subscribeEvents(
    params: { paneIds: string[]; workspaceId: string },
    options: { signal?: AbortSignal } = {},
  ): AsyncIterable<unknown> {
    const queue: unknown[] = [];
    let wake: (() => void) | undefined;
    const subscriber: EventSubscriber = {
      push(event) {
        queue.push(event);
        wake?.();
        wake = undefined;
      },
    };
    this.#subscribers.add(subscriber);
    try {
      await this.request("events.subscribe", {
        subscriptions: [
          { type: "workspace.updated" },
          { type: "workspace.renamed" },
          { type: "workspace.moved" },
          { type: "workspace.closed" },
          { type: "tab.created" },
          { type: "tab.closed" },
          { type: "tab.moved" },
          { type: "pane.created" },
          { type: "pane.closed" },
          { type: "pane.moved" },
          { type: "pane.exited" },
          { type: "pane.agent_detected" },
          ...params.paneIds.map((pane_id) => ({
            pane_id,
            type: "pane.agent_status_changed" as const,
          })),
        ],
      });
      while (!options.signal?.aborted) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            wake = resolve;
            options.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
        }
        while (queue.length > 0) {
          yield queue.shift();
        }
      }
    } finally {
      this.#subscribers.delete(subscriber);
    }
  }

  #handleData(chunk: Buffer): void {
    for (const message of this.#decoder.push(chunk.toString("utf8"))) {
      const response = message as HerdrResponse;
      if (!response.id) {
        this.#publishNotification(response);
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

  #publishNotification(message: HerdrResponse): void {
    const event = notificationEvent(message);
    for (const subscriber of this.#subscribers) {
      subscriber.push(event);
    }
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

function notificationEvent(message: HerdrResponse): unknown {
  if (typeof message.params === "object" && message.params !== null) {
    const params = message.params as { event?: unknown };
    return params.event ?? message.params;
  }
  return message.result ?? message;
}
