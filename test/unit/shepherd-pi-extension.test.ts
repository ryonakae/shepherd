import { describe, expect, test } from "vitest";
import type {
  AgentEventWireRecord,
  DaemonStreamMessage,
} from "../../packages/shepherd-pi/src/daemon-client.js";

const extensionModuleUrl = new URL("../../packages/shepherd-pi/src/index.ts", import.meta.url).href;

type Handler = (...args: unknown[]) => unknown;
type Command = {
  handler(args: string, ctx: ReturnType<typeof fakeCtx>): Promise<void>;
};

type Module = {
  createShepherdPiExtension: (options?: {
    autoResume?: boolean;
    clientFactory?: () => FakeClient;
  }) => (pi: FakePi) => void;
  defaultSocketPath: () => string;
  formatHiddenAgentContext: (input: { agents: unknown[]; workspaceId: string }) => string;
  formatHiddenAgentUpdates: (
    events: Array<{ id: number; type: string; payload: unknown }>,
  ) => string;
};

type FakeClient = ReturnType<typeof createFakeClient>;
type FakePi = ReturnType<typeof createFakePi>;

describe("shepherd-pi orchestrator bridge", () => {
  test("defaults to the Shepherd daemon socket", async () => {
    const { defaultSocketPath } = (await import(extensionModuleUrl)) as Module;
    const previousHome = process.env.SHEPHERD_HOME;
    process.env.SHEPHERD_HOME = "/tmp/shepherd-home";
    try {
      expect(defaultSocketPath()).toBe("/tmp/shepherd-home/shepherd.sock");
    } finally {
      process.env.SHEPHERD_HOME = previousHome;
    }
  });

  test("does not connect outside a complete Herdr environment", async () => {
    const pi = createFakePi();
    let clients = 0;
    const { createShepherdPiExtension } = (await import(extensionModuleUrl)) as Module;
    createShepherdPiExtension({
      clientFactory: () => {
        clients += 1;
        return createFakeClient();
      },
    })(pi);
    const ctx = fakeCtx();

    await pi.emit("session_start", {}, ctx);
    expect(clients).toBe(0);
    expect(ctx.statuses.get("shepherd-orchestrator")).toBeUndefined();

    const previous = withHerdrEnv();
    delete process.env.HERDR_PANE_ID;
    try {
      await pi.emit("session_start", {}, ctx);
      expect(clients).toBe(0);
    } finally {
      restoreEnv(previous);
    }
  });

  test("registers presence, adopts daemon location, reconnects, and sends telemetry", async () => {
    const client = createFakeClient();
    client.response = (method) => {
      if (method === "agent.orchestrator.register" || method === "agent.orchestrator.get") {
        return connectionResponse({ paneId: "wC:p3", workspaceId: "wC" });
      }
      return { accepted: true };
    };
    const pi = createFakePi();
    const ctx = fakeCtx();
    const { createShepherdPiExtension } = (await import(extensionModuleUrl)) as Module;
    createShepherdPiExtension({ clientFactory: () => client })(pi);
    const previous = withHerdrEnv({ paneId: "wB:p1", workspaceId: "wB" });
    try {
      await pi.emit("session_start", {}, ctx);
      await client.connect();
      expect(client.calls[0]).toEqual([
        "agent.orchestrator.register",
        {
          autoResume: false,
          herdrSocketPath: "/tmp/herdr.sock",
          paneId: "wB:p1",
          subscriberId: "pi-session",
          subscriberKind: "pi",
          workspaceId: "wB",
        },
      ]);
      expect(ctx.statuses.get("shepherd-orchestrator")).toBe("Shepherd: orchestrator");

      await pi.emit("tool_result", {
        content: "failed token=abc",
        isError: true,
        toolCallId: "tool-1",
        toolName: "bash",
        turnId: "turn-1",
      });
      await pi.emit("message_end", {
        stopReason: "stop",
        text: "completed",
        turnId: "turn-1",
      });
      expect(client.calls).toContainEqual([
        "agent.telemetry",
        expect.objectContaining({
          event: expect.objectContaining({ errorExcerpt: "failed token=[REDACTED]" }),
          workspaceId: "wC",
        }),
      ]);

      await client.connect();
      expect(
        client.calls.filter(([method]) => method === "agent.orchestrator.register").at(-1),
      ).toEqual([
        "agent.orchestrator.register",
        expect.objectContaining({ paneId: "wC:p3", workspaceId: "wC" }),
      ]);
    } finally {
      restoreEnv(previous);
    }
  });

  test("injects owner updates in id order and acknowledges without subscriber state", async () => {
    const pending = [event(42, "term_worker"), event(41, "term_worker")];
    const client = createFakeClient();
    client.response = (method) => {
      if (method === "agent.orchestrator.register") return connectionResponse({ events: pending });
      if (method === "agent.orchestrator.get") return connectionResponse();
      if (method === "agent.list") return agentListResponse();
      return { acknowledged: true };
    };
    const pi = createFakePi();
    const ctx = fakeCtx({ idle: true });
    const { createShepherdPiExtension, formatHiddenAgentContext, formatHiddenAgentUpdates } =
      (await import(extensionModuleUrl)) as Module;
    createShepherdPiExtension({ autoResume: true, clientFactory: () => client })(pi);
    const previous = withHerdrEnv();
    try {
      await pi.emit("session_start", {}, ctx);
      await client.connect();
      client.emitStream({ method: "agent.event", params: { event: event(43, "term_worker") } });
      client.emitStream({ method: "agent.event", params: { event: event(44, "term_pi") } });
      client.emitStream({ method: "agent.event", params: { event: event(45, null) } });

      expect(ctx.statuses.get("shepherd")).toBe("3 unread agent events");
      expect(ctx.widgets.get("shepherd")).toEqual(["3 unread agent events"]);
      expect(pi.messages).toEqual([expect.stringContaining("agent.done")]);
      expect(formatHiddenAgentContext({ agents: [], workspaceId: "wB" })).toContain(
        "[SHEPHERD AGENT CONTEXT]",
      );
      expect(formatHiddenAgentUpdates([event(1, "term_worker")])).toContain(
        "[SHEPHERD AGENT UPDATES]",
      );

      const before = await pi.emit("before_agent_start", {}, ctx);
      expect(before).toMatchObject({
        message: {
          content: expect.stringContaining("[SHEPHERD AGENT UPDATES]"),
          customType: "shepherd-agent-context",
          display: false,
        },
      });
      expect(client.calls.filter(([method]) => method === "agent.notifications.ack")).toEqual([
        ["agent.notifications.ack", { eventId: 41 }],
        ["agent.notifications.ack", { eventId: 42 }],
        ["agent.notifications.ack", { eventId: 43 }],
      ]);
      expect(ctx.statuses.get("shepherd")).toBeUndefined();
      expect(ctx.widgets.get("shepherd")).toBeUndefined();
    } finally {
      restoreEnv(previous);
    }
  });

  test("keeps context and telemetry for a non-owner while ignoring defensive events", async () => {
    const client = createFakeClient();
    client.response = (method) => {
      if (method === "agent.orchestrator.register" || method === "agent.orchestrator.get") {
        return connectionResponse({
          events: [event(9, "term_worker")],
          ownerTerminalId: "term_other",
        });
      }
      if (method === "agent.list") return agentListResponse();
      return { accepted: true };
    };
    const pi = createFakePi();
    const ctx = fakeCtx();
    const { createShepherdPiExtension } = (await import(extensionModuleUrl)) as Module;
    createShepherdPiExtension({ clientFactory: () => client })(pi);
    const previous = withHerdrEnv();
    try {
      await pi.emit("session_start", {}, ctx);
      await client.connect();
      client.emitStream({ method: "agent.event", params: { event: event(10, "term_worker") } });
      const before = await pi.emit("before_agent_start", {}, ctx);

      expect(before).toMatchObject({
        message: { content: expect.stringContaining("[SHEPHERD AGENT CONTEXT]") },
      });
      expect((before as { message: { content: string } }).message.content).not.toContain(
        "[SHEPHERD AGENT UPDATES]",
      );
      expect(client.calls).toContainEqual([
        "agent.list",
        { herdrSessionName: "default", workspaceId: "wB" },
      ]);
      expect(client.calls.some(([method]) => method === "agent.notifications.ack")).toBe(false);
    } finally {
      restoreEnv(previous);
    }
  });

  test("implements strict orchestrator command parsing and status messages", async () => {
    const client = createFakeClient();
    let current = connectionResponse({ ownerTerminalId: null });
    client.response = (method, params) => {
      if (method === "agent.orchestrator.register" || method === "agent.orchestrator.get") {
        return current;
      }
      if (method === "agent.orchestrator.set") {
        const enabled = (params as { enabled: boolean }).enabled;
        current = enabled
          ? connectionResponse({ changed: true })
          : connectionResponse({ changed: false, ownerTerminalId: "term_other" });
        return current;
      }
      return {};
    };
    const pi = createFakePi();
    const ctx = fakeCtx();
    const { createShepherdPiExtension } = (await import(extensionModuleUrl)) as Module;
    createShepherdPiExtension({ clientFactory: () => client })(pi);
    const previous = withHerdrEnv();
    try {
      await pi.emit("session_start", {}, ctx);
      await pi.command("orchestrator on", ctx);
      expect(ctx.notifications.at(-1)).toEqual([UNAVAILABLE, "error"]);
      await client.connect();

      await pi.command("orchestrator", ctx);
      expect(ctx.notifications.at(-1)).toEqual([
        "No Shepherd orchestrator is set for default/wB",
        "info",
      ]);
      await pi.command("  orchestrator   on  ", ctx);
      expect(client.calls).toContainEqual(["agent.orchestrator.set", { enabled: true }]);
      expect(ctx.statuses.get("shepherd-orchestrator")).toBe("Shepherd: orchestrator");
      expect(ctx.notifications.at(-1)).toEqual([
        "This Pi is the Shepherd orchestrator for default/wB (wB:p1)",
        "info",
      ]);
      await pi.command("orchestrator off", ctx);
      expect(ctx.notifications.at(-1)).toEqual([
        "This Pi is not the Shepherd orchestrator",
        "info",
      ]);
      await pi.command("orchestrator status", ctx);
      expect(ctx.notifications.at(-1)).toEqual([
        "Shepherd orchestrator for default/wB is wB:p-other",
        "info",
      ]);
      await pi.command("unknown", ctx);
      expect(ctx.notifications.at(-1)).toEqual([USAGE, "warning"]);
    } finally {
      restoreEnv(previous);
    }
  });

  test("notifies only a replaced owner and suppresses duplicate self-off stream feedback", async () => {
    const client = createFakeClient();
    let current = connectionResponse();
    client.response = async (method, params) => {
      if (method === "agent.orchestrator.register" || method === "agent.orchestrator.get") {
        return current;
      }
      if (
        method === "agent.orchestrator.set" &&
        (params as { enabled: boolean }).enabled === false
      ) {
        const change = roleChange("term_pi", null);
        current = connectionResponse({ changed: true, ownerTerminalId: null });
        client.emitStream({ method: "agent.orchestrator.changed", params: { change } });
        return current;
      }
      return current;
    };
    const pi = createFakePi();
    const ctx = fakeCtx();
    const { createShepherdPiExtension } = (await import(extensionModuleUrl)) as Module;
    createShepherdPiExtension({ clientFactory: () => client })(pi);
    const previous = withHerdrEnv();
    try {
      await pi.emit("session_start", {}, ctx);
      await client.connect();
      client.emitStream({
        method: "agent.orchestrator.changed",
        params: { change: roleChange("term_pi", "term_other", "wB:p-other") },
      });
      expect(ctx.notifications.at(-1)).toEqual([
        "Shepherd orchestrator moved to wB:p-other",
        "info",
      ]);

      current = connectionResponse();
      client.emitStream({
        method: "agent.orchestrator.changed",
        params: { change: roleChange("term_other", "term_pi") },
      });
      await tick();
      ctx.notifications.length = 0;
      await pi.command("orchestrator off", ctx);
      expect(ctx.notifications).toEqual([
        ["No Shepherd orchestrator is set for default/wB", "info"],
      ]);
    } finally {
      restoreEnv(previous);
    }
  });

  test("contains registration failures and shows reconnecting state", async () => {
    const client = createFakeClient();
    client.response = () => {
      throw new Error("registration failed");
    };
    const pi = createFakePi();
    const ctx = fakeCtx();
    const { createShepherdPiExtension } = (await import(extensionModuleUrl)) as Module;
    createShepherdPiExtension({ clientFactory: () => client })(pi);
    const previous = withHerdrEnv();
    try {
      await expect(pi.emit("session_start", {}, ctx)).resolves.toBeUndefined();
      await expect(client.connect()).resolves.toBeUndefined();
      expect(ctx.statuses.get("shepherd-connection")).toBe("Shepherd: reconnecting");
      expect(ctx.statuses.get("shepherd-orchestrator")).toBeUndefined();
    } finally {
      restoreEnv(previous);
    }
  });

  test("refreshes pending state when the owner moves to another workspace", async () => {
    const client = createFakeClient();
    client.response = (method) =>
      method === "agent.orchestrator.get"
        ? connectionResponse({
            events: [event(77, "term_worker")],
            paneId: "wC:p3",
            workspaceId: "wC",
          })
        : connectionResponse();
    const pi = createFakePi();
    const ctx = fakeCtx();
    const { createShepherdPiExtension } = (await import(extensionModuleUrl)) as Module;
    createShepherdPiExtension({ clientFactory: () => client })(pi);
    const previous = withHerdrEnv();
    try {
      await pi.emit("session_start", {}, ctx);
      await client.connect();
      client.emitStream({
        method: "agent.orchestrator.changed",
        params: {
          change: {
            ...roleChange("term_pi", "term_pi", "wC:p3"),
            current: {
              ...roleChange("term_pi", "term_pi", "wC:p3").current,
              workspaceId: "wC",
            },
          },
        },
      });
      await tick();

      expect(client.calls).toContainEqual(["agent.orchestrator.get", {}]);
      expect(ctx.statuses.get("shepherd")).toBe("1 unread agent event");
    } finally {
      restoreEnv(previous);
    }
  });

  test("closes on shutdown and a fresh Pi session registers with its own subscriber id", async () => {
    const first = createFakeClient();
    const second = createFakeClient();
    const clients = [first, second];
    const pi = createFakePi();
    const { createShepherdPiExtension } = (await import(extensionModuleUrl)) as Module;
    createShepherdPiExtension({ clientFactory: () => clients.shift() as FakeClient })(pi);
    const previous = withHerdrEnv();
    try {
      await pi.emit("session_start", {}, fakeCtx({ sessionId: "pi-old" }));
      await first.connect();
      await pi.emit("session_shutdown");
      await pi.emit("session_start", {}, fakeCtx({ sessionId: "pi-new" }));
      await second.connect();

      expect(first.closed).toBe(true);
      expect(second.calls[0]).toEqual([
        "agent.orchestrator.register",
        expect.objectContaining({ subscriberId: "pi-new" }),
      ]);
    } finally {
      restoreEnv(previous);
    }
  });
});

