import { type Socket, createConnection } from "node:net";

type CompletionItem = {
  description?: string;
  label: string;
  value: string;
};

type AutocompleteProvider = {
  applyCompletion: (
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: CompletionItem,
    prefix: string,
  ) => { cursorCol: number; cursorLine: number; lines: string[] };
  getSuggestions: (
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: Record<string, unknown>,
  ) => Promise<{ items: CompletionItem[]; prefix: string } | null>;
  shouldTriggerFileCompletion?: (lines: string[], cursorLine: number, cursorCol: number) => boolean;
};

type ShepherdBinding = {
  gatewayId: string | undefined;
  sessionId: string;
  socketPath: string | undefined;
};

type ShepherdOwnerKind = string;

type ShepherdRun = {
  id: string;
  userText: string;
};

type ShepherdState = {
  binding: ShepherdBinding | undefined;
  client: ShepherdGatewayClient | undefined;
  currentRun: ShepherdRun | undefined;
  heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  lastAssistantText: string;
  ownerId: string | undefined;
  ownerKind: ShepherdOwnerKind | undefined;
  sessionId: string | undefined;
  streamedAssistantText: string;
  unsubscribeEvents: (() => void) | undefined;
};

type SessionManager = {
  getEntries: () => SessionEntry[];
  getSessionFile: () => string;
  getSessionId: () => string;
};

type PiContext = {
  isIdle?: () => boolean;
  mode?: string;
  sessionManager: SessionManager;
  ui: {
    addAutocompleteProvider?: (factory: (current: AutocompleteProvider) => AutocompleteProvider) => void;
    notify?: (message: string, type?: "error" | "info" | "warning") => void;
    setStatus?: (statusKey: string, statusText?: string) => void;
  };
};

type PiApi = {
  appendEntry: (customType: string, data: unknown) => void;
  on: <TArgs extends unknown[]>(eventName: string, handler: (...args: TArgs) => unknown) => void;
  registerCommand: (
    name: string,
    options: {
      description: string;
      getArgumentCompletions?: (argumentPrefix: string) => CompletionItem[] | null;
      handler: (args: string, ctx: PiContext) => Promise<void> | void;
    },
  ) => void;
  registerTool: (tool: {
    description: string | undefined;
    execute: (toolCallId: string, params: unknown) => Promise<unknown>;
    label: string;
    name: string;
    parameters: unknown;
    promptGuidelines: string[] | undefined;
    promptSnippet: string | undefined;
  }) => void;
  sendUserMessage: (message: string) => void;
  setSessionName: (name: string) => void;
};

type SessionEntry = {
  customType?: string;
  data?: Partial<ShepherdBinding>;
  type?: string;
};

type TextPart = {
  text?: string;
  type?: string;
};

type Message = {
  content?: string | TextPart[];
  customType?: string;
  role?: string;
};

type SessionEvent = {
  payload?: Record<string, unknown>;
  sessionId?: string;
  type?: string;
};

type GatewayTool = {
  description?: string;
  inputSchema?: unknown;
  label?: string;
  name: string;
  promptGuidelines?: unknown;
  promptSnippet?: string;
};

type GatewayResponseMap = {
  "gateway.claim_next_run": { run?: ShepherdRun };
  "gateway.complete_run": unknown;
  "gateway.start_run": unknown;
  "gateway.stream_delta": unknown;
  "gateway.stream_finish": unknown;
  "pi.attach": ShepherdBinding & { ownerId: string; ownerKind: ShepherdOwnerKind | undefined };
  "pi.handshake": { ownerId: string; ownerKind: ShepherdOwnerKind | undefined; sessionId: string | undefined };
  "pi.heartbeat": unknown;
  "session.rename": unknown;
  "session.subscribe": unknown;
  "tool.list": { tools?: GatewayTool[] };
  "tool.run": { output?: unknown };
};

type RpcRequest = {
  id: string;
  method: string;
  params?: unknown;
};

type RpcResponse = {
  error?: { message?: string };
  id?: string;
  method?: string;
  params?: { event?: SessionEvent };
  result?: unknown;
};

