import { createConnection, type Socket } from "node:net";
import { encodeJsonLine, JsonLineDecoder } from "@/shared/json-lines.js";

export type HerdrRequestId = string;

export type HerdrSocketClientOptions = {
  socketPath: string;
};

type PendingRequest = {
  reject: (error: Error) => void;
  resolve: (value: unknown) => void;
};

type HerdrResponse = {
  data?: unknown;
  error?: { message?: string };
  event?: string;
  id?: string;
  method?: string;
  params?: unknown;
  result?: unknown;
};

type EventSubscriber = {
  fail(error: Error): void;
  push(event: unknown): void;
};

export class HerdrSocketClient {
  readonly #decoder = new JsonLineDecoder();
  readonly #pending = new Map<HerdrRequestId, PendingRequest>();
  readonly #subscribers = new Set<EventSubscriber>();
  readonly #socket: Socket;
  readonly #socketPath: string;
  #nextId = 1;

  constructor(options: HerdrSocketClientOptions) {
    this.#socketPath = options.socketPath;
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

  async sessionSnapshot(): Promise<unknown> {
    try {
      return await this.#requestOnce("session.snapshot");
    } catch (error) {
      if (!isUnsupportedSessionSnapshotError(error)) {
        throw error;
      }
    }

    const [workspacesResult, panesResult, tabsResult, agentsResult] = await Promise.all([
      this.#requestOnce("workspace.list"),
      this.#requestOnce("pane.list"),
      this.#requestOnce("tab.list"),
      this.#requestOnce("agent.list"),
    ]);
    const workspaces = arrayProperty(workspacesResult, "workspaces");
    const panes = arrayProperty(panesResult, "panes");
    const tabs = arrayProperty(tabsResult, "tabs");
    const agents = arrayProperty(agentsResult, "agents");

    return {
      snapshot: {
        agents,
        ...focusedId("focused_pane_id", panes, "pane_id"),
        ...focusedId("focused_workspace_id", workspaces, "workspace_id"),
        panes,
        tabs,
        workspaces,
      },
    };
  }

  async *subscribeEvents(
    params: { paneIds?: string[]; workspaceId?: string } = {},
    options: { signal?: AbortSignal } = {},
  ): AsyncIterable<unknown> {
    const queue: unknown[] = [];
    let failure: Error | undefined;
    let wake: (() => void) | undefined;
    const subscriber: EventSubscriber = {
      fail(error) {
        failure ??= error;
        wake?.();
        wake = undefined;
      },
      push(event) {
        queue.push(event);
        wake?.();
        wake = undefined;
      },
    };
    if (options.signal?.aborted) return;
    this.#subscribers.add(subscriber);
    try {
      await this.request("events.subscribe", {
        subscriptions: (params.paneIds ?? []).map((pane_id) => ({
          pane_id,
          type: "pane.agent_status_changed" as const,
        })),
      });
      if (options.signal?.aborted) return;
      while (!options.signal?.aborted) {
        if (failure) throw failure;
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            wake = resolve;
            options.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
        }
        if (failure) throw failure;
        while (queue.length > 0) {
          yield queue.shift();
        }
      }
    } finally {
      this.#subscribers.delete(subscriber);
    }
  }

  #requestOnce(method: string, params: unknown = {}): Promise<unknown> {
    const id = `shepherd-${this.#nextId}`;
    this.#nextId += 1;

    return new Promise((resolve, reject) => {
      const decoder = new JsonLineDecoder();
      const socket = createConnection(this.#socketPath);
      let settled = false;
      const finish = (result: { error?: Error; value?: unknown }) => {
        if (settled) {
          return;
        }
        settled = true;
        socket.destroy();
        if (result.error) {
          reject(result.error);
          return;
        }
        resolve(result.value);
      };

      socket.on("connect", () => socket.write(encodeJsonLine({ id, method, params })));
      socket.on("data", (chunk) => {
        for (const message of decoder.push(chunk.toString("utf8"))) {
          const response = message as HerdrResponse;
          if (response.error) {
            finish({ error: new Error(response.error.message ?? "Herdr request failed") });
            return;
          }
          if (response.id === id) {
            finish({ value: response.result });
            return;
          }
        }
      });
      socket.on("error", (error) => finish({ error }));
      socket.on("close", () => finish({ error: new Error("Herdr socket closed") }));
    });
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
    for (const subscriber of this.#subscribers) {
      subscriber.fail(error);
    }
  }
}

function notificationEvent(message: HerdrResponse): unknown {
  if (typeof message.event === "string" && isRecord(message.data)) {
    return {
      ...message.data,
      type: normalizeEventName(message.event),
    };
  }
  if (isRecord(message.params)) {
    return notificationPayload(message.params.event ?? message.params);
  }
  return notificationPayload(message.result ?? message);
}

function notificationPayload(value: unknown): unknown {
  if (!isRecord(value) || typeof value.event !== "string" || !isRecord(value.data)) return value;
  return {
    ...value.data,
    type: normalizeEventName(value.event),
  };
}

function normalizeEventName(value: string): string {
  return value.includes(".") ? value : value.replace("_", ".");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isUnsupportedSessionSnapshotError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.message.includes("session.snapshot") && error.message.includes("unknown variant");
}

function arrayProperty(value: unknown, key: string): unknown[] {
  if (typeof value !== "object" || value === null) {
    return [];
  }
  const property = (value as Record<string, unknown>)[key];
  return Array.isArray(property) ? property : [];
}

function focusedId(
  outputKey: string,
  records: unknown[],
  recordKey: string,
): Record<string, string> {
  const focused = records.find(
    (record) =>
      typeof record === "object" &&
      record !== null &&
      (record as { focused?: unknown }).focused === true,
  );
  if (typeof focused !== "object" || focused === null) {
    return {};
  }
  const id = (focused as Record<string, unknown>)[recordKey];
  return typeof id === "string" ? { [outputKey]: id } : {};
}
