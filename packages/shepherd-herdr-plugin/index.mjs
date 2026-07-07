#!/usr/bin/env node
// @ts-check
import { existsSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { resolve } from "node:path";

const DEFAULT_HOME_NAME = ".shepherd";

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
 * @property {string | null} [recommendedAction]
 * @property {string} [status]
 * @property {string | null} [summary]
 */

/**
 * @param {string[]} args
 * @param {PluginDeps} [deps]
 * @returns {Promise<number>}
 */
export async function runPluginCommand(args, deps = defaultDeps()) {
  const [command] = args;
  if (command === "observe-workspace") {
    return withClient(deps, (client) => observeWorkspace(deps, client));
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
    .map((worker) => [worker.status ?? "unknown", worker.agent ?? "unknown", worker.summary ?? "", worker.recommendedAction ?? ""].join("\t"))
    .join("\n");
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
 * @returns {Promise<number>}
 */
async function observeWorkspace(deps, client) {
  if (deps.env.HERDR_ENV !== "1" || !deps.env.HERDR_SOCKET_PATH || !deps.env.HERDR_WORKSPACE_ID) {
    deps.output("observe-workspace requires a Herdr-managed pane");
    return 2;
  }
  const observed = /** @type {{ observedWorkspace?: { id?: string } }} */ (
    await client.request("workspace.observe", {
      socketPath: deps.env.HERDR_SOCKET_PATH,
      workspaceId: deps.env.HERDR_WORKSPACE_ID,
    })
  );
  deps.output(`Observed workspace ${observed.observedWorkspace?.id ?? "unknown"}`);
  return 0;
}

/**
 * @param {PluginDeps} deps
 * @param {DaemonClient} client
 * @returns {Promise<number>}
 */
async function dashboard(deps, client) {
  let observedWorkspaceId = deps.env.SHEPHERD_OBSERVED_WORKSPACE_ID;
  if (!observedWorkspaceId) {
    /** @type {string[]} */
    const lines = [];
    const code = await observeWorkspace({ ...deps, output: (line) => lines.push(line) }, client);
    if (code !== 0) return code;
    observedWorkspaceId = /Observed workspace (\S+)/.exec(lines.at(-1) ?? "")?.[1];
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
    const record = /** @type {{ socketPath?: unknown }} */ (JSON.parse(readFileSync(recordPath, "utf8")));
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
