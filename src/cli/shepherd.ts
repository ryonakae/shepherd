#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { argv, exit } from "node:process";
import { fileURLToPath } from "node:url";
import { resolveRuntime, runtimePathsFromRecordOrDefault } from "@/config/runtime.js";
import { ObservabilityRpcClient } from "@/daemon/client.js";
import {
  getDaemonStatus,
  startDaemonProcess,
  stopDaemonProcess,
} from "@/daemon/process-manager.js";
import type {
  AgentEventRecord,
  AgentGetResult,
  AgentListItem,
  AgentReadResult,
} from "@/observability/contracts.js";

const CURRENT_HERDR_WORKSPACE_ERROR =
  "agent command requires HERDR_ENV=1 with HERDR_WORKSPACE_ID, --workspace <id>, --session <name>, or --all.";

type DaemonAction = "restart" | "start" | "status" | "stop";

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
  | { command: "help" };

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
  if (!command || command === "--help" || command === "-h" || command === "help") {
    return { command: "help" };
  }

  if (command === "daemon") {
    const [action = "status", ...extra] = rest;
    if (!isDaemonAction(action)) throw new Error(`Unknown daemon action: ${action}`);
    rejectExtra(extra);
    return { action, command: "daemon" };
  }

  if (command === "agent") {
    return parseAgentCommand(rest, environment);
  }

  throw new Error(`Unknown command: ${command}`);
}

function parseAgentCommand(args: string[], environment: NodeJS.ProcessEnv): CliCommand {
  const [subcommand, ...rest] = args;
  if (!subcommand || subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    return { command: "help" };
  }
  const json = takeFlag(rest, "--json");
  const herdrSessionName = takeOption(rest, "--session");
  const workspaceId = takeOption(rest, "--workspace");
  const explicitScope: AgentScope = {
    ...(herdrSessionName ? { herdrSessionName } : {}),
    ...(workspaceId ? { workspaceId } : {}),
  };

  if (subcommand === "list") {
    const all = takeFlag(rest, "--all");
    rejectExtra(rest);
    return {
      command: "agent-list",
      ...(all ? { all: true } : scopedOrCurrent(explicitScope, environment)),
      json,
    };
  }

  if (subcommand === "get") {
    const [target, ...extra] = rest;
    if (!target) throw new Error("agent get requires <target>");
    rejectExtra(extra);
    return {
      command: "agent-get",
      ...scopedOrCurrent(explicitScope, environment),
      json,
      target,
    };
  }

  if (subcommand === "read") {
    const limitValue = takeOption(rest, "--limit");
    const [target, ...extra] = rest;
    if (!target) throw new Error("agent read requires <target>");
    rejectExtra(extra);
    const limit = limitValue ? Number(limitValue) : undefined;
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 500)) {
      throw new Error("--limit must be between 1 and 500");
    }
    return {
      command: "agent-read",
      ...scopedOrCurrent(explicitScope, environment),
      json,
      ...(limit !== undefined ? { limit } : {}),
      target,
    };
  }

  throw new Error(`Unknown agent command: ${subcommand}`);
}

function scopedOrCurrent(scope: AgentScope, environment: NodeJS.ProcessEnv): AgentScope {
  if (scope.herdrSessionName || scope.workspaceId || scope.all) return scope;
  if (environment.HERDR_ENV === "1" && environment.HERDR_WORKSPACE_ID) {
    return { workspaceId: environment.HERDR_WORKSPACE_ID };
  }
  throw new Error(CURRENT_HERDR_WORKSPACE_ERROR);
}

export function helpText(): string {
  return `Usage:
  shepherd daemon [start|stop|restart|status]
  shepherd agent list [--all] [--workspace <id>] [--session <name>] [--json]
  shepherd agent get <target> [--workspace <id>] [--session <name>] [--json]
  shepherd agent read <target> [--limit N] [--workspace <id>] [--session <name>] [--json]
  shepherd help
`;
}

export async function runCliCommand(command: CliCommand, deps: RunCliDeps): Promise<void> {
  if (command.command === "help") {
    deps.output(helpText());
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
  command: Exclude<CliCommand, { command: "daemon" | "help" }>,
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
  const lines = [["status", "agent", "pane", "last user", "last assistant", "updated"].join("\t")];
  for (const agent of agents) {
    lines.push(
      [
        agent.agentStatus,
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
  const lines = [`agent: ${agent.agent ?? "unknown"} ${agent.paneId}`, ""];
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

function takeOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value) throw new Error(`${name} requires a value`);
  args.splice(index, 2);
  return value;
}

function rejectExtra(args: string[]): void {
  if (args.length > 0) throw new Error(`Invalid argument: ${args[0]}`);
}

function isDaemonAction(value: string): value is DaemonAction {
  return value === "restart" || value === "start" || value === "status" || value === "stop";
}

function formatCliError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (
    message.includes("ENOENT") ||
    message.includes("ECONNREFUSED") ||
    message.includes("Shepherd daemon socket closed") ||
    message.includes("Observability RPC socket closed")
  ) {
    return `${message}\nRun \`shepherd daemon start\` before using Shepherd commands.`;
  }
  return message;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(formatCliError(error));
    exit(1);
  });
}
