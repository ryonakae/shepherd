import {
  type AgentEventWireRecord,
  type AgentOrchestratorChanged,
  type AgentOrchestratorWireState,
  type DaemonStreamMessage,
  ReconnectingDaemonClient,
} from "./daemon-client.js";

type AgentListItem = {
  agent?: string | null;
  agentStatus?: string;
  history?: {
    lastAssistantMessage?: { text?: string | null } | null;
    lastUserMessage?: { text?: string | null } | null;
  };
  paneId?: string;
};

type AgentSessionRef = {
  agent: string;
  kind: "path";
  source: string;
  value: string;
};

type PiPresence = {
  autoResume: boolean;
  connectedAt: number;
  herdrSessionName: string;
  paneId: string;
  subscriberId: string;
  terminalId: string;
  workspaceId: string;
};

type ConnectionStateResponse = {
  changed?: boolean;
  events?: AgentEventWireRecord[];
  presence: PiPresence;
  state: AgentOrchestratorWireState | null;
};

export type ShepherdDaemonClient = {
  close(): void;
  onConnected: (() => Promise<void> | void) | undefined;
  onDisconnected: ((error: Error) => void) | undefined;
  onStreamMessage: ((message: DaemonStreamMessage) => void) | undefined;
  request(method: string, params: unknown): Promise<unknown>;
};

type CurrentScope = {
  herdrSessionName: string;
  paneId: string;
  terminalId: string;
  workspaceId: string;
};

type LaunchIdentity = {
  herdrSocketPath: string;
  paneId: string;
  workspaceId: string;
};

type ShepherdState = {
  client: ShepherdDaemonClient | undefined;
  connected: boolean;
  currentScope: CurrentScope | undefined;
  isOrchestrator: boolean;
  launchIdentity: LaunchIdentity | undefined;
  pendingEvents: AgentEventWireRecord[];
  registrationInFlight: Promise<void> | undefined;
  roleMutationInFlight: boolean;
  sessionRef: AgentSessionRef | undefined;
  subscriberId: string | undefined;
  toolStartTimes: Map<string, { inputPreview?: string; startedAt: number; toolName: string }>;
};

type PiContext = {
  isIdle?: () => boolean;
  sessionManager: { getSessionFile(): string; getSessionId(): string };
  ui: {
    notify?: (message: string, level?: "error" | "info" | "warning") => void;
    setStatus?: (key: string, value?: string) => void;
    setWidget?: (key: string, value?: unknown) => void;
  };
};

type CommandOptions = {
  description: string;
  getArgumentCompletions?(prefix: string): Array<{ label: string; value: string }> | null;
  handler(args: string, ctx: PiContext): Promise<void>;
};

