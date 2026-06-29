#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { argv, env, exit } from "node:process";
import { fileURLToPath } from "node:url";
import { resolveRuntime, runtimePathsFromRecordOrDefault } from "@/config/runtime.js";
import { applyMigrations } from "@/db/apply-migrations.js";
import { openSqlite } from "@/db/client.js";
import { EventStore } from "@/db/event-store.js";
import { readOrCreateGatewayId } from "@/gateway/identity.js";
import {
  getGatewayStatus,
  startGatewayProcess,
  stopGatewayProcess,
} from "@/gateway/process-manager.js";
import { ShepherdSessionClient } from "@/tui/client.js";

type GatewayAction = "restart" | "start" | "status" | "stop";

export type CliCommand =
  | { action: GatewayAction; command: "gateway" }
  | { command: "start-local"; workingContextPath: string }
  | { command: "send"; sessionId: string; text: string }
  | { command: "rename"; sessionId: string; title: string | null }
  | { command: "open"; sessionId: string }
  | { command: "watch"; sessionId: string }
  | { command: "audit"; sessionId: string }
  | { command: "help" };

type RuntimePathInput = {
  dbPath: string;
  socketPath: string;
};

type LocalPiStartupCommand = Extract<CliCommand, { command: "start-local" }> & RuntimePathInput;
type OpenPiSessionCommand = Extract<CliCommand, { command: "open" }> & RuntimePathInput;

export function parseCliArgs(args: string[]): CliCommand {
  const [command, ...rest] = args;

  if (!command) {
    return { command: "start-local", workingContextPath: process.cwd() };
  }

  if (command === "--help" || command === "-h" || command === "help") {
    if (rest.length > 0) {
      throw new Error(`Invalid argument: ${rest[0]}`);
    }
    return { command: "help" };
  }

  if (command === "gateway") {
    const [action = "status", ...extra] = rest;
    if (!isGatewayAction(action)) {
      throw new Error(`Unknown gateway action: ${action}`);
    }
    rejectExtra(extra);
    return { action, command: "gateway" };
  }

  if (command === "open") {
    const [sessionId, ...extra] = rest;
    if (!sessionId) {
      throw new Error("open requires <session-id>");
    }
    rejectExtra(extra);
    return { command: "open", sessionId };
  }

  if (command === "send") {
    const [sessionId, ...textParts] = rest;
    if (!sessionId || textParts.length === 0) {
      throw new Error("send requires <session-id> and <text>");
    }
    return { command: "send", sessionId, text: textParts.join(" ") };
  }

  if (command === "watch") {
    const [sessionId, ...extra] = rest;
    if (!sessionId) {
      throw new Error("watch requires <session-id>");
    }
    rejectExtra(extra);
    return { command: "watch", sessionId };
  }

  if (command === "rename") {
    const [sessionId, ...titleParts] = rest;
    if (!sessionId || titleParts.length === 0) {
      throw new Error("rename requires <session-id> and <title>");
    }
    const title = titleParts.join(" ");
    return { command: "rename", sessionId, title: title.length === 0 ? null : title };
  }

  if (command === "audit") {
    const [sessionId, ...extra] = rest;
    if (!sessionId) {
      throw new Error("audit requires <session-id>");
    }
    rejectExtra(extra);
    return { command: "audit", sessionId };
  }

  throw new Error(`Unknown command: ${command}`);
}

export function helpText(): string {
  return `Usage:
  shepherd
  shepherd gateway [start|stop|restart|status]
  shepherd open <session-id>
  shepherd send <session-id> <text>
  shepherd watch <session-id>
  shepherd rename <session-id> <title>
  shepherd audit <session-id>
  shepherd help

Commands:
  shepherd  Create a local Shepherd session for the current directory and open Pi
  gateway   Manage the local Shepherd Gateway
  send      Send a user message into a Shepherd session
  open      Open the matching Pi session in the Pi TUI
  watch     Print session events as JSON Lines
  rename    Rename a Shepherd session
  audit     Print stored session events from the SQLite audit log
  help      Show this help
`;
}

