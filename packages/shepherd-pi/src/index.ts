import { agentIdentityLabel } from "./agent-display.js";
import {
  type AgentContextListItem,
  type AgentEventWireRecord,
  type AgentOrchestratorChanged,
  type AgentOrchestratorWireState,
  type AgentWorkspaceContextSnapshot,
  type DaemonStreamMessage,
  ReconnectingDaemonClient,
} from "./daemon-client.js";
import {
  type AgentUpdateMessageDetails,
  formatShepherdFooterStatus,
  renderAgentUpdateMessage,
  type ShepherdFooterState,
} from "./agent-update-ui.js";
import {
  formatAgentOutcomeUpdates,
  projectAgentOutcomes,
  WAKE_SETTLE_MS,
} from "./wake.js";

type PiAgentMessage = {
  content?: unknown;
  customType?: string;
  role?: string;
  [key: string]: unknown;
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
  context?: AgentWorkspaceContextSnapshot | null;
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
  latestContext: AgentWorkspaceContextSnapshot | undefined;
  pendingEvents: AgentEventWireRecord[];
  pinnedContext: AgentWorkspaceContextSnapshot | undefined;
  reconnectingFromOn: boolean;
  registrationInFlight: Promise<void> | undefined;
  runActive: boolean;
  roleMutationInFlight: boolean;
  sessionRef: AgentSessionRef | undefined;
  subscriberId: string | undefined;
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
    theme: {
      bg(color: string, text: string): string;
      bold(text: string): string;
      fg(color: string, text: string): string;
    };
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
  registerMessageRenderer?: (
    customType: string,
    renderer: typeof renderAgentUpdateMessage,
  ) => void;
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
const COMMAND_USAGE = "Usage: /shepherd [on|off|status]";
const HERDR_REQUIRED_MESSAGE = "Shepherd requires a Herdr workspace";
const RECONNECTING_MESSAGE = "Shepherd is reconnecting · try again shortly";

function defaultShepherdHome() {
  return process.env.SHEPHERD_HOME || `${process.env.HOME || ""}/${DEFAULT_HOME_NAME}`;
}

export function defaultSocketPath() {
  return `${defaultShepherdHome().replace(/\/$/, "")}/shepherd.sock`;
}

export function createShepherdPiExtension(options: ExtensionOptions = {}) {
  return function shepherdPiExtension(pi: PiApi): void {
    pi.registerMessageRenderer?.("shepherd-wake", renderAgentUpdateMessage);

    const state: ShepherdState = {
      client: undefined,
      connected: false,
      currentScope: undefined,
      deliveredBatch: undefined,
      failedWakeThroughEventId: 0,
      isOrchestrator: false,
      launchIdentity: undefined,
      latestContext: undefined,
      pendingEvents: [],
      pinnedContext: undefined,
      reconnectingFromOn: false,
      registrationInFlight: undefined,
      roleMutationInFlight: false,
      runActive: false,
      sessionRef: undefined,
      subscriberId: undefined,
      wakeDeferredUntilSettled: false,
      wakeRequested: false,
      wakeRequestedThroughEventId: 0,
      wakeTimer: undefined,
    };
    let activeContext: PiContext | undefined;
    let wakeGeneration = 0;

    const setShepherdUi = (ctx: PiContext | undefined) => {
      if (!ctx) return;
      const footerState: ShepherdFooterState = state.reconnectingFromOn
        ? { kind: "reconnecting" }
        : state.isOrchestrator
          ? {
              kind: "on",
              updateCount: projectAgentOutcomes(state.pendingEvents).outcomes.length,
            }
          : { kind: "off" };
      ctx.ui.setStatus?.("shepherd", formatShepherdFooterStatus(footerState));
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
      `Shepherd received ${count} agent update${count === 1 ? "" : "s"}.`;

    const clearAgentContext = () => {
      state.latestContext = undefined;
      state.pinnedContext = undefined;
      state.runActive = false;
    };

    const applyOwnerContext = (response: ConnectionStateResponse) => {
      state.latestContext = isLocalOwner(response) ? response.context ?? undefined : undefined;
    };

    const scheduleWake = (ctx: PiContext | undefined) => {
      if (!ctx || !state.isOrchestrator || !state.currentScope || !pi.sendMessage) return;
      const outcomes = projectAgentOutcomes(state.pendingEvents).outcomes;
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
            if (!response) {
              state.wakeTimer = undefined;
              return;
            }
            applyConnectionStateResponse(response, ctx);
          } catch {
            state.wakeTimer = undefined;
            state.failedWakeThroughEventId = Math.max(
              state.failedWakeThroughEventId,
              requestedThroughEventId,
            );
            ctx.ui.notify?.(
              "Shepherd couldn’t load agent updates · updates remain pending",
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

          const current = projectAgentOutcomes(state.pendingEvents).outcomes.filter(
            (outcome) => outcome.eventId > state.failedWakeThroughEventId,
          );
          if (current.length === 0) {
            state.wakeTimer = undefined;
            return;
          }
          const batchEvents = [...state.pendingEvents].sort((left, right) => left.id - right.id);
          const batchOutcomes = projectAgentOutcomes(batchEvents).outcomes;
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
              content: formatAgentOutcomeUpdates(batchOutcomes),
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
              details: {
                eventIds: current.map((outcome) => outcome.eventId),
                outcomes: current,
              } satisfies AgentUpdateMessageDetails,
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
      clearAgentContext();
      state.isOrchestrator = false;
      state.pendingEvents = [];
      state.reconnectingFromOn = false;
      setShepherdUi(ctx);
    };

    const markDisconnected = (ctx: PiContext | undefined) => {
      const reconnectingFromOn = state.reconnectingFromOn || state.isOrchestrator;
      loseRole(ctx);
      state.reconnectingFromOn = reconnectingFromOn;
      setShepherdUi(ctx);
    };

    const resetForScopeChange = (ctx: PiContext | undefined) => {
      clearAgentContext();
      if (state.deliveredBatch?.shepherdTriggered) ctx?.abort?.();
      if (state.deliveredBatch) state.deliveredBatch.invalidated = true;
      state.deliveredBatch = undefined;
      cancelWake();
      state.failedWakeThroughEventId = 0;
      state.pendingEvents = [];
      setShepherdUi(ctx);
    };

    const addPendingEvents = (events: AgentEventWireRecord[], ctx: PiContext | undefined) => {
      const byId = new Map(state.pendingEvents.map((event) => [event.id, event]));
      for (const event of events) byId.set(event.id, event);
      state.pendingEvents = [...byId.values()].sort((left, right) => left.id - right.id);
      setShepherdUi(ctx);
    };

    const applyConnectionStateResponse = (
      response: ConnectionStateResponse,
      ctx: PiContext | undefined,
      options: { notifyReconnectLoss?: boolean } = {},
    ) => {
      const reconnectingOwner = options.notifyReconnectLoss && state.reconnectingFromOn;
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
      const isOwner = isLocalOwner(response);
      if (!isOwner) {
        loseRole(ctx);
        if (reconnectingOwner) {
          ctx?.ui.notify?.(
            response.state?.owner
              ? `Shepherd is off · moved to ${response.state.owner.paneId}`
              : "Shepherd is off",
            "info",
          );
        }
        return;
      }
      state.isOrchestrator = true;
      state.reconnectingFromOn = false;
      applyOwnerContext(response);
      setShepherdUi(ctx);
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
        state.reconnectingFromOn = false;
        setShepherdUi(ctx);
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
            ? `Shepherd is off · moved to ${change.current.owner.paneId}`
            : "Shepherd is off",
          "info",
        );
      }
    };

    const handleStreamMessage = (message: DaemonStreamMessage) => {
      if (message.method === "agent.event") {
        handleAgentEvent(message.params.event, activeContext);
        return;
      }
      if (message.method === "agent.context.changed") {
        if (
          state.isOrchestrator &&
          state.currentScope?.herdrSessionName === message.params.herdrSessionName &&
          state.currentScope.workspaceId === message.params.workspaceId
        ) {
          state.latestContext = message.params.context ?? undefined;
        }
        return;
      }
      handleRoleChange(message.params.change, activeContext);
    };

    const registerPresence = (ctx: PiContext): Promise<void> => {
      if (state.registrationInFlight) return state.registrationInFlight;
      const client = state.client;
      const launchIdentity = state.launchIdentity;
      const subscriberId = state.subscriberId;
      const sessionRef = state.sessionRef;
      if (!client || !launchIdentity || !subscriberId) return Promise.resolve();
      if (!sessionRef?.value) {
        return Promise.reject(new Error("Pi session file is unavailable for Shepherd presence"));
      }
      const registration = client
        .request("agent.orchestrator.register", {
          herdrSocketPath: launchIdentity.herdrSocketPath,
          paneId: state.currentScope?.paneId ?? launchIdentity.paneId,
          sessionRef,
          subscriberId,
          subscriberKind: "pi",
          workspaceId: state.currentScope?.workspaceId ?? launchIdentity.workspaceId,
        })
        .then((response) => {
          state.connected = true;
          applyConnectionStateResponse(response as ConnectionStateResponse, ctx, {
            notifyReconnectLoss: true,
          });
        })
        .catch((error) => {
          state.connected = false;
          markDisconnected(ctx);
          throw error;
        })
        .finally(() => {
          state.registrationInFlight = undefined;
        });
      state.registrationInFlight = registration;
      return registration;
    };

    pi.registerCommand?.("shepherd", {
      description: "Watch Shepherd agent updates in this Pi",
      getArgumentCompletions(prefix: string) {
        const items = ["on", "off", "status"]
          .filter((value) => value.startsWith(prefix))
          .map((value) => ({ label: value, value }));
        return items.length > 0 ? items : null;
      },
      handler: async (args: string, ctx: PiContext) => {
        const value = args.trim();
        const action = value === "" ? "status" : value;
        if (action !== "on" && action !== "off" && action !== "status") {
          ctx.ui.notify?.(COMMAND_USAGE, "warning");
          return;
        }
        if (!state.launchIdentity) {
          ctx.ui.notify?.(HERDR_REQUIRED_MESSAGE, "error");
          return;
        }
        if (!state.client || !state.connected || !state.currentScope) {
          ctx.ui.notify?.(RECONNECTING_MESSAGE, "warning");
          return;
        }
        try {
          if (action === "status") {
            const response = (await state.client.request(
              "agent.orchestrator.get",
              {},
            )) as ConnectionStateResponse;
            applyConnectionStateResponse(response, ctx);
            notifyLocalStatus(response, ctx);
            return;
          }
          state.roleMutationInFlight = true;
          const response = (await state.client.request("agent.orchestrator.set", {
            enabled: action === "on",
          })) as ConnectionStateResponse;
          applyConnectionStateResponse(response, ctx);
          notifyLocalStatus(response, ctx);
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
        markDisconnected(activeContext);
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

    pi.on("message_end", (event: Record<string, unknown>) => {
      const message = record(event.message);
      if (message.role !== "assistant") return;
      const stopReason = stringValue(message.stopReason);
      if (state.deliveredBatch) {
        state.deliveredBatch.assistantFinalSucceeded =
          stopReason === "stop" || stopReason === "length";
      }
    });

    pi.on("agent_start", () => {
      if (state.runActive) return;
      state.runActive = true;
      state.pinnedContext =
        state.isOrchestrator && !state.deliveredBatch?.shepherdTriggered
          ? state.latestContext
          : undefined;
    });

    pi.on("context", (event: { messages: PiAgentMessage[] }) => {
      const messages = event.messages.filter((message) => !isNormalShepherdContext(message));
      const snapshot = state.pinnedContext;
      if (!snapshot || snapshot.agents.length === 0) return { messages };
      return {
        messages: [
          ...messages,
          {
            content: formatHiddenAgentContext({
              agents: snapshot.agents,
              workspaceId: snapshot.workspaceId,
            }),
            customType: "shepherd-agent-context",
            display: false,
            role: "custom",
            timestamp: Date.now(),
          },
        ],
      };
    });

    pi.on("agent_settled", async (_event: unknown, ctx: PiContext) => {
      state.runActive = false;
      state.pinnedContext = undefined;
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
          "Shepherd couldn’t acknowledge agent updates · updates remain pending",
          "warning",
        );
      };
      const finishBatch = () => {
        state.wakeDeferredUntilSettled = false;
        setShepherdUi(ctx);
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
          setShepherdUi(ctx);
        } catch {
          failBatch();
          break;
        }
      }
      finishBatch();
    });

  };
}

export default createShepherdPiExtension();

export function formatHiddenAgentContext(input: {
  agents: AgentContextListItem[];
  workspaceId: string;
}): string {
  return [
    "[SHEPHERD AGENT CONTEXT]",
    `Current Herdr workspace: ${input.workspaceId}`,
    ...input.agents.map((agent) => {
      const history = agent.history ?? {};
      const identity = agentIdentityLabel({
        agent: agent.agent ?? "unknown",
        name: agent.name,
      });
      return [
        `- ${identity} ${agent.paneId ?? "unknown"} ${agent.agentStatus ?? "unknown"}`,
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
      const identity = agentIdentityLabel({
        agent: stringValue(payload.agent) ?? "unknown",
        name: stringValue(payload.name),
      });
      return [
        `- ${event.type} ${identity} ${event.paneId ?? "unknown"}`,
        `  last assistant: ${oneLine(history.lastAssistantMessage?.text ?? "")}`,
        `  event: ${event.id}`,
      ].join("\n");
    }),
  ].join("\n");
}

function isNormalShepherdContext(message: PiAgentMessage): boolean {
  return (
    message.customType === "shepherd-agent-context" ||
    contentIncludesMarker(message.content, "[SHEPHERD AGENT CONTEXT]")
  );
}

function contentIncludesMarker(content: unknown, marker: string): boolean {
  if (typeof content === "string") return content.includes(marker);
  if (!Array.isArray(content)) return false;
  return content.some((block) => {
    const value = record(block);
    return (
      contentIncludesMarker(value.text, marker) || contentIncludesMarker(value.content, marker)
    );
  });
}

function isLocalOwner(response: ConnectionStateResponse): boolean {
  return (
    response.state?.owner?.terminalId === response.presence.terminalId &&
    response.state.herdrSessionName === response.presence.herdrSessionName &&
    response.state.workspaceId === response.presence.workspaceId
  );
}

function localStatusMessage(response: ConnectionStateResponse): string {
  if (!isLocalOwner(response) || !response.state?.owner) return "Shepherd is off";
  const scope = `${response.presence.herdrSessionName}/${response.presence.workspaceId}`;
  return `Shepherd is watching agent updates · ${scope} · ${response.state.owner.paneId}`;
}

function notifyLocalStatus(response: ConnectionStateResponse, ctx: PiContext): void {
  ctx.ui.notify?.(localStatusMessage(response), "info");
}

function herdrLaunchIdentity(environment: NodeJS.ProcessEnv): LaunchIdentity | undefined {
  if (environment.HERDR_ENV !== "1") return undefined;
  const herdrSocketPath = stringValue(environment.HERDR_SOCKET_PATH);
  const paneId = stringValue(environment.HERDR_PANE_ID);
  const workspaceId = stringValue(environment.HERDR_WORKSPACE_ID);
  if (!herdrSocketPath || !paneId || !workspaceId) return undefined;
  return { herdrSocketPath, paneId, workspaceId };
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