type PiApi = {
  appendEntry?: (customType: string, data: unknown) => void;
  on: (eventName: string, handler: (...args: any[]) => unknown) => void;
  registerCommand?: (name: string, options: CommandOptions) => void;
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
const COMMAND_USAGE = "Usage: /shepherd orchestrator [on|off|status]";
const UNAVAILABLE_MESSAGE =
  "Shepherd orchestrator is unavailable until this Pi reconnects to the daemon";

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
      connected: false,
      currentScope: undefined,
      isOrchestrator: false,
      launchIdentity: undefined,
      pendingEvents: [],
      registrationInFlight: undefined,
      roleMutationInFlight: false,
      sessionRef: undefined,
      subscriberId: undefined,
      toolStartTimes: new Map(),
    };
    let activeContext: PiContext | undefined;

    const setRoleUi = (ctx: PiContext | undefined) => {
      ctx?.ui.setStatus?.(
        "shepherd-orchestrator",
        state.isOrchestrator ? "Shepherd: orchestrator" : undefined,
      );
    };

    const setUnreadUi = (ctx: PiContext | undefined) => {
      const count = state.pendingEvents.length;
      ctx?.ui.setStatus?.(
        "shepherd",
        count > 0 ? `${count} unread agent event${count === 1 ? "" : "s"}` : undefined,
      );
      ctx?.ui.setWidget?.("shepherd", count > 0 ? { unread: count } : undefined);
    };

    const loseRole = (ctx: PiContext | undefined) => {
      state.isOrchestrator = false;
      state.pendingEvents = [];
      setRoleUi(ctx);
      setUnreadUi(ctx);
    };

    const addPendingEvents = (events: AgentEventWireRecord[], ctx: PiContext | undefined) => {
      const byId = new Map(state.pendingEvents.map((event) => [event.id, event]));
      for (const event of events) byId.set(event.id, event);
      state.pendingEvents = [...byId.values()].sort((left, right) => left.id - right.id);
      setUnreadUi(ctx);
    };

    const applyConnectionStateResponse = (
      response: ConnectionStateResponse,
      ctx: PiContext | undefined,
    ) => {
      state.currentScope = {
        herdrSessionName: response.presence.herdrSessionName,
        paneId: response.presence.paneId,
        terminalId: response.presence.terminalId,
        workspaceId: response.presence.workspaceId,
      };
      const isOwner =
        response.state?.owner?.terminalId === response.presence.terminalId &&
        response.state.herdrSessionName === response.presence.herdrSessionName &&
        response.state.workspaceId === response.presence.workspaceId;
      if (!isOwner) {
        loseRole(ctx);
        return;
      }
      state.isOrchestrator = true;
      setRoleUi(ctx);
      addPendingEvents(response.events ?? [], ctx);
    };

    const handleAgentEvent = (event: AgentEventWireRecord, ctx: PiContext | undefined) => {
      if (!state.isOrchestrator || !state.currentScope || !event.terminalId) return;
      if (event.terminalId === state.currentScope.terminalId) return;
      addPendingEvents([event], ctx);
      pi.appendEntry?.("shepherd.agent_event", event);
      if (options.autoResume && ctx?.isIdle?.() && shouldAutoResume(event)) {
        pi.sendUserMessage?.(`Shepherd agent notification: ${event.type} event ${event.id}`);
      }
    };

    const refreshAfterRoleGain = async (ctx: PiContext | undefined) => {
      if (!state.client || !state.connected) return;
      try {
        const response = (await state.client.request(
          "agent.orchestrator.get",
          {},
        )) as ConnectionStateResponse;
        applyConnectionStateResponse(response, ctx);
      } catch {
        // Reconnect handling owns transport failures.
      }
    };

    const handleRoleChange = (change: AgentOrchestratorChanged, ctx: PiContext | undefined) => {
      const terminalId = state.currentScope?.terminalId;
      if (!terminalId) return;
      const wasOwner = change.previous.owner?.terminalId === terminalId;
      const isOwner = change.current.owner?.terminalId === terminalId;
      if (isOwner && change.current.owner) {
        const scopeChanged =
          state.currentScope?.herdrSessionName !== change.current.herdrSessionName ||
          state.currentScope?.workspaceId !== change.current.workspaceId;
        state.currentScope = {
          herdrSessionName: change.current.herdrSessionName,
          paneId: change.current.owner.paneId,
          terminalId,
          workspaceId: change.current.workspaceId,
        };
        const gainedRole = !state.isOrchestrator;
        state.isOrchestrator = true;
        setRoleUi(ctx);
        if (gainedRole || scopeChanged) void refreshAfterRoleGain(ctx);
        return;
      }
      if (!wasOwner) return;
      state.currentScope = {
        herdrSessionName: change.current.herdrSessionName,
        paneId: state.currentScope?.paneId ?? change.previous.owner?.paneId ?? "unknown",
        terminalId,
        workspaceId: change.current.workspaceId,
      };
      loseRole(ctx);
      if (!state.roleMutationInFlight) {
        ctx?.ui.notify?.(
          change.current.owner
            ? `Shepherd orchestrator moved to ${change.current.owner.paneId}`
            : "Shepherd orchestrator is now off for this workspace",
          "info",
        );
      }
    };

    const handleStreamMessage = (message: DaemonStreamMessage) => {
      if (message.method === "agent.event") {
        handleAgentEvent(message.params.event, activeContext);
        return;
      }
      handleRoleChange(message.params.change, activeContext);
    };

    const registerPresence = (ctx: PiContext): Promise<void> => {
      if (state.registrationInFlight) return state.registrationInFlight;
      const client = state.client;
      const launchIdentity = state.launchIdentity;
      const subscriberId = state.subscriberId;
      if (!client || !launchIdentity || !subscriberId) return Promise.resolve();
      const registration = client
        .request("agent.orchestrator.register", {
          autoResume: options.autoResume ?? false,
          herdrSocketPath: launchIdentity.herdrSocketPath,
          paneId: state.currentScope?.paneId ?? launchIdentity.paneId,
          subscriberId,
          subscriberKind: "pi",
          workspaceId: state.currentScope?.workspaceId ?? launchIdentity.workspaceId,
        })
        .then((response) => {
          state.connected = true;
          ctx.ui.setStatus?.("shepherd-connection", undefined);
          applyConnectionStateResponse(response as ConnectionStateResponse, ctx);
        })
        .catch((error) => {
          state.connected = false;
          loseRole(ctx);
          ctx.ui.setStatus?.("shepherd-connection", "Shepherd: reconnecting");
          throw error;
        })
        .finally(() => {
          state.registrationInFlight = undefined;
        });
      state.registrationInFlight = registration;
      return registration;
    };

    pi.registerCommand?.("shepherd", {
      description: "Manage the Shepherd orchestrator for this Herdr workspace",
      getArgumentCompletions(prefix: string) {
        const values = [
          "orchestrator",
          "orchestrator on",
          "orchestrator off",
          "orchestrator status",
        ];
        const items = values
          .filter((value) => value.startsWith(prefix))
          .map((value) => ({ label: value, value }));
        return items.length > 0 ? items : null;
      },
      handler: async (args: string, ctx: PiContext) => {
        const tokens = args.trim().split(/\s+/).filter(Boolean);
        const action =
          tokens.length === 1 && tokens[0] === "orchestrator"
            ? "status"
            : tokens.length === 2 && tokens[0] === "orchestrator"
              ? tokens[1]
              : undefined;
        if (action !== "on" && action !== "off" && action !== "status") {
          ctx.ui.notify?.(COMMAND_USAGE, "warning");
          return;
        }
        if (!state.client || !state.connected || !state.currentScope) {
          ctx.ui.notify?.(UNAVAILABLE_MESSAGE, "error");
          return;
        }
        try {
          if (action === "status") {
            const response = (await state.client.request(
              "agent.orchestrator.get",
              {},
            )) as ConnectionStateResponse;
            applyConnectionStateResponse(response, ctx);
            notifyStatus(response, ctx);
            return;
          }
          state.roleMutationInFlight = true;
          const response = (await state.client.request("agent.orchestrator.set", {
            enabled: action === "on",
          })) as ConnectionStateResponse;
          applyConnectionStateResponse(response, ctx);
          if (action === "off" && response.changed === false) {
            ctx.ui.notify?.("This Pi is not the Shepherd orchestrator", "info");
          } else {
            notifyStatus(response, ctx);
          }
        } catch (error) {
          ctx.ui.notify?.(error instanceof Error ? error.message : String(error), "error");
        } finally {
          state.roleMutationInFlight = false;
        }
      },
    });

    pi.on("session_start", (_event: unknown, ctx: PiContext) => {
      activeContext = ctx;
      state.subscriberId = ctx.sessionManager.getSessionId();
      state.sessionRef = {
        agent: "pi",
        kind: "path",
        source: "herdr:pi",
        value: ctx.sessionManager.getSessionFile(),
      };
      state.launchIdentity = herdrLaunchIdentity(process.env);
      if (!state.launchIdentity) {
        state.connected = false;
        loseRole(ctx);
        return;
      }
      state.client?.close();
      const client = options.clientFactory?.() ?? new ReconnectingDaemonClient({ socketPath: defaultSocketPath() });
      state.client = client;
      client.onConnected = () => registerPresence(ctx);
      client.onDisconnected = () => {
        state.connected = false;
        loseRole(activeContext);
        activeContext?.ui.setStatus?.("shepherd-connection", "Shepherd: reconnecting");
      };
      client.onStreamMessage = handleStreamMessage;
    });

    pi.on("session_shutdown", () => {
      state.connected = false;
      loseRole(activeContext);
      state.client?.close();
      state.client = undefined;
      activeContext = undefined;
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
      if (!state.client || !state.connected || !state.currentScope) return;
      const toolCallId = stringValue(event.toolCallId) ?? stringValue(event.id) ?? "unknown";
      const started = state.toolStartTimes.get(toolCallId);
      state.toolStartTimes.delete(toolCallId);
      const output = sanitize(event.content ?? event.output ?? event.details ?? "");
      try {
        await state.client.request("agent.telemetry", {
          event: {
            artifactRefs: [`pi-session:${state.sessionRef?.value ?? "unknown"}#tool=${toolCallId}`],
            durationMs: started ? Date.now() - started.startedAt : undefined,
            ...(event.isError === true
              ? { errorExcerpt: output.text }
              : { outputExcerpt: output.text }),
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
          workspaceId: state.currentScope.workspaceId,
        });
      } catch {
        // Telemetry is best effort.
      }
    });

    pi.on("message_end", async (event: Record<string, unknown>) => {
      if (!state.client || !state.connected || !state.currentScope) return;
      const excerpt = sanitize(event.text ?? event.content ?? "");
      try {
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
          workspaceId: state.currentScope.workspaceId,
        });
      } catch {
        // Telemetry is best effort.
      }
    });

    pi.on("before_agent_start", async () => {
      if (!state.client || !state.connected || !state.currentScope) return {};
      try {
        const status = (await state.client.request(
          "agent.orchestrator.get",
          {},
        )) as ConnectionStateResponse;
        applyConnectionStateResponse(status, activeContext);
        if (!state.currentScope) return {};
        const response = (await state.client.request("agent.list", {
          herdrSessionName: state.currentScope.herdrSessionName,
          workspaceId: state.currentScope.workspaceId,
        })) as { agents?: AgentListItem[] };
        const events = state.isOrchestrator ? [...state.pendingEvents] : [];
        const content = [
          formatHiddenAgentContext({
            agents: response.agents ?? [],
            workspaceId: state.currentScope.workspaceId,
          }),
          events.length > 0 ? formatHiddenAgentUpdates(events) : "",
        ]
          .filter(Boolean)
          .join("\n\n");
        for (const event of events) {
          try {
            await state.client.request("agent.notifications.ack", { eventId: event.id });
            state.pendingEvents = state.pendingEvents.filter((pending) => pending.id !== event.id);
          } catch {
            break;
          }
        }
        setUnreadUi(activeContext);
        return {
          message: {
            content,
            customType: "shepherd-agent-context",
            display: false,
          },
        };
      } catch {
        return {};
      }
    });
  };
}