export function formatAuditEvent(event: ReturnType<EventStore["listEvents"]>[number]): string {
  const createdAt = event.createdAt.toISOString();
  const actor = event.actorId ?? "system";
  return `${event.id}\t${createdAt}\t${event.sessionId}\t${actor}\t${event.type}\t${JSON.stringify(
    event.payload,
  )}`;
}

export function gatewayStartHint(): string {
  return "Shepherd Gateway is not reachable. Start it with:\n  shepherd gateway start";
}

export class GatewayConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayConnectionError";
  }
}

type ShepherdClientLike = Pick<
  ShepherdSessionClient,
  "close" | "createSession" | "ensurePiSession"
>;

type LocalPiStartupDeps = {
  connect(socketPath: string): Promise<ShepherdClientLike>;
  readGatewayId(stateDir: string): string;
  runPi(input: {
    gatewayId: string;
    piSessionFile: string;
    sessionId: string;
    socketPath: string;
  }): Promise<number>;
};

const defaultLocalPiStartupDeps: LocalPiStartupDeps = {
  async connect(socketPath) {
    try {
      return await ShepherdSessionClient.connect(socketPath);
    } catch (error) {
      throw new GatewayConnectionError(error instanceof Error ? error.message : String(error));
    }
  },
  readGatewayId: (stateDir) => readOrCreateGatewayId(stateDir),
  runPi: (input) => runPiSession(input),
};

export async function runLocalPiStartup(
  command: LocalPiStartupCommand,
  deps: LocalPiStartupDeps = defaultLocalPiStartupDeps,
): Promise<number> {
  const stateDir = dirname(resolve(command.dbPath));
  const client = await deps.connect(command.socketPath);
  try {
    const { session } = await client.createSession({
      title: null,
      workingContextPath: command.workingContextPath,
    });
    const { pi } = await client.ensurePiSession({ sessionId: session.id });
    return await deps.runPi({
      gatewayId: deps.readGatewayId(stateDir),
      piSessionFile: pi.sessionFile,
      sessionId: session.id,
      socketPath: command.socketPath,
    });
  } finally {
    await client.close();
  }
}

export async function runOpenPiSession(
  command: OpenPiSessionCommand,
  deps: LocalPiStartupDeps = defaultLocalPiStartupDeps,
): Promise<number> {
  const stateDir = dirname(resolve(command.dbPath));
  const client = await deps.connect(command.socketPath);
  try {
    const { pi } = await client.ensurePiSession({ sessionId: command.sessionId });
    return await deps.runPi({
      gatewayId: deps.readGatewayId(stateDir),
      piSessionFile: pi.sessionFile,
      sessionId: command.sessionId,
      socketPath: command.socketPath,
    });
  } finally {
    await client.close();
  }
}

function printLocalStartupError(error: unknown): void {
  if (error instanceof GatewayConnectionError) {
    console.error(gatewayStartHint());
    return;
  }

  console.error(error instanceof Error ? error.message : String(error));
}