const EXTENSION_VERSION = "0.1.0";
const BINDING_ENTRY_TYPE = "shepherd.binding";
const DEFAULT_HOME_NAME = ".shepherd";
const SHEPHERD_COMMAND_COMPLETIONS: CompletionItem[] = [
  {
    value: "attach ",
    label: "attach",
    description: "Attach this Pi session to a Shepherd session",
  },
  { value: "rename ", label: "rename", description: "Rename the attached Shepherd session" },
  { value: "status", label: "status", description: "Show the current Shepherd attachment" },
  { value: "detach", label: "detach", description: "Detach from the current Shepherd session" },
];

function defaultShepherdHome() {
  return process.env.SHEPHERD_HOME || `${process.env.HOME || ""}/${DEFAULT_HOME_NAME}`;
}

function defaultSocketPath() {
  return `${defaultShepherdHome().replace(/\/$/, "")}/gateway.sock`;
}

export function completeShepherdCommandArguments(argumentPrefix: string): CompletionItem[] | null {
  const prefix = argumentPrefix.trimStart();
  if (prefix === "") return [...SHEPHERD_COMMAND_COMPLETIONS];
  if (/\s/.test(prefix)) return null;

  const matches = SHEPHERD_COMMAND_COMPLETIONS.filter(
    (item) => item.value.startsWith(prefix) || item.label.startsWith(prefix),
  );
  return matches.length > 0 ? matches : null;
}

export function shepherdCommandArgumentPrefix(
  lines: string[],
  cursorLine: number,
  cursorCol: number,
): string | undefined {
  const line = lines[cursorLine] ?? "";
  const beforeCursor = line.slice(0, cursorCol);
  return /^\s*\/shepherd\s+([^\s]*)$/.exec(beforeCursor)?.[1];
}

export function createShepherdAutocompleteProvider(current: AutocompleteProvider): AutocompleteProvider {
  return {
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const prefix = shepherdCommandArgumentPrefix(lines, cursorLine, cursorCol);
      if (prefix === undefined) {
        return current.getSuggestions(lines, cursorLine, cursorCol, options);
      }

      const items = completeShepherdCommandArguments(prefix);
      return items ? { items, prefix } : null;
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    },
    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      return (
        shepherdCommandArgumentPrefix(lines, cursorLine, cursorCol) !== undefined ||
        (current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true)
      );
    },
  };
}