const USAGE = "Usage: /shepherd orchestrator [on|off|status]";
const UNAVAILABLE = "Shepherd orchestrator is unavailable until this Pi reconnects to the daemon";

function createFakeClient() {
  let connected: (() => Promise<void> | void) | undefined;
  let disconnected: ((error: Error) => void) | undefined;
  let stream: ((message: DaemonStreamMessage) => void) | undefined;
  const client = {
    calls: [] as Array<[string, unknown]>,
    closed: false,
    response: (_method: string, _params: unknown): unknown => connectionResponse(),
    close() {
      client.closed = true;
    },
    async connect() {
      try {
        await connected?.();
      } catch (error) {
        disconnected?.(error instanceof Error ? error : new Error(String(error)));
      }
    },
    disconnect(error = new Error("disconnected")) {
      disconnected?.(error);
    },
    emitStream(message: DaemonStreamMessage) {
      stream?.(message);
    },
    get onConnected() {
      return connected;
    },
    set onConnected(handler: (() => Promise<void> | void) | undefined) {
      connected = handler;
    },
    get onDisconnected() {
      return disconnected;
    },
    set onDisconnected(handler: ((error: Error) => void) | undefined) {
      disconnected = handler;
    },
    get onStreamMessage() {
      return stream;
    },
    set onStreamMessage(handler: ((message: DaemonStreamMessage) => void) | undefined) {
      stream = handler;
    },
    async request(method: string, params: unknown) {
      client.calls.push([method, params]);
      return client.response(method, params);
    },
  };
  return client;
}