export default createShepherdPiExtension();

export function formatHiddenAgentContext(input: {
  agents: AgentListItem[];
  workspaceId: string;
}): string {
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

function notifyStatus(response: ConnectionStateResponse, ctx: PiContext): void {
  const scope = `${response.presence.herdrSessionName}/${response.presence.workspaceId}`;
  if (!response.state?.owner) {
    ctx.ui.notify?.(`No Shepherd orchestrator is set for ${scope}`, "info");
    return;
  }
  if (response.state.owner.terminalId === response.presence.terminalId) {
    ctx.ui.notify?.(
      `This Pi is the Shepherd orchestrator for ${scope} (${response.state.owner.paneId})`,
      "info",
    );
    return;
  }
  ctx.ui.notify?.(
    `Shepherd orchestrator for ${scope} is ${response.state.owner.paneId}`,
    "info",
  );
}

function herdrLaunchIdentity(environment: NodeJS.ProcessEnv): LaunchIdentity | undefined {
  if (environment.HERDR_ENV !== "1") return undefined;
  const herdrSocketPath = stringValue(environment.HERDR_SOCKET_PATH);
  const paneId = stringValue(environment.HERDR_PANE_ID);
  const workspaceId = stringValue(environment.HERDR_WORKSPACE_ID);
  if (!herdrSocketPath || !paneId || !workspaceId) return undefined;
  return { herdrSocketPath, paneId, workspaceId };
}

function shouldAutoResume(event: AgentEventWireRecord): boolean {
  return event.type === "agent.done" || event.type === "agent.blocked" || event.type === "agent.idle";
}

function sanitize(value: unknown): { redacted: boolean; text: string } {
  let text = typeof value === "string" ? value : JSON.stringify(value);
  if (text === undefined) text = String(value);
  let redacted = false;
  for (const pattern of [
    /(Authorization:\s*Bearer\s+)[^\s]+/gi,
    /\b(token=)[^\s&]+/gi,
    /\b(password=)[^\s&]+/gi,
    /\b(secret=)[^\s&]+/gi,
    /\b(api_key=)[^\s&]+/gi,
  ]) {
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
