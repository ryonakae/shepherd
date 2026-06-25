import { createConnection } from "node:net";

const EXTENSION_VERSION = "0.1.0";
const BINDING_ENTRY_TYPE = "shepherd.binding";
const DEFAULT_SOCKET_PATH = "/tmp/shepherd.sock";

export default function shepherdPiExtension(pi) {
  const state = {
    client: undefined,
    binding: undefined,
    currentRun: undefined,
    lastAssistantText: "",
    ownerId: undefined,
    ownerKind: undefined,
    sessionId: undefined,
  };

  pi.on("session_start", async (_event, ctx) => {
    state.binding = findBinding(ctx) ?? bindingFromEnvironment();
    const socketPath =
      state.binding?.socketPath ?? process.env.SHEPHERD_SOCKET_PATH ?? DEFAULT_SOCKET_PATH;
    state.client = new ShepherdDaemonClient(socketPath);

    try {
      await state.client.connect();
      const handshake = await state.client.request("pi.handshake", {
        binding: state.binding,
        extensionVersion: EXTENSION_VERSION,
        mode: ctx.mode,
        piSessionFile: ctx.sessionManager.getSessionFile(),
        piSessionId: ctx.sessionManager.getSessionId(),
      });
      state.ownerId = handshake.ownerId;
      state.ownerKind = handshake.ownerKind;
      state.sessionId = handshake.sessionId ?? state.binding?.sessionId;

      if (state.sessionId) {
        await attachAndSubscribe(pi, ctx, state, state.sessionId, { silent: true });
      }

      ctx.ui.setStatus?.(
        "shepherd",
        state.sessionId ? `Shepherd ${state.sessionId.slice(0, 8)}` : "Shepherd ready",
      );
    } catch (error) {
      ctx.ui.notify?.(`Shepherd bridge unavailable: ${messageOf(error)}`, "warning");
      state.client?.close();
      state.client = undefined;
    }
  });

  pi.on("session_shutdown", async () => {
    if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
    state.client?.close();
    state.client = undefined;
  });

  pi.registerCommand("shepherd", {
    description:
      "Attach to or inspect a Shepherd session: /shepherd attach <session-id> | status | detach",
    handler: async (args, ctx) => {
      const [command, value] = args.trim().split(/\s+/, 2);
      if (command === "attach" && value) {
        await ensureClient(state, ctx);
        await attachAndSubscribe(pi, ctx, state, value, { silent: false });
        return;
      }

      if (command === "detach") {
        state.sessionId = undefined;
        state.currentRun = undefined;
        state.binding = undefined;
        pi.appendEntry(BINDING_ENTRY_TYPE, { detachedAt: new Date().toISOString() });
        ctx.ui.setStatus?.("shepherd", "Shepherd detached");
        ctx.ui.notify?.("Detached from Shepherd.", "info");
        return;
      }

      ctx.ui.notify?.(
        state.sessionId
          ? `Attached to Shepherd session ${state.sessionId} as ${state.ownerKind ?? "unknown owner"}.`
          : "Not attached to a Shepherd session. Use /shepherd attach <session-id>.",
        "info",
      );
    },
  });

  pi.on("before_agent_start", async (event) => {
    if (!state.sessionId) return;
    return {
      message: {
        customType: "shepherd.context",
        content: [
          `Shepherd session id: ${state.sessionId}`,
          state.currentRun ? `Current Shepherd gateway run id: ${state.currentRun.id}` : undefined,
          "Use Shepherd tools for Herdr/session orchestration when useful. Keep visible replies natural.",
        ]
          .filter(Boolean)
          .join("\n"),
        display: false,
      },
      systemPrompt: `${event.systemPrompt}\n\nWhen attached to Shepherd, platform metadata is provided as hidden context. Do not expose internal ids unless the user asks.`,
    };
  });

  pi.on("message_update", async (event) => {
    if (event.message?.role === "assistant") {
      state.lastAssistantText = textFromMessage(event.message);
    }
  });

  pi.on("message_end", async (event) => {
    if (event.message?.role === "assistant") {
      state.lastAssistantText = textFromMessage(event.message);
    }
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (!state.client || !state.currentRun || !state.ownerId) return;
    const run = state.currentRun;
    state.currentRun = undefined;
    try {
      await state.client.request("gateway.complete_run", {
        gatewayRunId: run.id,
        ownerId: state.ownerId,
        piSessionFile: ctx.sessionManager.getSessionFile(),
        piSessionId: ctx.sessionManager.getSessionId(),
        text: state.lastAssistantText.trim(),
      });
      state.lastAssistantText = "";
      await claimNext(pi, ctx, state);
    } catch (error) {
      ctx.ui.notify?.(`Failed to complete Shepherd run: ${messageOf(error)}`, "error");
    }
  });
}

