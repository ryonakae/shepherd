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

type DaemonAction = "restart" | "start" | "status" | "stop";

export type CliCommand =
  | { action: DaemonAction; command: "daemon" }
  | {
      command: "observe";
      herdrSessionName?: string;
      json: boolean;
      socketPath?: string;
      workspaceId: string;
    }
  | { command: "observe-current"; json: boolean; socketPath: string; workspaceId: string }
  | { command: "snapshot"; json: boolean; observedWorkspaceId: string }
  | { afterEventId?: number; command: "events"; json: boolean; observedWorkspaceId: string }
  | {
      autoResume: boolean;
      command: "notifications";
      json: boolean;
      observedWorkspaceId: string;
      subscriberId: string;
    }
  | { command: "ack"; eventId: number; json: boolean; subscriptionId: string }
  | { command: "message-worker"; text: string; workerId: string }
  | { command: "wait-worker"; state: string; timeoutMs?: number; workerId: string }
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

  if (command === "observe") {
    const json = takeFlag(rest, "--json");
    const herdrSessionName = takeOption(rest, "--herdr-session");
    const socketPath = takeOption(rest, "--socket");
    const workspaceId = takeOption(rest, "--workspace");
    if (!workspaceId || (!herdrSessionName && !socketPath)) {
      throw new Error("observe requires a Herdr selector and --workspace <workspace-id>");
    }
    rejectExtra(rest);
    return {
      command: "observe",
      ...(herdrSessionName ? { herdrSessionName } : {}),
      json,
      ...(socketPath ? { socketPath } : {}),
      workspaceId,
    };
  }

  if (command === "observe-current") {
    const json = takeFlag(rest, "--json");
    rejectExtra(rest);
    if (
      environment.HERDR_ENV !== "1" ||
      !environment.HERDR_SOCKET_PATH ||
      !environment.HERDR_WORKSPACE_ID
    ) {
      throw new Error("observe-current requires a Herdr-managed pane");
    }
    return {
      command: "observe-current",
      json,
      socketPath: environment.HERDR_SOCKET_PATH,
      workspaceId: environment.HERDR_WORKSPACE_ID,
    };
  }

  if (command === "snapshot") {
    const json = takeFlag(rest, "--json");
    const [observedWorkspaceId, ...extra] = rest;
    if (!observedWorkspaceId) throw new Error("snapshot requires <observed-workspace-id>");
    rejectExtra(extra);
    return { command: "snapshot", json, observedWorkspaceId };
  }

  if (command === "events") {
    const json = takeFlag(rest, "--json");
    const after = takeOption(rest, "--after");
    const [observedWorkspaceId, ...extra] = rest;
    if (!observedWorkspaceId) throw new Error("events requires <observed-workspace-id>");
    rejectExtra(extra);
    return {
      command: "events",
      ...(after ? { afterEventId: Number(after) } : {}),
      json,
      observedWorkspaceId,
    };
  }

  if (command === "notifications") {
    const json = takeFlag(rest, "--json");
    const autoResume = takeFlag(rest, "--auto-resume");
    const subscriberId = takeOption(rest, "--subscriber");
    const [observedWorkspaceId, ...extra] = rest;
    if (!observedWorkspaceId || !subscriberId)
      throw new Error("notifications requires <observed-workspace-id> --subscriber <id>");
    rejectExtra(extra);
    return { autoResume, command: "notifications", json, observedWorkspaceId, subscriberId };
  }

  if (command === "ack") {
    const json = takeFlag(rest, "--json");
    const subscriptionId = takeOption(rest, "--subscription");
    const eventId = takeOption(rest, "--event");
    if (!subscriptionId || !eventId)
      throw new Error("ack requires --subscription <id> --event <event-id>");
    rejectExtra(rest);
    return { command: "ack", eventId: Number(eventId), json, subscriptionId };
  }

  if (command === "message-worker") {
    const [workerId, ...textParts] = rest;
    if (!workerId || textParts.length === 0)
      throw new Error("message-worker requires <worker-id> <text>");
    return { command: "message-worker", text: textParts.join(" "), workerId };
  }

  if (command === "wait-worker") {
    const timeout = takeOption(rest, "--timeout-ms");
    const state = takeOption(rest, "--state");
    const [workerId, ...extra] = rest;
    if (!workerId || !state) throw new Error("wait-worker requires <worker-id> --state <state>");
    rejectExtra(extra);
    return {
      command: "wait-worker",
      state,
      ...(timeout ? { timeoutMs: Number(timeout) } : {}),
      workerId,
    };
  }

  throw new Error(`Unknown command: ${command}`);
}

