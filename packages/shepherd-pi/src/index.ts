import { type Socket, createConnection } from "node:net";

type WorkerEventWireRecord = {
  createdAt?: string;
  id: number;
  observedWorkspaceId?: string;
  payload: unknown;
  type: string;
  workerId?: string | null;
};

type ShepherdDaemonClient = {
  close(): void;
  request(method: string, params: unknown): Promise<unknown>;
};

type ShepherdState = {
  client: ShepherdDaemonClient | undefined;
  currentObservedWorkspaceId: string | undefined;
  currentSubscriptionId: string | undefined;
  lastAssistantText: string;
  pendingNotifications: WorkerEventWireRecord[];
  sessionRef: { agent: string; kind: "path"; source: string; value: string } | undefined;
  toolStartTimes: Map<string, { inputPreview?: string; startedAt: number; toolName: string }>;
};

type PiContext = {
  isIdle?: () => boolean;
  sessionManager: { getSessionFile(): string; getSessionId(): string };
  ui: { setStatus?: (key: string, value?: string) => void; setWidget?: (key: string, value?: unknown) => void };
};

type PiApi = {
  appendEntry?: (customType: string, data: unknown) => void;
  on: (eventName: string, handler: (...args: any[]) => unknown) => void;
  registerCommand?: (name: string, options: unknown) => void;
  registerTool?: (tool: unknown) => void;
  sendUserMessage?: (message: string) => void;
  setSessionName?: (name: string) => void;
};

type ExtensionOptions = {
  autoResume?: boolean;
  clientFactory?: () => ShepherdDaemonClient;
};

const DEFAULT_HOME_NAME = ".shepherd";
const MAX_EXCERPT = 4096;

function defaultShepherdHome() {
  return process.env.SHEPHERD_HOME || `${process.env.HOME || ""}/${DEFAULT_HOME_NAME}`;
}

export function defaultSocketPath() {
  return `${defaultShepherdHome().replace(/\/$/, "")}/shepherd.sock`;
}

export function createShepherdPiExtension(options: ExtensionOptions = {}) {
  return function shepherdPiExtension(pi: PiApi): void {
    const state: ShepherdState = {
      client: undefined,
      currentObservedWorkspaceId: undefined,
      currentSubscriptionId: undefined,
      lastAssistantText: "",
      pendingNotifications: [],
      sessionRef: undefined,
      toolStartTimes: new Map(),
    };

    pi.on("session_start", async (_event: unknown, ctx: PiContext) => {
      state.client = options.clientFactory?.() ?? new JsonLineDaemonClient(defaultSocketPath());
      state.sessionRef = {
        agent: "pi",
        kind: "path",
        source: "herdr:pi",
        value: ctx.sessionManager.getSessionFile(),
      };

      if (process.env.HERDR_ENV === "1" && process.env.HERDR_SOCKET_PATH && process.env.HERDR_WORKSPACE_ID) {
        const observed = (await state.client.request("workspace.observe", {
          socketPath: process.env.HERDR_SOCKET_PATH,
          workspaceId: process.env.HERDR_WORKSPACE_ID,
        })) as { observedWorkspace?: { id?: string } };
        if (observed.observedWorkspace?.id) {
          state.currentObservedWorkspaceId = observed.observedWorkspace.id;
        }
      }

      if (state.currentObservedWorkspaceId) {
        const subscription = (await state.client.request("notification.subscribe", {
          autoResume: options.autoResume ?? false,
          observedWorkspaceId: state.currentObservedWorkspaceId,
          subscriberId: ctx.sessionManager.getSessionId(),
          subscriberKind: "pi",
        })) as { events?: WorkerEventWireRecord[]; subscription?: { id?: string } };
        if (subscription.subscription?.id) {
          state.currentSubscriptionId = subscription.subscription.id;
        }
        state.pendingNotifications.push(...(subscription.events ?? []));
      }
    });

    pi.on("session_shutdown", () => {
      state.client?.close();
      state.client = undefined;
    });

    pi.on("tool_execution_start", (event: Record<string, unknown>) => {
      const toolCallId = stringValue(event.toolCallId) ?? stringValue(event.id);
      if (!toolCallId) return;
      state.toolStartTimes.set(toolCallId, {
        inputPreview: sanitize(event.input ?? event.arguments).text,
        startedAt: Date.now(),
        toolName: stringValue(event.toolName) ?? stringValue(event.name) ?? "unknown",
      });
    });

    pi.on("tool_result", async (event: Record<string, unknown>) => {
      if (!state.client || !state.currentObservedWorkspaceId) return;
      const toolCallId = stringValue(event.toolCallId) ?? stringValue(event.id) ?? "unknown";
      const started = state.toolStartTimes.get(toolCallId);
      const output = sanitize(event.content ?? event.output ?? event.details ?? "");
      await state.client.request("runtime.telemetry", {
        event: {
          artifactRefs: [`pi-session:${state.sessionRef?.value ?? "unknown"}#tool=${toolCallId}`],
          durationMs: started ? Date.now() - started.startedAt : undefined,
          ...(event.isError === true ? { errorExcerpt: output.text } : { outputExcerpt: output.text }),
          inputPreview: started?.inputPreview,
          isError: event.isError === true,
          occurredAt: new Date().toISOString(),
          redactionApplied: output.redacted,
          runtime: "pi",
          sessionRef: state.sessionRef ?? null,
          toolCallId,
          toolName: stringValue(event.toolName) ?? started?.toolName ?? "unknown",
          turnId: stringValue(event.turnId) ?? "unknown-turn",
          type: "worker.tool.completed",
          workerKey: null,
        },
        observedWorkspaceId: state.currentObservedWorkspaceId,
      });
    });

    pi.on("message_end", async (event: Record<string, unknown>) => {
      if (!state.client || !state.currentObservedWorkspaceId) return;
      const excerpt = sanitize(event.text ?? event.content ?? "");
      state.lastAssistantText = excerpt.text;
      await state.client.request("runtime.telemetry", {
        event: {
          evidenceRefs: [`pi-session:${state.sessionRef?.value ?? "unknown"}#message=final`],
          occurredAt: new Date().toISOString(),
          redactionApplied: excerpt.redacted,
          runtime: "pi",
          sessionRef: state.sessionRef ?? null,
          stopReason: stringValue(event.stopReason) ?? "stop",
          textExcerpt: excerpt.text,
          turnId: stringValue(event.turnId) ?? "unknown-turn",
          type: "worker.message.final",
          workerKey: null,
        },
        observedWorkspaceId: state.currentObservedWorkspaceId,
      });
    });

    pi.on("worker.event", async (message: { event?: WorkerEventWireRecord }, ctx?: PiContext) => {
      if (!message.event) return;
      state.pendingNotifications.push(message.event);
      ctx?.ui.setStatus?.("shepherd", `${state.pendingNotifications.length} unread worker event${state.pendingNotifications.length === 1 ? "" : "s"}`);
      ctx?.ui.setWidget?.("shepherd", { unread: state.pendingNotifications.length });
      pi.appendEntry?.("shepherd.notification", message.event);

      if (options.autoResume && ctx?.isIdle?.() && shouldAutoResume(message.event)) {
        pi.sendUserMessage?.(`Shepherd worker notification: ${message.event.type} event ${message.event.id}`);
      }
    });

    pi.on("before_agent_start", async () => {
      if (state.pendingNotifications.length === 0) return {};
      const notifications = [...state.pendingNotifications];
      state.pendingNotifications = [];
      if (state.client && state.currentSubscriptionId) {
        for (const event of notifications) {
          await state.client.request("notification.ack", {
            eventId: event.id,
            subscriptionId: state.currentSubscriptionId,
          });
        }
      }
      return { hiddenContext: formatHiddenNotifications(notifications) };
    });
  };
}