async function main(): Promise<void> {
  const command = parseCliArgs(argv.slice(2));

  if (command.command === "help") {
    console.log(helpText());
    return;
  }

  const runtime = resolveRuntimeForCommand(command);

  if (command.command === "start-local") {
    try {
      exit(
        await runLocalPiStartup({
          ...command,
          dbPath: runtime.paths.dbPath,
          socketPath: runtime.paths.socketPath,
        }),
      );
    } catch (error) {
      printLocalStartupError(error);
      exit(1);
    }
  }

  if (command.command === "gateway") {
    if (command.action === "status") {
      const status = await getGatewayStatus({
        pidPath: runtime.paths.pidPath,
        socketPath: runtime.paths.socketPath,
      });
      console.log(JSON.stringify(status));
      return;
    }

    if (command.action === "stop") {
      const result = await stopGatewayProcess({
        pidPath: runtime.paths.pidPath,
        socketPath: runtime.paths.socketPath,
        timeoutMs: 10_000,
      });
      console.log(JSON.stringify(result));
      return;
    }

    if (command.action === "restart") {
      await stopGatewayProcess({
        pidPath: runtime.paths.pidPath,
        socketPath: runtime.paths.socketPath,
        timeoutMs: 10_000,
      });
    }

    const result = await startGatewayProcess({
      entrypointPath: resolve(dirname(fileURLToPath(import.meta.url)), "shepherd-gateway.js"),
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
    console.log(
      JSON.stringify({
        ...result,
        logPath: runtime.paths.logPath,
        pidPath: runtime.paths.pidPath,
        socketPath: runtime.paths.socketPath,
      }),
    );
    return;
  }

  if (command.command === "send") {
    const client = await ShepherdSessionClient.connect(runtime.paths.socketPath);
    try {
      const result = await client.sendUserMessage({
        actorId: "tui:user",
        presentation: {
          displayName: "TUI User",
          sourcePlatform: "tui",
        },
        sessionId: command.sessionId,
        text: command.text,
      });
      console.log(JSON.stringify(result.event));
    } finally {
      await client.close();
    }
    return;
  }

  if (command.command === "open") {
    try {
      exit(
        await runOpenPiSession({
          ...command,
          dbPath: runtime.paths.dbPath,
          socketPath: runtime.paths.socketPath,
        }),
      );
    } catch (error) {
      printLocalStartupError(error);
      exit(1);
    }
  }

  if (command.command === "watch") {
    const client = await ShepherdSessionClient.connect(runtime.paths.socketPath);
    await client.subscribe({
      afterEventId: 0,
      onEvent(event) {
        console.log(JSON.stringify(event));
      },
      sessionId: command.sessionId,
    });

    const stop = async () => {
      await client.close();
      exit(0);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    return;
  }

  if (command.command === "rename") {
    const client = await ShepherdSessionClient.connect(runtime.paths.socketPath);
    try {
      const result = await client.renameSession({
        sessionId: command.sessionId,
        title: command.title,
      });
      console.log(JSON.stringify(result.session));
    } finally {
      await client.close();
    }
    return;
  }

  if (command.command === "audit") {
    const { sqlite } = openSqlite(runtime.paths.dbPath);
    try {
      applyMigrations(sqlite, { migrationsFolder: "drizzle" });
      const events = new EventStore(sqlite);
      for (const event of events.listEvents(command.sessionId, 0, 100)) {
        console.log(formatAuditEvent(event));
      }
    } finally {
      sqlite.close();
    }
  }
}

export function piOpenArgs(piSessionFile: string): string[] {
  return ["--session", piSessionFile];
}

export function piOpenEnvironment(input: {
  gatewayId?: string;
  environment?: NodeJS.ProcessEnv;
  sessionId: string;
  socketPath: string;
}): NodeJS.ProcessEnv {
  return {
    ...(input.environment ?? process.env),
    SHEPHERD_GATEWAY_ID: input.gatewayId ?? "default",
    SHEPHERD_SESSION_ID: input.sessionId,
    SHEPHERD_GATEWAY_SOCKET_PATH: input.socketPath,
  };
}

async function runPiSession(input: {
  gatewayId: string;
  piSessionFile: string;
  sessionId: string;
  socketPath: string;
}): Promise<number> {
  const child = spawn("pi", piOpenArgs(input.piSessionFile), {
    env: piOpenEnvironment({
      gatewayId: input.gatewayId,
      sessionId: input.sessionId,
      socketPath: input.socketPath,
    }),
    stdio: "inherit",
  });

  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 0));
  });
}

function resolveRuntimeForCommand(command: CliCommand) {
  if (command.command === "gateway" && (command.action === "status" || command.action === "stop")) {
    const runtime = resolveRuntime({ allowInvalidConfig: true, environment: env });
    if (runtime.configErrors !== undefined) {
      console.error(
        "Warning: Invalid Shepherd config; using last runtime record or home defaults for gateway status/stop.",
      );
      return {
        ...runtime,
        paths: runtimePathsFromRecordOrDefault({ environment: runtime.environment }),
      };
    }
    return runtime;
  }

  return resolveRuntime({ environment: env });
}

function isGatewayAction(value: string): value is GatewayAction {
  return ["restart", "start", "status", "stop"].includes(value);
}

function rejectExtra(args: string[]): void {
  if (args.length > 0) {
    throw new Error(`Invalid argument: ${args[0]}`);
  }
}

if (fileURLToPath(import.meta.url) === resolve(argv[1] ?? "")) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    exit(1);
  });
}