function createFakePi() {
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, Command>();
  return {
    commands,
    entries: [] as unknown[],
    handlers,
    messages: [] as string[],
    appendEntry(customType: string, data: unknown) {
      this.entries.push([customType, data]);
    },
    async command(args: string, ctx: ReturnType<typeof fakeCtx>) {
      await commands.get("shepherd")?.handler(args, ctx);
    },
    emit: async (name: string, ...args: unknown[]) => handlers.get(name)?.(...args),
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    registerCommand(name: string, options: Command) {
      commands.set(name, options);
    },
    registerTool() {},
    sendUserMessage(message: string) {
      this.messages.push(message);
    },
    setSessionName() {},
  };
}

function fakeCtx(options: { idle?: boolean; sessionId?: string } = {}) {
  const ctx = {
    isIdle: () => options.idle ?? false,
    notifications: [] as Array<[string, string | undefined]>,
    sessionManager: {
      getSessionFile: () => "/tmp/pi-session.jsonl",
      getSessionId: () => options.sessionId ?? "pi-session",
    },
    statuses: new Map<string, string | undefined>(),
    widgets: new Map<string, string[] | undefined>(),
    ui: {
      notify(message: string, level?: string) {
        ctx.notifications.push([message, level]);
      },
      setStatus(key: string, value?: string) {
        ctx.statuses.set(key, value);
      },
      setWidget(key: string, value?: string[]) {
        if (value?.some((line) => typeof line !== "string")) {
          throw new Error("widget lines must be strings");
        }
        ctx.widgets.set(key, value);
      },
    },
  };
  return ctx;
}

