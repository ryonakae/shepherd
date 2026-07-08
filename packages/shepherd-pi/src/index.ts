import { type Socket, createConnection } from "node:net";

type AgentEventWireRecord = {
  agentId?: string | null;
  compactHistory?: CompactAgentHistory | null;
  id: number;
  payload: unknown;
  paneId?: string | null;
  type: string;
  workspaceId?: string | null;
};

type CompactAgentHistory = {
  lastAssistantMessage?: { text?: string | null } | null;
  lastToolResult?: { text?: string; toolName?: string } | null;
  lastUserMessage?: { text?: string | null } | null;
  updatedAt?: string | null;
};

type AgentListItem = {
  agent?: string | null;
  agentStatus?: string;
  history?: CompactAgentHistory;
  paneId?: string;
};

type ShepherdDaemonClient = {
  close(): void;
  onAgentEvent: ((event: AgentEventWireRecord) => void) | undefined;
  request(method: string, params: unknown): Promise<unknown>;
};

type ShepherdState = {
  client: ShepherdDaemonClient | undefined;
  currentSubscriptionId: string | undefined;
  currentWorkspaceId: string | undefined;
  pendingEvents: AgentEventWireRecord[];
  sessionRef: { agent: string; kind: "path"; source: string; value: string } | undefined;
  toolStartTimes: Map<string, { inputPreview?: string; startedAt: number; toolName: string }>;
};

type PiContext = {
  isIdle?: () => boolean;
  sessionManager: { getSessionFile(): string; getSessionId(): string };
  ui: {
    setStatus?: (key: string, value?: string) => void;
    setWidget?: (key: string, value?: unknown) => void;
  };
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
      currentSubscriptionId: undefined,
      currentWorkspaceId: undefined,
      pendingEvents: [],
      sessionRef: undefined,
      toolStartTimes: new Map(),
    };

    pi.on("session_start", async (_event: unknown, ctx: PiContext) => {
      state.client = options.clientFactory?.() ?? new JsonLineDaemonClient(defaultSocketPath());
      state.client.onAgentEvent = (event) => handleAgentEvent(event, ctx, pi, state, options);
      state.sessionRef = {
        agent: "pi",
        kind: "path",
        source: "herdr:pi",
        value: ctx.sessionManager.getSessionFile(),
      };
      state.currentWorkspaceId =
        process.env.HERDR_ENV === "1" && process.env.HERDR_WORKSPACE_ID
          ? process.env.HERDR_WORKSPACE_ID
          : undefined;
      if (state.currentWorkspaceId) {
        const subscription = (await state.client.request("agent.notifications.subscribe", {
          autoResume: options.autoResume ?? false,
          subscriberId: ctx.sessionManager.getSessionId(),
          subscriberKind: "pi",
          workspaceId: state.currentWorkspaceId,
        })) as { events?: AgentEventWireRecord[]; subscription?: { id?: string } };
        if (subscription.subscription?.id) state.currentSubscriptionId = subscription.subscription.id;
        state.pendingEvents.push(...(subscription.events ?? []));
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
      if (!state.client || !state.currentWorkspaceId) return;
      const toolCallId = stringValue(event.toolCallId) ?? stringValue(event.id) ?? "unknown";
      const started = state.toolStartTimes.get(toolCallId);
      const output = sanitize(event.content ?? event.output ?? event.details ?? "");
      await state.client.request("agent.telemetry", {
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
          type: "agent.tool.completed",
        },
        workspaceId: state.currentWorkspaceId,
      });
    });

    pi.on("message_end", async (event: Record<string, unknown>) => {
      if (!state.client || !state.currentWorkspaceId) return;
      const excerpt = sanitize(event.text ?? event.content ?? "");
      await state.client.request("agent.telemetry", {
        event: {
          evidenceRefs: [`pi-session:${state.sessionRef?.value ?? "unknown"}#message=final`],
          occurredAt: new Date().toISOString(),
          redactionApplied: excerpt.redacted,
          runtime: "pi",
          sessionRef: state.sessionRef ?? null,
          stopReason: stringValue(event.stopReason) ?? "stop",
          textExcerpt: excerpt.text,
          turnId: stringValue(event.turnId) ?? "unknown-turn",
          type: "agent.message.final",
        },
        workspaceId: state.currentWorkspaceId,
      });
    });

    pi.on("agent.event", async (message: { event?: AgentEventWireRecord }, ctx?: PiContext) => {
      if (!message.event) return;
      handleAgentEvent(message.event, ctx, pi, state, options);
    });

    pi.on("before_agent_start", async () => {
      if (!state.client || !state.currentWorkspaceId) return {};
      let agents: AgentListItem[] = [];
      try {
        const response = (await state.client.request("agent.list", {
          workspaceId: state.currentWorkspaceId,
        })) as { agents?: AgentListItem[] };
        agents = response.agents ?? [];
      } catch {
        return {};
      }
      const events = [...state.pendingEvents];
      state.pendingEvents = [];
      if (state.currentSubscriptionId) {
        for (const event of events) {
          await state.client.request("agent.notifications.ack", {
            eventId: event.id,
            subscriptionId: state.currentSubscriptionId,
          });
        }
      }
      return {
        message: {
          content: [
            formatHiddenAgentContext({ agents, workspaceId: state.currentWorkspaceId }),
            events.length > 0 ? formatHiddenAgentUpdates(events) : "",
          ]
            .filter(Boolean)
            .join("\n\n"),
          customType: "shepherd-agent-context",
          display: false,
        },
      };
    });
  };
}