export default createShepherdPiExtension();

export function formatHiddenNotifications(events: WorkerEventWireRecord[]): string {
  return [
    "[SHEPHERD WORKER NOTIFICATIONS]",
    ...events.map((event) => {
      const payload = typeof event.payload === "object" && event.payload !== null ? (event.payload as Record<string, unknown>) : {};
      const summary = stringValue(payload.summary) ?? stringValue(payload.completion) ?? stringValue(payload.blockedReason) ?? `event ${event.id}`;
      return `- ${event.type} ${event.workerId ?? "workspace"}: ${summary}. Evidence: event ${event.id}`;
    }),
    "Use shepherd snapshot if details are needed.",
  ].join("\n");
}

function shouldAutoResume(event: WorkerEventWireRecord): boolean {
  return event.type === "worker.completed" || event.type === "worker.blocked" || event.type === "worker.needs_input";
}

function sanitize(value: unknown): { redacted: boolean; text: string } {
  let text = typeof value === "string" ? value : JSON.stringify(value);
  if (text === undefined) text = String(value);
  let redacted = false;
  for (const pattern of [/(Authorization:\s*Bearer\s+)[^\s]+/gi, /\b(token=)[^\s&]+/gi, /\b(password=)[^\s&]+/gi, /\b(secret=)[^\s&]+/gi, /\b(api_key=)[^\s&]+/gi]) {
    text = text.replace(pattern, (_match, prefix: string) => {
      redacted = true;
      return `${prefix}[REDACTED]`;
    });
  }
  return { redacted, text: text.slice(0, MAX_EXCERPT) };
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

type Pending = { reject(error: Error): void; resolve(value: unknown): void };

class JsonLineDaemonClient implements ShepherdDaemonClient {
  readonly #pending = new Map<string, Pending>();
  readonly #socket: Socket;
  #buffer = "";
  #nextId = 1;

  constructor(socketPath: string) {
    this.#socket = createConnection(socketPath);
    this.#socket.on("data", (chunk) => this.#handleData(chunk.toString("utf8")));
    this.#socket.on("error", (error) => this.#rejectAll(error));
    this.#socket.on("close", () => this.#rejectAll(new Error("Shepherd daemon socket closed")));
  }

  close(): void {
    this.#socket.destroy();
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = `pi-${this.#nextId++}`;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { reject, resolve });
      this.#socket.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  #handleData(chunk: string): void {
    this.#buffer += chunk;
    let newline = this.#buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      newline = this.#buffer.indexOf("\n");
      if (!line) continue;
      const response = JSON.parse(line) as { error?: { message?: string }; id?: string; result?: unknown };
      if (!response.id) continue;
      const pending = this.#pending.get(response.id);
      if (!pending) continue;
      this.#pending.delete(response.id);
      if (response.error) pending.reject(new Error(response.error.message ?? "Shepherd daemon error"));
      else pending.resolve(response.result);
    }
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}
