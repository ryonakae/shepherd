import {
  type AgentEventWireRecord,
  type AgentOrchestratorChanged,
  type AgentOrchestratorWireState,
  type DaemonStreamMessage,
  ReconnectingDaemonClient,
} from "./daemon-client.js";
import {
  formatWorkerOutcomeUpdates,
  projectWorkerOutcomes,
  WAKE_SETTLE_MS,
} from "./wake.js";

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

type DeliveredBatch = {
  assistantFinalSucceeded: boolean;
  events: AgentEventWireRecord[];
  invalidated: boolean;
  ownerTerminalId: string;
  shepherdTriggered: boolean;
};

type ShepherdState = {
  client: ShepherdDaemonClient | undefined;
  connected: boolean;
  currentScope: CurrentScope | undefined;
  deliveredBatch: DeliveredBatch | undefined;
  failedWakeThroughEventId: number;
  isOrchestrator: boolean;
  launchIdentity: LaunchIdentity | undefined;
  pendingEvents: AgentEventWireRecord[];
  registrationInFlight: Promise<void> | undefined;
  roleMutationInFlight: boolean;
  sessionRef: AgentSessionRef | undefined;
  subscriberId: string | undefined;
  toolStartTimes: Map<string, { inputPreview?: string; startedAt: number; toolName: string }>;
  wakeDeferredUntilSettled: boolean;
  wakeRequested: boolean;
  wakeRequestedThroughEventId: number;
  wakeTimer: ReturnType<typeof setTimeout> | undefined;
};

