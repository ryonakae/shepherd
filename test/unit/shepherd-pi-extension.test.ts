import { describe, expect, test } from "vitest";

const extensionModuleUrl = new URL("../../packages/shepherd-pi/src/index.ts", import.meta.url).href;

type Handler = (...args: unknown[]) => unknown;

type Module = {
  createShepherdPiExtension: (options: {
    autoResume?: boolean;
    clientFactory: () => FakeClient;
  }) => (pi: FakePi) => void;
  formatHiddenNotifications: (
    events: Array<{ id: number; type: string; payload: unknown }>,
  ) => string;
};

type FakeClient = {
  calls: unknown[];
  close: () => void;
  request: (method: string, params: unknown) => Promise<unknown>;
};

type FakePi = ReturnType<typeof createFakePi>;

describe("shepherd-pi observability bridge", () => {
  test("observes Herdr workspace on session_start and sends telemetry", async () => {
    const client = createFakeClient();
    const pi = createFakePi();
    const { createShepherdPiExtension } = (await import(extensionModuleUrl)) as Module;
    createShepherdPiExtension({ clientFactory: () => client })(pi);

    const previousEnv = {
      HERDR_ENV: process.env.HERDR_ENV,
      HERDR_SOCKET_PATH: process.env.HERDR_SOCKET_PATH,
      HERDR_WORKSPACE_ID: process.env.HERDR_WORKSPACE_ID,
    };
    process.env.HERDR_ENV = "1";
    process.env.HERDR_SOCKET_PATH = "/tmp/herdr.sock";
    process.env.HERDR_WORKSPACE_ID = "w1";
    await pi.emit("session_start", {}, fakeCtx());
    await pi.emit("tool_result", {
      content: "failed token=abc",
      isError: true,
      toolCallId: "tool-1",
      toolName: "bash",
      turnId: "turn-1",
    });
    await pi.emit("message_end", { stopReason: "stop", text: "completed", turnId: "turn-1" });

    process.env.HERDR_ENV = previousEnv.HERDR_ENV;
    process.env.HERDR_SOCKET_PATH = previousEnv.HERDR_SOCKET_PATH;
    process.env.HERDR_WORKSPACE_ID = previousEnv.HERDR_WORKSPACE_ID;

    expect(client.calls).toEqual([
      ["workspace.observe", { socketPath: "/tmp/herdr.sock", workspaceId: "w1" }],
      [
        "notification.subscribe",
        {
          autoResume: false,
          observedWorkspaceId: "ow_1",
          subscriberId: "pi-session",
          subscriberKind: "pi",
        },
      ],
      [
        "runtime.telemetry",
        expect.objectContaining({
          event: expect.objectContaining({
            errorExcerpt: "failed token=[REDACTED]",
            type: "worker.tool.completed",
          }),
          observedWorkspaceId: "ow_1",
        }),
      ],
      [
        "runtime.telemetry",
        expect.objectContaining({
          event: expect.objectContaining({
            textExcerpt: "completed",
            type: "worker.message.final",
          }),
          observedWorkspaceId: "ow_1",
        }),
      ],
    ]);
  });

  test("handles notifications, hidden context ack, and auto-resume", async () => {
    const client = createFakeClient();
    const pi = createFakePi();
    const ctx = fakeCtx({ idle: true });
    const { createShepherdPiExtension, formatHiddenNotifications } = (await import(
      extensionModuleUrl
    )) as Module;
    createShepherdPiExtension({ autoResume: true, clientFactory: () => client })(pi);
    const previousEnv = {
      HERDR_ENV: process.env.HERDR_ENV,
      HERDR_SOCKET_PATH: process.env.HERDR_SOCKET_PATH,
      HERDR_WORKSPACE_ID: process.env.HERDR_WORKSPACE_ID,
    };
    process.env.HERDR_ENV = "1";
    process.env.HERDR_SOCKET_PATH = "/tmp/herdr.sock";
    process.env.HERDR_WORKSPACE_ID = "w1";
    await pi.emit("session_start", {}, ctx);
    await pi.emit(
      "worker.event",
      {
        event: { id: 42, payload: { summary: "done" }, type: "worker.completed", workerId: "wk_1" },
      },
      ctx,
    );

    process.env.HERDR_ENV = previousEnv.HERDR_ENV;
    process.env.HERDR_SOCKET_PATH = previousEnv.HERDR_SOCKET_PATH;
    process.env.HERDR_WORKSPACE_ID = previousEnv.HERDR_WORKSPACE_ID;

    expect(ctx.status).toEqual(["shepherd", "1 unread worker event"]);
    expect(pi.messages).toEqual([expect.stringContaining("worker.completed")]);
    expect(
      formatHiddenNotifications([
        { id: 42, payload: { summary: "done" }, type: "worker.completed" },
      ]),
    ).toContain("[SHEPHERD WORKER NOTIFICATIONS]");

    const before = await pi.emit("before_agent_start", {}, ctx);
    expect(before).toEqual({ hiddenContext: expect.stringContaining("worker.completed") });
    expect(client.calls).toContainEqual([
      "notification.ack",
      { eventId: 42, subscriptionId: "ns_1" },
    ]);
  });
});

function createFakeClient(): FakeClient {
  const calls: unknown[] = [];
  return {
    calls,
    close: () => calls.push(["close"]),
    async request(method, params) {
      calls.push([method, params]);
      if (method === "workspace.observe") return { observedWorkspace: { id: "ow_1" } };
      if (method === "notification.subscribe") return { events: [], subscription: { id: "ns_1" } };
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
      getSessionFile: () => "/tmp/session.jsonl",
      getSessionId: () => "pi-session",
    },
    status: undefined as unknown,
    ui: {
      setStatus(key: string, value: string) {
        ctx.status = [key, value];
      },
    },
  };
  return ctx;
}