function connectionResponse(
  options: {
    changed?: boolean;
    events?: AgentEventWireRecord[];
    ownerTerminalId?: string | null;
    paneId?: string;
    workspaceId?: string;
  } = {},
) {
  const paneId = options.paneId ?? "wB:p1";
  const workspaceId = options.workspaceId ?? "wB";
  const ownerTerminalId =
    options.ownerTerminalId === undefined ? "term_pi" : options.ownerTerminalId;
  return {
    ...(options.changed === undefined ? {} : { changed: options.changed }),
    events: options.events ?? [],
    presence: {
      autoResume: false,
      connectedAt: 1,
      herdrSessionName: "default",
      paneId,
      subscriberId: "pi-session",
      terminalId: "term_pi",
      workspaceId,
    },
    state: {
      ackedEventId: 0,
      herdrSessionName: "default",
      owner: ownerTerminalId
        ? {
            paneId: ownerTerminalId === "term_pi" ? paneId : "wB:p-other",
            terminalId: ownerTerminalId,
          }
        : null,
      updatedAt: "2026-07-10T00:00:00.000Z",
      workspaceId,
    },
  };
}

function event(id: number, terminalId: string | null): AgentEventWireRecord {
  return {
    compactHistory: { lastAssistantMessage: { text: "done" } },
    id,
    paneId: "wB:p-worker",
    payload: { agent: "worker" },
    terminalId,
    type: "agent.done",
    workspaceId: "wB",
  };
}