export function helpText(): string {
  return `Usage:
  shepherd daemon [start|stop|restart|status]
  shepherd observe --herdr-session <name> --workspace <workspace-id> [--json]
  shepherd observe-current [--json]
  shepherd snapshot <observed-workspace-id> [--json]
  shepherd events <observed-workspace-id> [--after EVENT_ID] [--json]
  shepherd notifications <observed-workspace-id> --subscriber <id> [--auto-resume] [--json]
  shepherd ack --subscription <id> --event <event-id> [--json]
  shepherd message-worker <worker-id> <text>
  shepherd wait-worker <worker-id> --state <blocked|done|idle|unknown|working> [--timeout-ms N]
  shepherd help
`;
}

export async function runCliCommand(command: CliCommand, deps: RunCliDeps): Promise<void> {
  if (command.command === "help") {
    deps.output(helpText());
    return;
  }
  if (command.command === "daemon") {
    throw new Error("daemon command is handled by main");
  }

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
  switch (command.command) {
    case "observe":
      return client.request("workspace.observe", {
        ...(command.herdrSessionName ? { herdrSessionName: command.herdrSessionName } : {}),
        ...(command.socketPath ? { socketPath: command.socketPath } : {}),
        workspaceId: command.workspaceId,
      });
    case "observe-current":
      return client.request("workspace.observe", {
        socketPath: command.socketPath,
        workspaceId: command.workspaceId,
      });
    case "snapshot":
      return client.request("workspace.snapshot", {
        observedWorkspaceId: command.observedWorkspaceId,
      });
    case "events":
      return client.request("worker.events", {
        ...(command.afterEventId !== undefined ? { afterEventId: command.afterEventId } : {}),
        observedWorkspaceId: command.observedWorkspaceId,
      });
    case "notifications":
      return client.request("notification.subscribe", {
        autoResume: command.autoResume,
        observedWorkspaceId: command.observedWorkspaceId,
        subscriberId: command.subscriberId,
        subscriberKind: "cli",
      });
    case "ack":
      return client.request("notification.ack", {
        eventId: command.eventId,
        subscriptionId: command.subscriptionId,
      });
    case "message-worker":
      return client.request("worker.message", { text: command.text, workerId: command.workerId });
    case "wait-worker":
      return client.request("worker.wait_state", {
        state: command.state,
        ...(command.timeoutMs !== undefined ? { timeoutMs: command.timeoutMs } : {}),
        workerId: command.workerId,
      });
  }
}

function printResult(command: CliCommand, result: unknown, output: (line: string) => void): void {
  if ("json" in command && command.json) {
    output(JSON.stringify(result));
    return;
  }
  output(formatHumanResult(command, result));
}

function formatHumanResult(command: CliCommand, result: unknown): string {
  if (command.command === "observe" || command.command === "observe-current") {
    const observedWorkspace = (
      result as { observedWorkspace?: { id?: string; liveWorkspaceId?: string; status?: string } }
    ).observedWorkspace;
    return `Observed workspace ${observedWorkspace?.id ?? "unknown"} (${observedWorkspace?.status ?? "unknown"}) -> Herdr workspace ${observedWorkspace?.liveWorkspaceId ?? "unknown"}`;
  }
  return JSON.stringify(result);
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

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    exit(1);
  });
}