export default createShepherdPiExtension();

export function formatHiddenAgentContext(input: { agents: AgentListItem[]; workspaceId: string }): string {
  return [
    "[SHEPHERD AGENT CONTEXT]",
    `Current Herdr workspace: ${input.workspaceId}`,
    ...input.agents.map((agent) => {
      const history = agent.history ?? {};
      return [
        `- ${agent.agent ?? "unknown"} ${agent.paneId ?? "unknown"} ${agent.agentStatus ?? "unknown"}`,
        `  last user: ${oneLine(history.lastUserMessage?.text ?? "")}`,
        `  last assistant: ${oneLine(history.lastAssistantMessage?.text ?? "")}`,
      ].join("\n");
    }),
    "Use shepherd agent get/read if details are needed.",
  ].join("\n");
}

export function formatHiddenAgentUpdates(events: AgentEventWireRecord[]): string {
  return [
    "[SHEPHERD AGENT UPDATES]",
    ...events.map((event) => {
      const payload = record(event.payload);
      const history = event.compactHistory ?? {};
      return [
        `- ${event.type} ${stringValue(payload.agent) ?? "unknown"} ${event.paneId ?? "unknown"}`,
        `  last assistant: ${oneLine(history.lastAssistantMessage?.text ?? "")}`,
        `  event: ${event.id}`,
      ].join("\n");
    }),
  ].join("\n");
}

function handleAgentEvent(
  event: AgentEventWireRecord,
  ctx: PiContext | undefined,
  pi: PiApi,
  state: ShepherdState,
  options: ExtensionOptions,
): void {
  state.pendingEvents.push(event);
  ctx?.ui.setStatus?.("shepherd", `${state.pendingEvents.length} unread agent event${state.pendingEvents.length === 1 ? "" : "s"}`);
  ctx?.ui.setWidget?.("shepherd", { unread: state.pendingEvents.length });
  pi.appendEntry?.("shepherd.agent_event", event);
  if (options.autoResume && ctx?.isIdle?.() && shouldAutoResume(event)) {
    pi.sendUserMessage?.(`Shepherd agent notification: ${event.type} event ${event.id}`);
  }
}

function shouldAutoResume(event: AgentEventWireRecord): boolean {
  return event.type === "agent.done" || event.type === "agent.blocked" || event.type === "agent.idle";
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

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").slice(0, 240);
}

type Pending = { reject(error: Error): void; resolve(value: unknown): void };

class JsonLineDaemonClient implements ShepherdDaemonClient {
  onAgentEvent: ((event: AgentEventWireRecord) => void) | undefined;
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
      const message = JSON.parse(line) as { error?: { message?: string }; id?: string; method?: string; params?: unknown; result?: unknown };
      if (message.method === "agent.event") {
        const event = record(record(message.params).event) as AgentEventWireRecord;
        if (typeof event.id === "number" && typeof event.type === "string") this.onAgentEvent?.(event);
        continue;
      }
      if (!message.id) continue;
      const pending = this.#pending.get(message.id);
      if (!pending) continue;
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message ?? "Shepherd RPC failed"));
      else pending.resolve(message.result);
    }
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}
