#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { argv, exit } from "node:process";
import { fileURLToPath } from "node:url";
import { resolveRuntime, runtimePathsFromRecordOrDefault } from "@/config/runtime.js";
import { ObservabilityRpcClient } from "@/daemon/client.js";
import {
  getDaemonStatus,
  startDaemonProcess,
  stopDaemonProcess,
} from "@/daemon/process-manager.js";
import type { AgentGetResult, AgentListItem, AgentReadResult } from "@/observability/contracts.js";

const CURRENT_HERDR_WORKSPACE_ERROR =
  "agent command requires HERDR_ENV=1 with HERDR_WORKSPACE_ID, --workspace <id>, --session <name>, or --all.";

type DaemonAction = "restart" | "start" | "status" | "stop";
type HelpTopic =
  | "agent"
  | "agent-get"
  | "agent-list"
  | "agent-read"
  | "daemon"
  | `daemon-${DaemonAction}`
  | "root";

type AgentScope = {
  all?: boolean;
  herdrSessionName?: string;
  workspaceId?: string;
};

export type CliCommand =
  | { action: DaemonAction; command: "daemon" }
  | ({ command: "agent-list"; json: boolean } & AgentScope)
  | ({ command: "agent-get"; json: boolean; target: string } & AgentScope)
  | ({ command: "agent-read"; json: boolean; limit?: number; target: string } & AgentScope)
  | { command: "help"; topic: HelpTopic }
  | { command: "version" };

class CliUsageError extends Error {
  constructor(
    message: string,
    readonly helpTopic: HelpTopic,
  ) {
    super(message);
    this.name = "CliUsageError";
  }
}

type RpcClientLike = Pick<ObservabilityRpcClient, "close" | "request">;

type RunCliDeps = {
  connect(socketPath: string): Promise<RpcClientLike>;
  output(line: string): void;
  socketPath: string;
};

export function parseCliArgs(
  args: string[],
  environment: NodeJS.ProcessEnv = process.env,
): CliCommand {
  const [command, ...rest] = args;
  if (!command) return { command: "help", topic: "root" };
  if (isHelpFlag(command)) return { command: "help", topic: "root" };
  if (command === "--version" || command === "-v") {
    rejectExtra(rest, "root");
    return { command: "version" };
  }

  if (command === "daemon") return parseDaemonCommand(rest);
  if (command === "agent") return parseAgentCommand(rest, environment);

  throw new CliUsageError(`Unknown command: ${command}`, "root");
}

function parseDaemonCommand(args: string[]): CliCommand {
  const [action = "status", ...extra] = args;
  if (isHelpFlag(action)) return { command: "help", topic: "daemon" };
  if (!isDaemonAction(action)) {
    throw new CliUsageError(`Unknown daemon action: ${action}`, "daemon");
  }
  if (extra.some(isHelpFlag)) return { command: "help", topic: `daemon-${action}` };
  rejectExtra(extra, `daemon-${action}`);
  return { action, command: "daemon" };
}

function parseAgentCommand(args: string[], environment: NodeJS.ProcessEnv): CliCommand {
  const [subcommand, ...rest] = args;
  if (!subcommand || isHelpFlag(subcommand)) return { command: "help", topic: "agent" };
  const helpTopic = agentHelpTopic(subcommand);
  if (!helpTopic) {
    throw new CliUsageError(`Unknown agent command: ${subcommand}`, "agent");
  }
  if (rest.some(isHelpFlag)) return { command: "help", topic: helpTopic };

  const json = takeFlag(rest, "--json");
  const herdrSessionName = takeOption(rest, "--session", helpTopic);
  const workspaceId = takeOption(rest, "--workspace", helpTopic);
  const explicitScope: AgentScope = {
    ...(herdrSessionName ? { herdrSessionName } : {}),
    ...(workspaceId ? { workspaceId } : {}),
  };

  if (subcommand === "list") {
    const all = takeFlag(rest, "--all");
    rejectExtra(rest, helpTopic);
    return {
      command: "agent-list",
      ...(all ? { all: true } : scopedOrCurrent(explicitScope, environment, helpTopic)),
      json,
    };
  }

  if (subcommand === "get") {
    const [target, ...extra] = rest;
    if (!target) throw new CliUsageError("agent get requires <target>", helpTopic);
    rejectExtra(extra, helpTopic);
    return {
      command: "agent-get",
      ...scopedOrCurrent(explicitScope, environment, helpTopic),
      json,
      target,
    };
  }

  if (subcommand === "read") {
    const limitValue = takeOption(rest, "--limit", helpTopic);
    const [target, ...extra] = rest;
    if (!target) throw new CliUsageError("agent read requires <target>", helpTopic);
    rejectExtra(extra, helpTopic);
    const limit = limitValue ? Number(limitValue) : undefined;
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 500)) {
      throw new CliUsageError("--limit must be between 1 and 500", helpTopic);
    }
    return {
      command: "agent-read",
      ...scopedOrCurrent(explicitScope, environment, helpTopic),
      json,
      ...(limit !== undefined ? { limit } : {}),
      target,
    };
  }

  throw new CliUsageError(`Unknown agent command: ${subcommand}`, "agent");
}