async function attachAndSubscribe(pi, ctx, state, sessionId, options) {
  if (!state.client) throw new Error("Shepherd daemon client is not connected");
  const result = await state.client.request("pi.attach", {
    mode: ctx.mode,
    piSessionFile: ctx.sessionManager.getSessionFile(),
    piSessionId: ctx.sessionManager.getSessionId(),
    sessionId,
  });
  state.ownerId = result.ownerId;
  state.ownerKind = result.ownerKind;
  state.sessionId = sessionId;
  state.binding = {
    daemonId: result.daemonId,
    sessionId,
    socketPath: result.socketPath,
  };
  pi.appendEntry(BINDING_ENTRY_TYPE, state.binding);
  await registerShepherdTools(pi, state);
  state.unsubscribeEvents?.();
  state.unsubscribeEvents = state.client.onEvent((event) => {
    if (event.sessionId !== sessionId) return;
    if (event.type === "gateway.run.queued") {
      void claimNext(pi, ctx, state);
    }
  });
  await state.client.request("session.subscribe", { afterEventId: 0, sessionId });
  startHeartbeat(state);
  ctx.ui.setStatus?.("shepherd", `Shepherd ${sessionId.slice(0, 8)}`);
  if (!options.silent) ctx.ui.notify?.(`Attached to Shepherd session ${sessionId}.`, "info");
  await claimNext(pi, ctx, state);
}

async function registerShepherdTools(pi, state) {
  if (!state.client || !state.sessionId) return;
  const result = await state.client.request("tool.list", {});
  for (const tool of result.tools ?? []) {
    pi.registerTool({
      name: `shepherd_${tool.name}`,
      label: `Shepherd ${tool.name}`,
      description: tool.description,
      promptSnippet: `Delegate ${tool.name} to the attached Shepherd daemon`,
      promptGuidelines: [
        `Use shepherd_${tool.name} when the task needs Shepherd or Herdr orchestration.`,
      ],
      parameters: tool.inputSchema ?? { type: "object", additionalProperties: true },
      async execute(_toolCallId, params) {
        const output = await state.client.request("tool.run", {
          input: params,
          name: tool.name,
          sessionId: state.sessionId,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(output.output ?? output, null, 2) }],
          details: output.output ?? output,
        };
      },
    });
  }
}

async function claimNext(pi, ctx, state) {
  if (!state.client || !state.ownerId || !state.sessionId || state.currentRun || !ctx.isIdle())
    return;
  const result = await state.client.request("gateway.claim_next_run", {
    ownerId: state.ownerId,
    sessionId: state.sessionId,
  });
  if (!result.run) return;

  state.currentRun = result.run;
  await state.client.request("gateway.start_run", {
    gatewayRunId: result.run.id,
    ownerId: state.ownerId,
  });
  pi.sendUserMessage(result.run.userText);
}

async function ensureClient(state, ctx) {
  if (state.client) return;
  const socketPath =
    state.binding?.socketPath ?? process.env.SHEPHERD_SOCKET_PATH ?? DEFAULT_SOCKET_PATH;
  state.client = new ShepherdDaemonClient(socketPath);
  await state.client.connect();
  const handshake = await state.client.request("pi.handshake", {
    binding: state.binding,
    extensionVersion: EXTENSION_VERSION,
    mode: ctx.mode,
    piSessionFile: ctx.sessionManager.getSessionFile(),
    piSessionId: ctx.sessionManager.getSessionId(),
  });
  state.ownerId = handshake.ownerId;
  state.ownerKind = handshake.ownerKind;
}

function startHeartbeat(state) {
  if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
  state.heartbeatTimer = setInterval(() => {
    if (!state.client || !state.ownerId || !state.sessionId) return;
    void state.client
      .request("pi.heartbeat", { ownerId: state.ownerId, sessionId: state.sessionId })
      .catch(() => {});
  }, 15_000);
}

function bindingFromEnvironment() {
  if (!process.env.SHEPHERD_SESSION_ID) return undefined;
  return {
    daemonId: process.env.SHEPHERD_DAEMON_ID ?? "default",
    sessionId: process.env.SHEPHERD_SESSION_ID,
    socketPath: process.env.SHEPHERD_SOCKET_PATH ?? DEFAULT_SOCKET_PATH,
  };
}

function findBinding(ctx) {
  const entries = ctx.sessionManager.getEntries();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (
      entry.type === "custom" &&
      entry.customType === BINDING_ENTRY_TYPE &&
      entry.data?.sessionId
    ) {
      return entry.data;
    }
  }
  return undefined;
}

function textFromMessage(message) {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

class ShepherdDaemonClient {
  constructor(socketPath) {
    this.socketPath = socketPath;
    this.nextId = 1;
    this.pending = new Map();
    this.eventHandlers = new Set();
    this.buffer = "";
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.socket = createConnection(this.socketPath);
      this.socket.once("connect", resolve);
      this.socket.once("error", reject);
      this.socket.on("data", (chunk) => this.onData(chunk.toString("utf8")));
      this.socket.on("close", () => this.rejectAll(new Error("Shepherd daemon socket closed")));
    });
  }

  request(method, params = {}) {
    if (!this.socket) return Promise.reject(new Error("Shepherd daemon socket is not connected"));
    const id = `shepherd-pi-${this.nextId++}`;
    this.socket.write(`${JSON.stringify({ id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  onEvent(handler) {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  close() {
    this.socket?.destroy();
    this.socket = undefined;
    this.rejectAll(new Error("Shepherd daemon client closed"));
  }

  onData(chunk) {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (message.method === "session.event" && message.params?.event) {
        for (const handler of this.eventHandlers) handler(message.params.event);
        continue;
      }
      if (message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error)
          pending.reject(new Error(message.error.message ?? "Shepherd RPC failed"));
        else pending.resolve(message.result);
      }
    }
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
