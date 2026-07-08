#!/usr/bin/env node
import { createConnection } from "node:net";

const CURRENT_HERDR_CONTEXT_ERROR =
  "Shepherd agent commands require HERDR_ENV=1 and HERDR_WORKSPACE_ID. Run them inside a Herdr workspace.";

/** @typedef {{ request(method: string, params: unknown): Promise<unknown>, close(): void }} DaemonClient */
/** @typedef {{ reject(error: Error): void, resolve(value: unknown): void }} PendingRequest */
/** @typedef {{ env: NodeJS.ProcessEnv, output(line: string): void, clientFactory(): DaemonClient }} PluginDeps */
/** @typedef {{ text?: string | null }} CompactText */
/** @typedef {{ lastAssistantMessage?: CompactText | null, lastUserMessage?: CompactText | null }} CompactAgentHistory */
/** @typedef {{ agent?: string | null, agentStatus?: string | null, history?: CompactAgentHistory | null, paneId?: string | null }} AgentListItem */
/** @typedef {{ agents?: AgentListItem[] }} AgentListResult */

/**
 * @param {string[]} [args]
 * @param {PluginDeps} [deps]
 */
export async function runPluginCommand(args = process.argv.slice(2), deps = defaultDeps()) {
  const [command, ...rest] = args;
  const client = deps.clientFactory();
  try {
    if (command === "agent-list" || command === "agents") {
      if (rest.length > 0) {
        deps.output(`${command} accepts no arguments`);
        return 2;
      }
      return await agentList(deps, client);
    }
    deps.output("usage: node index.mjs agent-list|agents");
    return 2;
  } finally {
    client.close();
  }
}

/** @param {AgentListResult} input */
export function renderAgents(input) {
  const agents = input.agents ?? [];
  if (agents.length === 0) return "No Shepherd agents indexed.";
  return [
    ["status", "agent", "pane", "last user", "last assistant"].join("\t"),
    ...agents.map((agent) =>
      [
        agent.agentStatus ?? "unknown",
        agent.agent ?? "unknown",
        agent.paneId ?? "unknown",
        oneLine(agent.history?.lastUserMessage?.text ?? ""),
        oneLine(agent.history?.lastAssistantMessage?.text ?? ""),
      ].join("\t"),
    ),
  ].join("\n");
}

/**
 * @param {PluginDeps} deps
 * @param {DaemonClient} client
 */
async function agentList(deps, client) {
  if (deps.env.HERDR_ENV !== "1" || !deps.env.HERDR_WORKSPACE_ID) {
    deps.output(CURRENT_HERDR_CONTEXT_ERROR);
    return 2;
  }
  const result = /** @type {AgentListResult} */ (
    await client.request("agent.list", { workspaceId: deps.env.HERDR_WORKSPACE_ID })
  );
  deps.output(renderAgents(result));
  return 0;
}

/** @returns {PluginDeps} */
function defaultDeps() {
  return {
    clientFactory: () => new JsonLineDaemonClient(defaultSocketPath(process.env)),
    env: process.env,
    output: (/** @type {string} */ line) => console.log(line),
  };
}

/** @param {NodeJS.ProcessEnv} env */
function defaultSocketPath(env) {
  const home = (env.SHEPHERD_HOME || `${env.HOME || ""}/.shepherd`).replace(/\/$/, "");
  return `${home}/shepherd.sock`;
}

/** @param {unknown} value */
function oneLine(value) {
  return String(value).replace(/\s+/g, " ").slice(0, 120);
}

class JsonLineDaemonClient {
  #buffer = "";
  #nextId = 1;
  /** @type {Map<string, PendingRequest>} */
  #pending = new Map();
  /** @type {import("node:net").Socket} */
  #socket;

  /** @param {string} socketPath */
  constructor(socketPath) {
    this.#socket = createConnection(socketPath);
    this.#socket.on("data", (chunk) => this.#handleData(chunk.toString("utf8")));
    this.#socket.on("error", (error) => this.#rejectAll(error));
    this.#socket.on("close", () => this.#rejectAll(new Error("Shepherd daemon socket closed")));
  }

  close() {
    this.#socket.destroy();
  }

  /**
   * @param {string} method
   * @param {unknown} params
   */
  request(method, params) {
    const id = `plugin-${this.#nextId++}`;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { reject, resolve });
      this.#socket.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  /** @param {string} chunk */
  #handleData(chunk) {
    this.#buffer += chunk;
    let newline = this.#buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      newline = this.#buffer.indexOf("\n");
      if (!line) continue;
      const message = /** @type {{ error?: { message?: string }, id?: string, result?: unknown }} */ (
        JSON.parse(line)
      );
      if (!message.id) continue;
      const pending = this.#pending.get(message.id);
      if (!pending) continue;
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message ?? "Shepherd RPC failed"));
      else pending.resolve(message.result);
    }
  }

  /** @param {Error} error */
  #rejectAll(error) {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === `file://${entrypoint}`) {
  runPluginCommand().then((code) => process.exit(code));
}