function scopedOrCurrent(
  scope: AgentScope,
  environment: NodeJS.ProcessEnv,
  helpTopic: HelpTopic,
): AgentScope {
  if (scope.herdrSessionName || scope.workspaceId || scope.all) return scope;
  if (environment.HERDR_ENV === "1" && environment.HERDR_WORKSPACE_ID) {
    return { workspaceId: environment.HERDR_WORKSPACE_ID };
  }
  throw new CliUsageError(CURRENT_HERDR_WORKSPACE_ERROR, helpTopic);
}

export function helpText(topic: HelpTopic = "root"): string {
  switch (topic) {
    case "root":
      return `Shepherd observes coding agents managed by Herdr.

Usage:
  shepherd [options] <command>

Commands:
  agent     Inspect indexed coding agents
  daemon    Manage the Shepherd daemon

Options:
  -h, --help       Show help
  -v, --version    Show version

Run \`shepherd agent --help\` or \`shepherd daemon --help\` for command-specific help.
`;
    case "agent":
      return `Inspect indexed coding agents.

Usage:
  shepherd agent <command>

Commands:
  list            List indexed agents
  get <target>    Show one agent
  read <target>   Read one agent's recent messages

Options:
  -h, --help      Show help

Run \`shepherd agent <command> --help\` for command-specific help.
`;
    case "agent-list":
      return `List indexed agents.

Usage:
  shepherd agent list [options]

Options:
  --all                 Select all running Herdr workspaces
  --workspace <id>      Select a Herdr workspace
  --session <name>      Select a Herdr session
  --json                Print JSON
  -h, --help            Show help
`;
    case "agent-get":
      return `Show one indexed agent.

Usage:
  shepherd agent get <target> [options]

Options:
  --workspace <id>      Select a Herdr workspace
  --session <name>      Select a Herdr session
  --json                Print JSON
  -h, --help            Show help
`;
    case "agent-read":
      return `Read one agent's recent messages.

Usage:
  shepherd agent read <target> [options]

Options:
  --limit <number>      Return 1 to 500 messages
  --workspace <id>      Select a Herdr workspace
  --session <name>      Select a Herdr session
  --json                Print JSON
  -h, --help            Show help
`;
    case "daemon":
      return `Manage the Shepherd daemon.

Usage:
  shepherd daemon [command]

Commands:
  start       Start the daemon
  stop        Stop the daemon
  restart     Restart the daemon
  status      Show daemon status (default)

Options:
  -h, --help  Show help

Run \`shepherd daemon <command> --help\` for command-specific help.
`;
    case "daemon-start":
      return daemonActionHelp("start", "Start the Shepherd daemon.");
    case "daemon-stop":
      return daemonActionHelp("stop", "Stop the Shepherd daemon.");
    case "daemon-restart":
      return daemonActionHelp("restart", "Restart the Shepherd daemon.");
    case "daemon-status":
      return daemonActionHelp("status", "Show Shepherd daemon status.");
  }
}

export function versionText(): string {
  return `shepherd ${readPackageVersion()}`;
}

export async function runCliCommand(command: CliCommand, deps: RunCliDeps): Promise<void> {
  if (command.command === "help") {
    deps.output(helpText(command.topic));
    return;
  }
  if (command.command === "version") {
    deps.output(versionText());
    return;
  }
  if (command.command === "daemon") throw new Error("daemon command is handled by main");
  const client = await deps.connect(deps.socketPath);
  try {
    const result = await dispatchRpcCommand(command, client);
    printResult(command, result, deps.output);
  } finally {
    client.close();
  }
}

async function dispatchRpcCommand(
  command: Exclude<CliCommand, { command: "daemon" | "help" | "version" }>,
  client: RpcClientLike,
) {
  if (command.command === "agent-list") {
    return client.request("agent.list", scopeParams(command));
  }
  if (command.command === "agent-get") {
    return client.request("agent.get", { ...scopeParams(command), target: command.target });
  }
  return client.request("agent.read", {
    ...scopeParams(command),
    ...(command.limit !== undefined ? { limit: command.limit } : {}),
    target: command.target,
  });
}

