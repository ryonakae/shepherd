import { describe, expect, test } from "vitest";

const extensionModuleUrl = new URL("../../packages/shepherd-pi/src/index.ts", import.meta.url).href;

type Handler = (...args: unknown[]) => unknown;

type Module = {
  createShepherdPiExtension: (options: {
    autoResume?: boolean;
    clientFactory: () => FakeClient;
  }) => (pi: FakePi) => void;
  defaultSocketPath: () => string;
  formatHiddenAgentContext: (input: { agents: unknown[]; workspaceId: string }) => string;
  formatHiddenAgentUpdates: (
    events: Array<{ id: number; type: string; payload: unknown }>,
  ) => string;
};

type FakeClient = {
  calls: unknown[];
  close: () => void;
  emitAgentEvent?: (event: unknown) => void;
  onAgentEvent: ((event: unknown) => void) | undefined;
  request: (method: string, params: unknown) => Promise<unknown>;
};

type FakePi = ReturnType<typeof createFakePi>;

describe("shepherd-pi agent history bridge", () => {
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

  test("subscribes to agent notifications and sends agent telemetry", async () => {
    const client = createFakeClient();
    const pi = createFakePi();
    const { createShepherdPiExtension } = (await import(extensionModuleUrl)) as Module;
    createShepherdPiExtension({ clientFactory: () => client })(pi);

    const previousEnv = withHerdrEnv();
    await pi.emit("session_start", {}, fakeCtx());
    await pi.emit("tool_result", {
      content: "failed token=abc",
      isError: true,
      toolCallId: "tool-1",
      toolName: "bash",
      turnId: "turn-1",
    });
    await pi.emit("message_end", { stopReason: "stop", text: "completed", turnId: "turn-1" });
    restoreEnv(previousEnv);

    expect(client.calls).toEqual([
      [
        "agent.notifications.subscribe",
        {
          autoResume: false,
          subscriberId: "pi-session",
          subscriberKind: "pi",
          workspaceId: "wB",
        },
      ],
      [
        "agent.telemetry",
        expect.objectContaining({
          event: expect.objectContaining({
            errorExcerpt: "failed token=[REDACTED]",
            type: "agent.tool.completed",
          }),
          workspaceId: "wB",
        }),
      ],
      [
        "agent.telemetry",
        expect.objectContaining({
          event: expect.objectContaining({ textExcerpt: "completed", type: "agent.message.final" }),
          workspaceId: "wB",
        }),
      ],
    ]);
  });

  test("injects current workspace agent context and unread updates", async () => {
    const client = createFakeClient({
      events: [
        {
          compactHistory: { lastAssistantMessage: { text: "done" } },
          id: 42,
          payload: { agent: "claude" },
          paneId: "wB:p2",
          type: "agent.done",
        },
      ],
    });
    const pi = createFakePi();
    const ctx = fakeCtx({ idle: true });
    const { createShepherdPiExtension, formatHiddenAgentContext, formatHiddenAgentUpdates } =
      (await import(extensionModuleUrl)) as Module;
    createShepherdPiExtension({ autoResume: true, clientFactory: () => client })(pi);
    const previousEnv = withHerdrEnv();
    await pi.emit("session_start", {}, ctx);
    client.emitAgentEvent?.({
      id: 43,
      payload: { agent: "pi" },
      type: "agent.idle",
      paneId: "wB:p1",
    });
    restoreEnv(previousEnv);

    expect(ctx.status).toEqual(["shepherd", "2 unread agent events"]);
    expect(pi.messages).toEqual([expect.stringContaining("agent.idle")]);
    expect(formatHiddenAgentContext({ agents: [], workspaceId: "wB" })).toContain(
      "[SHEPHERD AGENT CONTEXT]",
    );
    expect(
      formatHiddenAgentUpdates([{ id: 42, payload: { agent: "claude" }, type: "agent.done" }]),
    ).toContain("[SHEPHERD AGENT UPDATES]");

    const before = await pi.emit("before_agent_start", {}, ctx);
    expect(before).toEqual({
      message: {
        content: expect.stringContaining("[SHEPHERD AGENT CONTEXT]"),
        customType: "shepherd-agent-context",
        display: false,
      },
    });
    expect(before).toEqual({
      message: expect.objectContaining({
        content: expect.stringContaining("[SHEPHERD AGENT UPDATES]"),
      }),
    });
    expect(client.calls).toContainEqual(["agent.list", { workspaceId: "wB" }]);
    expect(client.calls).toContainEqual([
      "agent.notifications.ack",
      { eventId: 42, subscriptionId: "ans_1" },
    ]);
    expect(client.calls).toContainEqual([
      "agent.notifications.ack",
      { eventId: 43, subscriptionId: "ans_1" },
    ]);
  });
});

function createFakeClient(options: { events?: unknown[] } = {}): FakeClient {
  const calls: unknown[] = [];
  let onAgentEvent: ((event: unknown) => void) | undefined;
  return {
    calls,
    close: () => calls.push(["close"]),
    emitAgentEvent: (event: unknown) => onAgentEvent?.(event),
    set onAgentEvent(handler: ((event: unknown) => void) | undefined) {
      onAgentEvent = handler;
    },
    async request(method, params) {
      calls.push([method, params]);
      if (method === "agent.notifications.subscribe") {
        return { events: options.events ?? [], subscription: { id: "ans_1" } };
      }
      if (method === "agent.list") {
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
      return { ok: true };
    },
  };
}

function createFakePi() {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    messages: [] as string[],
    appendEntry() {},
    emit: async (name: string, ...args: unknown[]) => handlers.get(name)?.(...args),
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    registerCommand() {},
    registerTool() {},
    sendUserMessage(message: string) {
      this.messages.push(message);
    },
    setSessionName() {},
  };
}

function fakeCtx(options: { idle?: boolean } = {}) {
  const ctx = {
    isIdle: () => options.idle ?? false,
    sessionManager: {
      getSessionFile: () => "/tmp/pi-session.jsonl",
      getSessionId: () => "pi-session",
    },
    status: [] as unknown[],
    ui: {
      setStatus(...args: unknown[]) {
        ctx.status = args;
      },
      setWidget() {},
    },
  };
  return ctx;
}

function withHerdrEnv() {
  const previous = {
    HERDR_ENV: process.env.HERDR_ENV,
    HERDR_WORKSPACE_ID: process.env.HERDR_WORKSPACE_ID,
  };
  process.env.HERDR_ENV = "1";
  process.env.HERDR_WORKSPACE_ID = "wB";
  return previous;
}

function restoreEnv(previous: {
  HERDR_ENV: string | undefined;
  HERDR_WORKSPACE_ID: string | undefined;
}) {
  if (previous.HERDR_ENV === undefined) delete process.env.HERDR_ENV;
  else process.env.HERDR_ENV = previous.HERDR_ENV;
  if (previous.HERDR_WORKSPACE_ID === undefined) delete process.env.HERDR_WORKSPACE_ID;
  else process.env.HERDR_WORKSPACE_ID = previous.HERDR_WORKSPACE_ID;
}