export default function shepherdPiExtension(pi: PiApi): void {
  const state: ShepherdState = {
    client: undefined,
    binding: undefined,
    currentRun: undefined,
    lastAssistantText: "",
    streamedAssistantText: "",
    heartbeatTimer: undefined,
    ownerId: undefined,
    ownerKind: undefined,
    sessionId: undefined,
    unsubscribeEvents: undefined,
  };

  pi.on("session_start", async (_event: unknown, ctx: PiContext) => {
    ctx.ui.addAutocompleteProvider?.((current: AutocompleteProvider) =>
      createShepherdAutocompleteProvider(current),
    );
    state.binding = findBinding(ctx) ?? bindingFromEnvironment();
    const socketPath =
      state.binding?.socketPath ?? process.env.SHEPHERD_GATEWAY_SOCKET_PATH ?? defaultSocketPath();
    state.client = new ShepherdGatewayClient(socketPath);

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
      "Attach, rename, or inspect a Shepherd session: /shepherd attach <session-id> | rename <title> | status | detach",
    getArgumentCompletions: completeShepherdCommandArguments,
    handler: async (args: string, ctx: PiContext) => {
      const trimmed = args.trim();
      const [command, ...rest] = trimmed.split(/\s+/);
      const value = rest.join(" ");
      if (command === "attach" && value) {
        await ensureClient(state, ctx);
        await attachAndSubscribe(pi, ctx, state, value, { silent: false });
        return;
      }

      if (command === "rename" && value) {
        if (!state.sessionId) {
          ctx.ui.notify?.(
            "Not attached to a Shepherd session. Use /shepherd attach <session-id>.",
            "warning",
          );
          return;
        }
        await ensureClient(state, ctx);
        const client = state.client;
        if (!client) throw new Error("Shepherd Gateway client is not connected");
        pi.setSessionName(value);
        await client.request("session.rename", { sessionId: state.sessionId, title: value });
        ctx.ui.notify?.(`Renamed Shepherd session: ${value}`, "info");
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

  pi.on("context", async (event: { messages: Message[] }) => ({
    messages: event.messages.filter((message: Message) => {
      if (message?.customType === "shepherd.context") return false;
      if (message?.role !== "user") return true;

      const content = message.content;
      if (typeof content === "string") {
        return !content.includes("[SHEPHERD ATTACHED CONTEXT]");
      }
      if (Array.isArray(content)) {
        return !content.some(
          (part) => part?.type === "text" && part.text?.includes("[SHEPHERD ATTACHED CONTEXT]"),
        );
      }
      return true;
    }),
  }));

  pi.on("before_agent_start", async (event: { systemPrompt: string }) => {
    if (!state.sessionId) return;
    return {
      message: {
        customType: "shepherd.context",
        content: [
          "[SHEPHERD ATTACHED CONTEXT]",
          `Shepherd session id: ${state.sessionId}`,
          state.currentRun ? `Current Shepherd gateway run id: ${state.currentRun.id}` : undefined,
          "Shepherd is a Herdr orchestration control-plane. Pi owns the model conversation; Herdr owns terminal execution surfaces.",
          "Prefer shepherd_* tools for Shepherd session inspection and Herdr orchestration when attached.",
          "Use Shepherd logical tools instead of raw Herdr control unless the user explicitly asks for direct Herdr work.",
          "Do not expose Shepherd session ids, Gateway run ids, socket paths, or owner ids unless the user asks.",
        ]
          .filter(Boolean)
          .join("\n"),
        display: false,
      },
      systemPrompt: `${event.systemPrompt}\n\nWhen attached to Shepherd, hidden Shepherd context may include platform and orchestration metadata. Treat that metadata as internal unless the user asks for it.`,
    };
  });

  pi.on("message_update", async (event: { message?: Message }) => {
    if (event.message?.role === "assistant") {
      await recordAssistantTextDelta(state, textFromMessage(event.message));
    }
  });

  pi.on("message_end", async (event: { message?: Message }) => {
    if (event.message?.role === "assistant") {
      state.lastAssistantText = textFromMessage(event.message);
    }
  });

  pi.on("agent_end", async (_event: unknown, ctx: PiContext) => {
    if (!state.client || !state.currentRun || !state.ownerId) return;
    const client = state.client;
    const ownerId = state.ownerId;
    const run = state.currentRun;
    state.currentRun = undefined;
    try {
      const finalText = state.lastAssistantText.trim();
      await client
        .request("gateway.stream_finish", {
          finalText,
          gatewayRunId: run.id,
          ownerId,
        })
        .catch(() => undefined);
      await client.request("gateway.complete_run", {
        gatewayRunId: run.id,
        ownerId,
        piSessionFile: ctx.sessionManager.getSessionFile(),
        piSessionId: ctx.sessionManager.getSessionId(),
        text: finalText,
      });
      state.lastAssistantText = "";
      state.streamedAssistantText = "";
      await claimNext(pi, ctx, state);
    } catch (error) {
      ctx.ui.notify?.(`Failed to complete Shepherd run: ${messageOf(error)}`, "error");
    }
  });
}

async function recordAssistantTextDelta(state: ShepherdState, text: string): Promise<void> {
  const delta = text.startsWith(state.streamedAssistantText)
    ? text.slice(state.streamedAssistantText.length)
    : text;
  state.lastAssistantText = text;
  state.streamedAssistantText = text;
  if (!delta || !state.client || !state.currentRun || !state.ownerId) return;
  const client = state.client;
  const currentRun = state.currentRun;
  const ownerId = state.ownerId;
  await client
    .request("gateway.stream_delta", {
      delta,
      gatewayRunId: currentRun.id,
      ownerId,
    })
    .catch(() => undefined);
}

async function attachAndSubscribe(
  pi: PiApi,
  ctx: PiContext,
  state: ShepherdState,
  sessionId: string,
  options: { silent: boolean },
): Promise<void> {
  if (!state.client) throw new Error("Shepherd Gateway client is not connected");
  const client = state.client;
  const result = await client.request("pi.attach", {
    mode: ctx.mode,
    piSessionFile: ctx.sessionManager.getSessionFile(),
    piSessionId: ctx.sessionManager.getSessionId(),
    sessionId,
  });
  state.ownerId = result.ownerId;
  state.ownerKind = result.ownerKind;
  state.sessionId = sessionId;
  state.binding = {
    gatewayId: result.gatewayId,
    sessionId,
    socketPath: result.socketPath,
  };
  pi.appendEntry(BINDING_ENTRY_TYPE, state.binding);
  await registerShepherdTools(pi, state);
  state.unsubscribeEvents?.();
  state.unsubscribeEvents = client.onEvent((event) => {
    if (event.sessionId !== sessionId) return;
    if (event.type === "gateway.run.queued") {
      void claimNext(pi, ctx, state);
    }
    if (event.type === "session.renamed") {
      const title = event.payload?.title;
      if (typeof title === "string" && title.length > 0) {
        pi.setSessionName(title);
      }
      if (title === null) {
        pi.setSessionName("");
      }
    }
  });
  await client.request("session.subscribe", { afterEventId: 0, sessionId });
  startHeartbeat(state);
  ctx.ui.setStatus?.("shepherd", `Shepherd ${sessionId.slice(0, 8)}`);
  if (!options.silent) ctx.ui.notify?.(`Attached to Shepherd session ${sessionId}.`, "info");
  await claimNext(pi, ctx, state);
}

async function registerShepherdTools(pi: PiApi, state: ShepherdState): Promise<void> {
  if (!state.client || !state.sessionId) return;
  const client = state.client;
  const sessionId = state.sessionId;
  const result = await client.request("tool.list", {});
  for (const tool of result.tools ?? []) {
    const registeredName = `shepherd_${tool.name}`;
    pi.registerTool({
      name: registeredName,
      label: tool.label ?? `Shepherd ${tool.name}`,
      description: tool.description,
      promptSnippet:
        tool.promptSnippet ?? `Use ${registeredName} through the attached Shepherd Gateway.`,
      promptGuidelines: promptGuidelinesFor(tool, registeredName),
      parameters: tool.inputSchema ?? { type: "object", additionalProperties: true },
      async execute(_toolCallId: string, params: unknown) {
        const output = await client.request("tool.run", {
          input: params,
          name: tool.name,
          sessionId,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(output.output ?? output, null, 2) }],
          details: output.output ?? output,
        };
      },
    });
  }
}

async function claimNext(pi: PiApi, ctx: PiContext, state: ShepherdState): Promise<void> {
  if (!state.client || !state.ownerId || !state.sessionId || state.currentRun || !ctx.isIdle?.())
    return;
  const client = state.client;
  const ownerId = state.ownerId;
  const sessionId = state.sessionId;
  const result = await client.request("gateway.claim_next_run", {
    ownerId,
    sessionId,
  });
  if (!result.run) return;

  state.currentRun = result.run;
  state.lastAssistantText = "";
  state.streamedAssistantText = "";
  await client.request("gateway.start_run", {
    gatewayRunId: result.run.id,
    ownerId,
  });
  pi.sendUserMessage(result.run.userText);
}

async function ensureClient(state: ShepherdState, ctx: PiContext): Promise<void> {
  if (state.client) return;
  const socketPath =
    state.binding?.socketPath ?? process.env.SHEPHERD_GATEWAY_SOCKET_PATH ?? defaultSocketPath();
  const client = new ShepherdGatewayClient(socketPath);
  state.client = client;
  await client.connect();
  const handshake = await client.request("pi.handshake", {
    binding: state.binding,
    extensionVersion: EXTENSION_VERSION,
    mode: ctx.mode,
    piSessionFile: ctx.sessionManager.getSessionFile(),
    piSessionId: ctx.sessionManager.getSessionId(),
  });
  state.ownerId = handshake.ownerId;
  state.ownerKind = handshake.ownerKind;
}

function startHeartbeat(state: ShepherdState): void {
  if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
  state.heartbeatTimer = setInterval(() => {
    if (!state.client || !state.ownerId || !state.sessionId) return;
    void state.client
      .request("pi.heartbeat", { ownerId: state.ownerId, sessionId: state.sessionId })
      .catch(() => {});
  }, 15_000);
}

function bindingFromEnvironment(): ShepherdBinding | undefined {
  const sessionId = process.env.SHEPHERD_SESSION_ID;
  if (!sessionId) return undefined;
  return {
    gatewayId: process.env.SHEPHERD_GATEWAY_ID ?? "default",
    sessionId,
    socketPath: process.env.SHEPHERD_GATEWAY_SOCKET_PATH ?? defaultSocketPath(),
  };
}

function findBinding(ctx: PiContext): ShepherdBinding | undefined {
  const entries = ctx.sessionManager.getEntries();
  const expectedGatewayId = process.env.SHEPHERD_GATEWAY_ID;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry) continue;
    if (
      entry.type === "custom" &&
      entry.customType === BINDING_ENTRY_TYPE &&
      entry.data?.sessionId
    ) {
      if (expectedGatewayId && entry.data.gatewayId && entry.data.gatewayId !== expectedGatewayId) {
        return undefined;
      }
      return {
        gatewayId: entry.data.gatewayId,
        sessionId: entry.data.sessionId,
        socketPath: entry.data.socketPath,
      };
    }
  }
  return undefined;
}

function textFromMessage(message: Message): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function promptGuidelinesFor(tool: GatewayTool, registeredName: string): string[] {
  if (
    Array.isArray(tool.promptGuidelines) &&
    tool.promptGuidelines.length > 0 &&
    tool.promptGuidelines.every((entry) => typeof entry === "string")
  ) {
    return tool.promptGuidelines;
  }
  return [`Use ${registeredName} when the task needs Shepherd session or Herdr orchestration.`];
}

class ShepherdGatewayClient {
  private buffer = "";
  private eventHandlers = new Set<(event: SessionEvent) => void>();
  private nextId = 1;
  private pending = new Map<
    string,
    {
      reject: (error: Error) => void;
      resolve: (value: unknown) => void;
    }
  >();
  private socket: Socket | undefined = undefined;

  constructor(private readonly socketPath: string) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = createConnection(this.socketPath);
      this.socket.once("connect", () => resolve());
      this.socket.once("error", reject);
      this.socket.on("data", (chunk) => this.onData(chunk.toString("utf8")));
      this.socket.on("close", () => this.rejectAll(new Error("Shepherd Gateway socket closed")));
    });
  }

  request<TMethod extends keyof GatewayResponseMap>(
    method: TMethod,
    params: Record<string, unknown> = {},
  ): Promise<GatewayResponseMap[TMethod]> {
    if (!this.socket) return Promise.reject(new Error("Shepherd Gateway socket is not connected"));
    const id = `shepherd-pi-${this.nextId++}`;
    const request: RpcRequest = { id, method, params };
    this.socket.write(`${JSON.stringify(request)}\n`);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    });
  }

  onEvent(handler: (event: SessionEvent) => void): () => boolean {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  close(): void {
    this.socket?.destroy();
    this.socket = undefined;
    this.rejectAll(new Error("Shepherd Gateway client closed"));
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const message = JSON.parse(line) as RpcResponse;
      if (message.method === "session.event" && message.params?.event) {
        for (const handler of this.eventHandlers) handler(message.params.event);
        continue;
      }
      if (message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (!pending) continue;
        if (message.error)
          pending.reject(new Error(message.error.message ?? "Shepherd RPC failed"));
        else pending.resolve(message.result);
      }
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
