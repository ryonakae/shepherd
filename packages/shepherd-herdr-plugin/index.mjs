#!/usr/bin/env node
// @ts-check
import { existsSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { resolve } from "node:path";

const DEFAULT_HOME_NAME = ".shepherd";
const CURRENT_HERDR_CONTEXT_ERROR =
  "--current requires HERDR_ENV=1, HERDR_SOCKET_PATH, and HERDR_WORKSPACE_ID. Run it inside a Herdr-managed pane or plugin command.";

/**
 * @typedef {object} DaemonClient
 * @property {() => void} close
 * @property {(method: string, params: unknown) => Promise<unknown>} request
 */

/**
 * @typedef {object} PluginDeps
 * @property {NodeJS.ProcessEnv} env
 * @property {() => DaemonClient} clientFactory
 * @property {(line: string) => void} output
 */

/**
 * @typedef {object} WorkerRow
 * @property {string | null} [agent]
 * @property {string} [id]
 * @property {string | null} [recommendedAction]
 * @property {string} [status]
 * @property {string | null} [summary]
 * @property {string | null} [workerId]
 */

/**
 * @typedef {object} ContextResult
 * @property {{ id?: string, liveWorkspaceId?: string | null, status?: string }} observedWorkspace
 * @property {WorkerRow[]} workers
 * @property {{ subscription: unknown | null, events: unknown[] }} notifications
 */

/**
 * @param {string[]} args
 * @param {PluginDeps} [deps]
 * @returns {Promise<number>}
 */
export async function runPluginCommand(args, deps = defaultDeps()) {
  const [command, ...rest] = args;
  if (command === "context") {
    const parsed = parseContextArgs(rest);
    if (parsed.error) {
      deps.output(parsed.error);
      return 2;
    }
    return withClient(deps, (client) => context(deps, client, parsed.subscriberId));
  }
  if (command === "dashboard") {
    return withClient(deps, (client) => dashboard(deps, client));
  }
  deps.output(`Unknown command: ${command ?? ""}`);
  return 1;
}

/**
 * @param {{ workers?: WorkerRow[] }} input
 * @returns {string}
 */
export function renderDashboard(input) {
  const workers = input.workers ?? [];
  if (workers.length === 0) {
    return "No Shepherd workers observed.";
  }
  return workers
    .map((worker) =>
      [
        worker.status ?? "unknown",
        worker.agent ?? "unknown",
        worker.summary ?? "",
        worker.recommendedAction ?? "",
      ].join("\t"),
    )
    .join("\n");
}

/**
 * @param {string[]} args
 * @returns {{ error?: string, subscriberId?: string }}
 */
function parseContextArgs(args) {
  const rest = [...args];
  let subscriberId;
  const subscriberIndex = rest.indexOf("--subscriber");
  if (subscriberIndex >= 0) {
    subscriberId = rest[subscriberIndex + 1];
    if (!subscriberId) return { error: "context accepts only --subscriber <id>" };
    rest.splice(subscriberIndex, 2);
  }
  if (rest.length > 0) return { error: "context accepts only --subscriber <id>" };
  return subscriberId ? { subscriberId } : {};
}

/**
 * @param {PluginDeps} deps
 * @param {(client: DaemonClient) => Promise<number>} fn
 * @returns {Promise<number>}
 */
async function withClient(deps, fn) {
  const client = deps.clientFactory();
  try {
    return await fn(client);
  } finally {
    client.close();
  }
}

/**
 * @param {PluginDeps} deps
 * @param {DaemonClient} client
 * @param {string | undefined} subscriberId
 * @returns {Promise<number>}
 */
async function context(deps, client, subscriberId) {
  const observedWorkspace = await observeCurrentWorkspace(deps, client);
  if (!observedWorkspace?.id) return 2;

  const snapshot = /** @type {{ workers?: WorkerRow[] }} */ (
    await client.request("workspace.snapshot", { observedWorkspaceId: observedWorkspace.id })
  );
  let notifications = /** @type {ContextResult["notifications"]} */ ({ subscription: null, events: [] });
  if (subscriberId) {
    const subscribed = /** @type {{ subscription?: unknown, events?: unknown[] }} */ (
      await client.request("notification.subscribe", {
        autoResume: false,
        observedWorkspaceId: observedWorkspace.id,
        subscriberId,
        subscriberKind: "cli",
      })
    );
    notifications = {
      subscription: subscribed.subscription ?? null,
      events: subscribed.events ?? [],
    };
  }

  deps.output(
    renderContext({
      observedWorkspace,
      workers: snapshot.workers ?? [],
      notifications,
    }),
  );
  return 0;
}

/**
 * @param {PluginDeps} deps
 * @param {DaemonClient} client
 * @returns {Promise<{ id?: string, liveWorkspaceId?: string | null, status?: string } | undefined>}
 */
async function observeCurrentWorkspace(deps, client) {
  if (deps.env.HERDR_ENV !== "1" || !deps.env.HERDR_SOCKET_PATH || !deps.env.HERDR_WORKSPACE_ID) {
    deps.output(CURRENT_HERDR_CONTEXT_ERROR);
    return undefined;
  }
  const observed = /** @type {{ observedWorkspace?: { id?: string, liveWorkspaceId?: string | null, status?: string } }} */ (
    await client.request("workspace.observe", {
      socketPath: deps.env.HERDR_SOCKET_PATH,
      workspaceId: deps.env.HERDR_WORKSPACE_ID,
    })
  );
  return observed.observedWorkspace;
}

/**
 * @param {ContextResult} result
 * @returns {string}
 */
function renderContext(result) {
  const lines = [
    `Observed workspace: ${result.observedWorkspace.id ?? "unknown"}`,
    `Workers: ${result.workers.length}`,
    `Notifications: ${result.notifications.events.length}`,
  ];
  if (result.workers.length === 0) return lines.join("\n");

  lines.push("", ["status", "agent", "worker", "summary", "action"].join("\t"));
  for (const worker of result.workers) {
    lines.push(
      [
        worker.status ?? "unknown",
        worker.agent ?? "unknown",
        worker.id ?? worker.workerId ?? "workspace",
        worker.summary ?? "",
        worker.recommendedAction ?? "",
      ].join("\t"),
    );
  }
  return lines.join("\n");
}

/**
 * @param {PluginDeps} deps
 * @param {DaemonClient} client
 * @returns {Promise<number>}
 */
async function dashboard(deps, client) {
  let observedWorkspaceId = deps.env.SHEPHERD_OBSERVED_WORKSPACE_ID;
  if (!observedWorkspaceId) {
    observedWorkspaceId = (await observeCurrentWorkspace(deps, client))?.id;
  }
  if (!observedWorkspaceId) return 2;
  const snapshot = /** @type {{ workers?: WorkerRow[] }} */ (
    await client.request("workspace.snapshot", { observedWorkspaceId })
  );
  deps.output(renderDashboard(snapshot));
  return 0;
}

/**
 * @returns {PluginDeps}
 */
function defaultDeps() {
  return {
    clientFactory: () => new JsonLineDaemonClient(defaultSocketPath(process.env)),
    env: process.env,
    output: (line) => console.log(line),
  };
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
export function defaultSocketPath(env = process.env) {
  const home = resolve(env.SHEPHERD_HOME?.trim() || resolve(homedir(), DEFAULT_HOME_NAME));
  const recordPath = resolve(home, "runtime.json");
  if (existsSync(recordPath)) {
    const record = /** @type {{ socketPath?: unknown }} */ (
      JSON.parse(readFileSync(recordPath, "utf8"))
    );
    if (typeof record.socketPath === "string" && record.socketPath.length > 0) {
      return record.socketPath;
    }
  }
  return resolve(home, "shepherd.sock");
}

/** @typedef {{ reject(error: Error): void; resolve(value: unknown): void }} Pending */

class JsonLineDaemonClient {
  /** @type {Map<string, Pending>} */
  #pending = new Map();
  /** @type {import("node:net").Socket} */
  #socket;
  #buffer = "";
  #nextId = 1;

  /**
   * @param {string} socketPath
   */
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
   * @returns {Promise<unknown>}
   */
  request(method, params) {
    const id = String(this.#nextId++);
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { reject, resolve });
      this.#socket.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  /**
   * @param {string} chunk
   */
  #handleData(chunk) {
    this.#buffer += chunk;
    let newline = this.#buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      newline = this.#buffer.indexOf("\n");
      if (!line) continue;
      const response = /** @type {{ error?: { message?: string }; id?: string; result?: unknown }} */ (
        JSON.parse(line)
      );
      if (!response.id) continue;
      const pending = this.#pending.get(response.id);
      if (!pending) continue;
      this.#pending.delete(response.id);
      if (response.error) pending.reject(new Error(response.error.message ?? "Shepherd daemon error"));
      else pending.resolve(response.result);
    }
  }

  /**
   * @param {Error} error
   */
  #rejectAll(error) {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runPluginCommand(process.argv.slice(2)).then((code) => process.exit(code));
}