type PiContext = {
  abort?: () => void;
  isIdle?: () => boolean;
  sessionManager: { getSessionFile(): string; getSessionId(): string };
  ui: {
    notify?: (message: string, level?: "error" | "info" | "warning") => void;
    setStatus?: (key: string, value?: string) => void;
    setWidget?: (key: string, value?: string[]) => void;
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
  sendMessage?: (
    message: { content: string; customType: string; details?: unknown; display: boolean },
    options?: { deliverAs?: "steer" | "followUp" | "nextTurn"; triggerTurn?: boolean },
  ) => void;
  setSessionName?: (name: string) => void;
};

type ExtensionOptions = {
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
      deliveredBatch: undefined,
      failedWakeThroughEventId: 0,
      isOrchestrator: false,
      launchIdentity: undefined,
      pendingEvents: [],
      registrationInFlight: undefined,
      roleMutationInFlight: false,
      sessionRef: undefined,
      subscriberId: undefined,
      toolStartTimes: new Map(),
      wakeDeferredUntilSettled: false,
      wakeRequested: false,
      wakeRequestedThroughEventId: 0,
      wakeTimer: undefined,
    };
    let activeContext: PiContext | undefined;
    let wakeGeneration = 0;

    const setRoleUi = (ctx: PiContext | undefined) => {
      ctx?.ui.setStatus?.(
        "shepherd-orchestrator",
        state.isOrchestrator ? "Shepherd: orchestrator" : undefined,
      );
    };

    const setPendingUi = (ctx: PiContext | undefined) => {
      const count = projectWorkerOutcomes(state.pendingEvents).outcomes.length;
      const label =
        count > 0 ? `${count} pending worker update${count === 1 ? "" : "s"}` : undefined;
      ctx?.ui.setStatus?.("shepherd", label);
      ctx?.ui.setWidget?.("shepherd", label ? [label] : undefined);
    };

    const cancelWakeTimer = () => {
      wakeGeneration += 1;
      if (state.wakeTimer) clearTimeout(state.wakeTimer);
      state.wakeTimer = undefined;
      state.wakeDeferredUntilSettled = false;
    };

    const cancelWake = () => {
      cancelWakeTimer();
      state.wakeRequested = false;
      state.wakeRequestedThroughEventId = 0;
    };

    const wakeLabel = (count: number) =>
      `Shepherd received ${count} worker update${count === 1 ? "" : "s"}.`;

    const scheduleWake = (ctx: PiContext | undefined) => {
      if (!ctx || !state.isOrchestrator || !state.currentScope || !pi.sendMessage) return;
      const outcomes = projectWorkerOutcomes(state.pendingEvents).outcomes;
      const wakeable = outcomes.filter(
        (outcome) => outcome.eventId > state.failedWakeThroughEventId,
      );
      if (wakeable.length === 0 || state.wakeTimer || state.wakeRequested) return;
      if (state.deliveredBatch || ctx.isIdle?.() === false) {
        state.wakeDeferredUntilSettled = true;
        return;
      }
      const generation = wakeGeneration;
      const ownerHerdrSessionName = state.currentScope.herdrSessionName;
      const ownerTerminalId = state.currentScope.terminalId;
      const ownerWorkspaceId = state.currentScope.workspaceId;
      state.wakeTimer = setTimeout(() => {
        const startWake = async () => {
          if (
            generation !== wakeGeneration ||
            !state.isOrchestrator ||
            state.currentScope?.herdrSessionName !== ownerHerdrSessionName ||
            state.currentScope?.terminalId !== ownerTerminalId ||
            state.currentScope?.workspaceId !== ownerWorkspaceId
          ) {
            state.wakeTimer = undefined;
            return;
          }
          if (ctx.isIdle?.() === false) {
            state.wakeTimer = undefined;
            state.wakeDeferredUntilSettled = true;
            return;
          }

          const requestedThroughEventId = wakeable.at(-1)?.eventId ?? 0;
          try {
            const response = (await state.client?.request(
              "agent.orchestrator.get",
              {},
            )) as ConnectionStateResponse | undefined;
            if (
              !response ||
              response.state?.owner?.terminalId !== ownerTerminalId ||
              response.state.herdrSessionName !== ownerHerdrSessionName ||
              response.state.workspaceId !== ownerWorkspaceId
            ) {
              state.wakeTimer = undefined;
              return;
            }
            addPendingEvents(response.events ?? [], ctx);
          } catch {
            state.wakeTimer = undefined;
            state.failedWakeThroughEventId = Math.max(
              state.failedWakeThroughEventId,
              requestedThroughEventId,
            );
            ctx.ui.notify?.(
              "Shepherd could not prepare worker updates; they remain pending",
              "warning",
            );
            return;
          }

          if (
            generation !== wakeGeneration ||
            !state.isOrchestrator ||
            state.currentScope?.herdrSessionName !== ownerHerdrSessionName ||
            state.currentScope?.terminalId !== ownerTerminalId ||
            state.currentScope?.workspaceId !== ownerWorkspaceId
          ) {
            state.wakeTimer = undefined;
            return;
          }
          if (ctx.isIdle?.() === false) {
            state.wakeTimer = undefined;
            state.wakeDeferredUntilSettled = true;
            return;
          }

          const current = projectWorkerOutcomes(state.pendingEvents).outcomes.filter(
            (outcome) => outcome.eventId > state.failedWakeThroughEventId,
          );
          if (current.length === 0) {
            state.wakeTimer = undefined;
            return;
          }
          const batchEvents = [...state.pendingEvents].sort((left, right) => left.id - right.id);
          const batchOutcomes = projectWorkerOutcomes(batchEvents).outcomes;
          state.deliveredBatch = {
            assistantFinalSucceeded: false,
            events: batchEvents,
            invalidated: false,
            ownerTerminalId,
            shepherdTriggered: true,
          };
          state.wakeTimer = undefined;
          state.wakeRequested = true;
          state.wakeRequestedThroughEventId = current.at(-1)?.eventId ?? 0;
          pi.sendMessage?.(
            {
              content: formatWorkerOutcomeUpdates(batchOutcomes),
              customType: "shepherd-wake-context",
              details: { eventIds: batchEvents.map((event) => event.id) },
              display: false,
            },
            { deliverAs: "followUp" },
          );
          pi.sendMessage?.(
            {
              content: wakeLabel(current.length),
              customType: "shepherd-wake",
              details: { eventIds: current.map((outcome) => outcome.eventId) },
              display: true,
            },
            { deliverAs: "followUp", triggerTurn: true },
          );
          state.wakeRequested = false;
          state.wakeRequestedThroughEventId = 0;
        };
        void startWake();
      }, WAKE_SETTLE_MS);
    };

    const loseRole = (ctx: PiContext | undefined) => {
      if (state.deliveredBatch) {
        state.deliveredBatch.invalidated = true;
        const lastEventId = state.deliveredBatch.events.at(-1)?.id;
        if (lastEventId !== undefined) {
          state.failedWakeThroughEventId = Math.max(
            state.failedWakeThroughEventId,
            lastEventId,
          );
        }
        if (state.deliveredBatch.shepherdTriggered) ctx?.abort?.();
      }
      if (state.wakeRequestedThroughEventId > 0) {
        state.failedWakeThroughEventId = Math.max(
          state.failedWakeThroughEventId,
          state.wakeRequestedThroughEventId,
        );
      }
      cancelWake();
      state.isOrchestrator = false;
      state.pendingEvents = [];
      setRoleUi(ctx);
      setPendingUi(ctx);
    };

    const resetForScopeChange = (ctx: PiContext | undefined) => {
      if (state.deliveredBatch?.shepherdTriggered) ctx?.abort?.();
      if (state.deliveredBatch) state.deliveredBatch.invalidated = true;
      state.deliveredBatch = undefined;
      cancelWake();
      state.failedWakeThroughEventId = 0;
      state.pendingEvents = [];
      setPendingUi(ctx);
    };

    const addPendingEvents = (events: AgentEventWireRecord[], ctx: PiContext | undefined) => {
      const byId = new Map(state.pendingEvents.map((event) => [event.id, event]));
      for (const event of events) byId.set(event.id, event);
      state.pendingEvents = [...byId.values()].sort((left, right) => left.id - right.id);
      setPendingUi(ctx);
    };

    const applyConnectionStateResponse = (
      response: ConnectionStateResponse,
      ctx: PiContext | undefined,
    ) => {
      const scopeChanged =
        state.currentScope !== undefined &&
        (state.currentScope.herdrSessionName !== response.presence.herdrSessionName ||
          state.currentScope.workspaceId !== response.presence.workspaceId);
      if (scopeChanged) resetForScopeChange(ctx);
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
      scheduleWake(ctx);
    };

    const handleAgentEvent = (event: AgentEventWireRecord, ctx: PiContext | undefined) => {
      if (!state.isOrchestrator || !state.currentScope || !event.terminalId) return;
      if (event.terminalId === state.currentScope.terminalId) return;
      addPendingEvents([event], ctx);
      pi.appendEntry?.("shepherd.agent_event", event);
      scheduleWake(ctx);
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
        if (scopeChanged) resetForScopeChange(ctx);
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
      state.deliveredBatch = undefined;
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
      const message = record(event.message);
      if (message.role !== "assistant") return;
      const stopReason = stringValue(message.stopReason);
      if (state.deliveredBatch) {
        state.deliveredBatch.assistantFinalSucceeded =
          stopReason === "stop" || stopReason === "length";
      }
      if (!state.client || !state.connected || !state.currentScope) return;
      const excerpt = sanitize(assistantText(message.content));
      try {
        await state.client.request("agent.telemetry", {
          event: {
            evidenceRefs: [`pi-session:${state.sessionRef?.value ?? "unknown"}#message=final`],
            occurredAt: new Date().toISOString(),
            redactionApplied: excerpt.redacted,
            runtime: "pi",
            sessionRef: state.sessionRef ?? null,
            stopReason: stopReason ?? "stop",
            textExcerpt: excerpt.text,
            turnId: stringValue(message.turnId) ?? "unknown-turn",
            type: "agent.message.final",
          },
          workspaceId: state.currentScope.workspaceId,
        });
      } catch {
        // Telemetry is best effort.
      }
    });

    pi.on("agent_settled", async (_event: unknown, ctx: PiContext) => {
      const batch = state.deliveredBatch;
      if (!batch) {
        state.wakeDeferredUntilSettled = false;
        scheduleWake(ctx);
        return;
      }
      state.deliveredBatch = undefined;
      const stillOwner =
        state.isOrchestrator && state.currentScope?.terminalId === batch.ownerTerminalId;
      const failBatch = () => {
        const lastEventId = batch.events.at(-1)?.id;
        if (lastEventId !== undefined) {
          state.failedWakeThroughEventId = Math.max(
            state.failedWakeThroughEventId,
            lastEventId,
          );
        }
        ctx.ui.notify?.(
          "Shepherd could not acknowledge worker updates; they remain pending",
          "warning",
        );
      };
      const finishBatch = () => {
        state.wakeDeferredUntilSettled = false;
        setPendingUi(ctx);
        scheduleWake(ctx);
      };

      if (
        !batch.assistantFinalSucceeded ||
        batch.invalidated ||
        !stillOwner ||
        !state.client ||
        !state.connected
      ) {
        failBatch();
        finishBatch();
        return;
      }

      for (const event of batch.events) {
        try {
          await state.client.request("agent.notifications.ack", { eventId: event.id });
          state.pendingEvents = state.pendingEvents.filter((pending) => pending.id !== event.id);
        } catch {
          failBatch();
          break;
        }
      }
      finishBatch();
    });

    pi.on("before_agent_start", async (_event: unknown, ctx: PiContext) => {
      if (!state.client || !state.connected || !state.currentScope) return {};
      const shepherdTriggered = state.wakeRequested;
      cancelWakeTimer();
      try {
        const status = (await state.client.request(
          "agent.orchestrator.get",
          {},
        )) as ConnectionStateResponse;
        applyConnectionStateResponse(status, ctx);
        cancelWakeTimer();
        if (!state.currentScope) return {};
        const response = (await state.client.request("agent.list", {
          herdrSessionName: state.currentScope.herdrSessionName,
          workspaceId: state.currentScope.workspaceId,
        })) as { agents?: AgentListItem[] };
        if (state.isOrchestrator && !state.deliveredBatch && state.pendingEvents.length > 0) {
          state.deliveredBatch = {
            assistantFinalSucceeded: false,
            events: [...state.pendingEvents].sort((left, right) => left.id - right.id),
            invalidated: false,
            ownerTerminalId: state.currentScope.terminalId,
            shepherdTriggered,
          };
        }
        state.wakeRequested = false;
        state.wakeRequestedThroughEventId = 0;
        const outcomes = state.deliveredBatch
          ? projectWorkerOutcomes(state.deliveredBatch.events).outcomes
          : [];
        const content = [
          formatHiddenAgentContext({
            agents: response.agents ?? [],
            workspaceId: state.currentScope.workspaceId,
          }),
          outcomes.length > 0 ? formatWorkerOutcomeUpdates(outcomes) : "",
        ]
          .filter(Boolean)
          .join("\n\n");
        setPendingUi(ctx);
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

function assistantText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => record(block))
    .filter((block) => block.type === "text")
    .map((block) => stringValue(block.text) ?? "")
    .filter(Boolean)
    .join("\n");
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
