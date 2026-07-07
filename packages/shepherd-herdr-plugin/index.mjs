#!/usr/bin/env node
// @ts-check
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * @typedef {(command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => Promise<string>} ExecFn
 */

/**
 * @typedef {object} PluginDeps
 * @property {NodeJS.ProcessEnv} env
 * @property {ExecFn} exec
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
    return observeWorkspace(deps);
  }
  if (command === "dashboard") {
    return dashboard(deps);
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
 * @returns {Promise<number>}
 */
async function observeWorkspace(deps) {
  if (deps.env.HERDR_ENV !== "1" || !deps.env.HERDR_SOCKET_PATH || !deps.env.HERDR_WORKSPACE_ID) {
    deps.output("observe-workspace requires a Herdr-managed pane");
    return 2;
  }
  const raw = await deps.exec("shepherd", ["observe-current", "--json"], { env: deps.env });
  const parsed = /** @type {{ observedWorkspace?: { id?: string } }} */ (JSON.parse(raw));
  deps.output(`Observed workspace ${parsed.observedWorkspace?.id ?? "unknown"}`);
  return 0;
}

/**
 * @param {PluginDeps} deps
 * @returns {Promise<number>}
 */
async function dashboard(deps) {
  let observedWorkspaceId = deps.env.SHEPHERD_OBSERVED_WORKSPACE_ID;
  if (!observedWorkspaceId) {
    /** @type {string[]} */
    const lines = [];
    const code = await observeWorkspace({ ...deps, output: (line) => lines.push(line) });
    if (code !== 0) return code;
    observedWorkspaceId = /Observed workspace (\S+)/.exec(lines.at(-1) ?? "")?.[1];
  }
  if (!observedWorkspaceId) return 2;
  const raw = await deps.exec("shepherd", ["snapshot", observedWorkspaceId, "--json"], { env: deps.env });
  const parsed = /** @type {{ workers?: WorkerRow[] }} */ (JSON.parse(raw));
  deps.output(renderDashboard(parsed));
  return 0;
}

/**
 * @returns {PluginDeps}
 */
function defaultDeps() {
  return {
    env: process.env,
    async exec(command, args, options) {
      const { stdout } = await execFileAsync(command, args, { env: options.env });
      return stdout;
    },
    output: (line) => console.log(line),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runPluginCommand(process.argv.slice(2)).then((code) => process.exit(code));
}