function agentListResponse() {
  return {
    agents: [
      {
        agent: "pi",
        agentStatus: "idle",
        history: {
          lastAssistantMessage: { text: "ready" },
          lastUserMessage: { text: "work" },
        },
        paneId: "wB:p1",
      },
    ],
  };
}

function roleChange(
  previousTerminalId: string | null,
  currentTerminalId: string | null,
  currentPaneId = "wB:p1",
) {
  return {
    current: {
      ackedEventId: 0,
      herdrSessionName: "default",
      owner: currentTerminalId ? { paneId: currentPaneId, terminalId: currentTerminalId } : null,
      updatedAt: "2026-07-10T00:00:01.000Z",
      workspaceId: "wB",
    },
    previous: {
      ackedEventId: 0,
      herdrSessionName: "default",
      owner: previousTerminalId ? { paneId: "wB:p1", terminalId: previousTerminalId } : null,
      updatedAt: "2026-07-10T00:00:00.000Z",
      workspaceId: "wB",
    },
    reason: "claimed" as const,
  };
}

function withHerdrEnv(options: { paneId?: string; workspaceId?: string } = {}) {
  const previous = {
    HERDR_ENV: process.env.HERDR_ENV,
    HERDR_PANE_ID: process.env.HERDR_PANE_ID,
    HERDR_SOCKET_PATH: process.env.HERDR_SOCKET_PATH,
    HERDR_WORKSPACE_ID: process.env.HERDR_WORKSPACE_ID,
  };
  process.env.HERDR_ENV = "1";
  process.env.HERDR_PANE_ID = options.paneId ?? "wB:p1";
  process.env.HERDR_SOCKET_PATH = "/tmp/herdr.sock";
  process.env.HERDR_WORKSPACE_ID = options.workspaceId ?? "wB";
  return previous;
}

function restoreEnv(previous: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
