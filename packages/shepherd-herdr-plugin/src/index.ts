#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type ExecFn = (command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => Promise<string>;

type PluginDeps = {
  env: NodeJS.ProcessEnv;
  exec: ExecFn;
  output(line: string): void;
};

type WorkerRow = {
  agent?: string | null;
  recommendedAction?: string | null;
  status?: string;
  summary?: string | null;
};

export async function runPluginCommand(args: string[], deps: PluginDeps = defaultDeps()): Promise<number> {
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

export function renderDashboard(input: { workers?: WorkerRow[] }): string {
  const workers = input.workers ?? [];
  if (workers.length === 0) {
    return "No Shepherd workers observed.";
  }
  return workers
    .map((worker) => [worker.status ?? "unknown", worker.agent ?? "unknown", worker.summary ?? "", worker.recommendedAction ?? ""].join("\t"))
    .join("\n");
}

async function observeWorkspace(deps: PluginDeps): Promise<number> {
  if (deps.env.HERDR_ENV !== "1" || !deps.env.HERDR_SOCKET_PATH || !deps.env.HERDR_WORKSPACE_ID) {
    deps.output("observe-workspace requires a Herdr-managed pane");
    return 2;
  }
  const raw = await deps.exec("shepherd", ["observe-current", "--json"], { env: deps.env });
  const parsed = JSON.parse(raw) as { observedWorkspace?: { id?: string } };
  deps.output(`Observed workspace ${parsed.observedWorkspace?.id ?? "unknown"}`);
  return 0;
}

async function dashboard(deps: PluginDeps): Promise<number> {
  let observedWorkspaceId = deps.env.SHEPHERD_OBSERVED_WORKSPACE_ID;
  if (!observedWorkspaceId) {
    const lines: string[] = [];
    const code = await observeWorkspace({ ...deps, output: (line) => lines.push(line) });
    if (code !== 0) return code;
    observedWorkspaceId = /Observed workspace (\S+)/.exec(lines.at(-1) ?? "")?.[1];
  }
  if (!observedWorkspaceId) return 2;
  const raw = await deps.exec("shepherd", ["snapshot", observedWorkspaceId, "--json"], { env: deps.env });
  const parsed = JSON.parse(raw) as { workers?: WorkerRow[] };
  deps.output(renderDashboard(parsed));
  return 0;
}

function defaultDeps(): PluginDeps {
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