function scopeParams(scope: AgentScope): AgentScope {
  return {
    ...(scope.all ? { all: true } : {}),
    ...(scope.herdrSessionName ? { herdrSessionName: scope.herdrSessionName } : {}),
    ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}),
  };
}

function printResult(command: CliCommand, result: unknown, output: (line: string) => void): void {
  if ("json" in command && command.json) {
    output(JSON.stringify(result));
    return;
  }
  output(formatHumanResult(command, result));
}

function formatHumanResult(command: CliCommand, result: unknown): string {
  if (command.command === "agent-list")
    return formatAgentList(result as { agents?: AgentListItem[] });
  if (command.command === "agent-get") return formatAgentGet(result as { agent?: AgentGetResult });
  if (command.command === "agent-read")
    return formatAgentRead(result as { agent?: AgentReadResult });
  return JSON.stringify(result);
}

function formatAgentList(result: { agents?: AgentListItem[] }): string {
  const agents = result.agents ?? [];
  if (agents.length === 0) return "No Shepherd agents indexed.";
  const lines = [
    ["status", "name", "agent", "pane", "last user", "last assistant", "updated"].join("\t"),
  ];
  for (const agent of agents) {
    lines.push(
      [
        agent.agentStatus,
        agent.name ?? "",
        agent.agent ?? "unknown",
        agent.paneId,
        oneLine(agent.history.lastUserMessage?.text ?? ""),
        oneLine(agent.history.lastAssistantMessage?.text ?? ""),
        agent.history.updatedAt ?? "",
      ].join("\t"),
    );
  }
  return lines.join("\n");
}

function formatAgentGet(result: { agent?: AgentGetResult }): string {
  const agent = result.agent;
  if (!agent) return "Agent not found.";
  return [
    `name: ${agent.name ?? "unnamed"}`,
    `agent: ${agent.agent ?? "unknown"}`,
    `status: ${agent.agentStatus}`,
    `pane: ${agent.paneId}`,
    `terminal: ${agent.terminalId ?? "unknown"}`,
    `workspace: ${agent.workspaceId}`,
    `Herdr session: ${agent.herdrSessionName}`,
    `cwd: ${agent.cwd ?? agent.foregroundCwd ?? "unknown"}`,
    `agent_session: ${agent.agentSession ? `${agent.agentSession.source}:${agent.agentSession.value}` : "none"}`,
    `last user: ${oneLine(agent.history.lastUserMessage?.text ?? "")}`,
    `last assistant: ${oneLine(agent.history.lastAssistantMessage?.text ?? "")}`,
    `last tool: ${agent.history.lastToolResult ? `${agent.history.lastToolResult.toolName} ${oneLine(agent.history.lastToolResult.text)}` : ""}`,
  ].join("\n");
}

function formatAgentRead(result: { agent?: AgentReadResult }): string {
  const agent = result.agent;
  if (!agent) return "Agent not found.";
  const lines = [
    `name: ${agent.name ?? "unnamed"}`,
    `agent: ${agent.agent ?? "unknown"}`,
    `pane: ${agent.paneId}`,
    "",
  ];
  for (const message of agent.messages) {
    lines.push(
      [
        message.timestamp ?? "",
        message.role,
        message.toolName ?? "",
        message.compact
          ? `[${message.compact.compaction.mode}] ${oneLine(message.text)}`
          : oneLine(message.text),
      ].join("\t"),
    );
  }
  return lines.join("\n");
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").slice(0, 160);
}

async function main(): Promise<void> {
  const command = parseCliArgs(argv.slice(2));
  if (command.command === "help") {
    console.log(helpText(command.topic));
    return;
  }
  if (command.command === "version") {
    console.log(versionText());
    return;
  }
  const runtime = resolveRuntimeForCommand();
  if (command.command === "daemon") {
    await runDaemonCommand(command, runtime);
    return;
  }
  await runCliCommand(command, {
    connect: (socketPath) => Promise.resolve(new ObservabilityRpcClient({ socketPath })),
    output: (line) => console.log(line),
    socketPath: runtime.paths.socketPath,
  });
}

async function runDaemonCommand(
  command: Extract<CliCommand, { command: "daemon" }>,
  runtime: ReturnType<typeof resolveRuntimeForCommand>,
): Promise<void> {
  if (command.action === "status") {
    console.log(
      JSON.stringify(
        await getDaemonStatus({
          pidPath: runtime.paths.pidPath,
          socketPath: runtime.paths.socketPath,
        }),
      ),
    );
    return;
  }
  if (command.action === "stop") {
    console.log(
      JSON.stringify(
        await stopDaemonProcess({
          pidPath: runtime.paths.pidPath,
          socketPath: runtime.paths.socketPath,
          timeoutMs: 10_000,
        }),
      ),
    );
    return;
  }
  if (command.action === "restart") {
    await stopDaemonProcess({
      pidPath: runtime.paths.pidPath,
      socketPath: runtime.paths.socketPath,
      timeoutMs: 10_000,
    });
  }
  const result = await startDaemonProcess({
    entrypointPath: resolve(dirname(fileURLToPath(import.meta.url)), "shepherd-daemon.js"),
    env: runtime.environment,
    logPath: runtime.paths.logPath,
    nodePath: process.execPath,
    pidPath: runtime.paths.pidPath,
    runtimeRecord: {
      dbPath: runtime.paths.dbPath,
      homeDir: runtime.homeDir,
      logPath: runtime.paths.logPath,
      pidPath: runtime.paths.pidPath,
      socketPath: runtime.paths.socketPath,
    },
    runtimeRecordPath: runtime.paths.runtimeRecordPath,
    socketPath: runtime.paths.socketPath,
  });
  console.log(JSON.stringify({ ...result, socketPath: runtime.paths.socketPath }));
}

function resolveRuntimeForCommand() {
  return runtimePathsFromRecordOrDefault({ environment: process.env })
    ? {
        environment: process.env,
        homeDir: resolveRuntime({ environment: process.env }).homeDir,
        paths: runtimePathsFromRecordOrDefault({ environment: process.env }),
      }
    : resolveRuntime({ environment: process.env });
}

function takeFlag(args: string[], name: string): boolean {
  const index = args.indexOf(name);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

function takeOption(args: string[], name: string, helpTopic: HelpTopic): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value) throw new CliUsageError(`${name} requires a value`, helpTopic);
  args.splice(index, 2);
  return value;
}

function rejectExtra(args: string[], helpTopic: HelpTopic): void {
  if (args.length > 0) throw new CliUsageError(`Invalid argument: ${args[0]}`, helpTopic);
}

function isDaemonAction(value: string): value is DaemonAction {
  return value === "restart" || value === "start" || value === "status" || value === "stop";
}

export function formatCliError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (
    message.includes("ENOENT") ||
    message.includes("ECONNREFUSED") ||
    message.includes("Shepherd daemon socket closed") ||
    message.includes("Observability RPC socket closed")
  ) {
    return `${message}\nRun \`shepherd daemon start\` before using Shepherd commands.`;
  }
  if (error instanceof CliUsageError) {
    return `${message}\nRun \`${helpInvocation(error.helpTopic)}\` for usage.`;
  }
  return message;
}

function agentHelpTopic(subcommand: string): HelpTopic | undefined {
  if (subcommand === "get" || subcommand === "list" || subcommand === "read") {
    return `agent-${subcommand}`;
  }
  return undefined;
}

function daemonActionHelp(action: DaemonAction, description: string): string {
  return `${description}

Usage:
  shepherd daemon ${action}

Options:
  -h, --help  Show help
`;
}

function helpInvocation(topic: HelpTopic): string {
  if (topic === "root") return "shepherd --help";
  return `shepherd ${topic.replaceAll("-", " ")} --help`;
}

function isHelpFlag(value: string): boolean {
  return value === "--help" || value === "-h";
}

function readPackageVersion(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  while (true) {
    const manifestPath = join(directory, "package.json");
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        name?: unknown;
        version?: unknown;
      };
      if (manifest.name === "@ryonakae/shepherd" && typeof manifest.version === "string") {
        return manifest.version;
      }
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error("Unable to locate @ryonakae/shepherd package.json");
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

export function shouldRunCliMain(input: {
  argvPath: string | undefined;
  modulePath: string;
  realArgvPath?: string | undefined;
}): boolean {
  const modulePath = resolve(input.modulePath);
  return [input.argvPath, input.realArgvPath]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .map((value) => resolve(value))
    .includes(modulePath);
}

function realpathOrUndefined(path: string | undefined): string | undefined {
  if (!path) return undefined;
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

const modulePath = fileURLToPath(import.meta.url);
if (
  shouldRunCliMain({
    argvPath: process.argv[1],
    modulePath,
    realArgvPath: realpathOrUndefined(process.argv[1]),
  })
) {
  main().catch((error: unknown) => {
    console.error(formatCliError(error));
    exit(1);
  });
}
