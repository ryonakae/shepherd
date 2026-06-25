#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { argv, env, exit } from "node:process";
import { fileURLToPath } from "node:url";
import { loadShepherdConfig } from "@/config/load.js";
import { applyMigrations } from "@/db/apply-migrations.js";
import { openSqlite } from "@/db/client.js";
import { EventStore } from "@/db/event-store.js";
import { SessionBindingStore } from "@/db/session-bindings.js";
import { SessionSummaryStore } from "@/db/session-summary.js";
import { WorkingContextStore } from "@/db/working-contexts.js";
import { readOrCreateGatewayId } from "@/gateway/identity.js";
import { checkPiReadiness } from "@/gateway/pi-readiness.js";
import { PiSessionMetadataStore } from "@/gateway/pi-sessions.js";
import { HeadlessPiSupervisor } from "@/gateway/pi-supervisor.js";
import {
  getGatewayStatus,
  resolveGatewayControlPaths,
  startGatewayProcess,
  stopGatewayProcess,
} from "@/gateway/process-manager.js";
import { createConfiguredProviderOverrideResolver } from "@/gateway/provider-overrides.js";
import { recoverGatewayState } from "@/gateway/recovery.js";
import { createGatewayRuntime } from "@/gateway/runtime.js";
import { ShepherdGatewayServer } from "@/gateway/server.js";
import { WorkingContextResolver } from "@/gateway/working-contexts.js";
import { createPlatformRuntime } from "@/platforms/runtime.js";
import { ShepherdSessionClient } from "@/tui/client.js";

type GatewayAction = "restart" | "run" | "start" | "status" | "stop";

type GatewayRunCommand = {
  action: "run";
  command: "gateway";
  configPath?: string;
  dbPath: string;
  socketPath: string;
};

type GatewayManagedCommand = {
  action: Exclude<GatewayAction, "run">;
  command: "gateway";
  configPath?: string;
  dbPath: string;
  logPath?: string;
  pidPath?: string;
  socketPath: string;
  timeoutMs: number;
};

export type CliCommand =
  | GatewayRunCommand
  | GatewayManagedCommand
  | {
      command: "start-local";
      dbPath: string;
      socketPath: string;
      workingContextPath: string;
    }
  | {
      actorId?: string;
      command: "send";
      displayName?: string;
      providerOverride?: {
        model?: string;
        provider?: string;
      };
      sessionId: string;
      socketPath: string;
      text: string;
    }
  | {
      command: "rename";
      sessionId: string;
      socketPath: string;
      title: string | null;
    }
  | {
      command: "open";
      dbPath: string;
      sessionId: string;
      socketPath: string;
    }
  | {
      afterEventId: number;
      command: "watch";
      sessionId: string;
      socketPath: string;
    }
  | {
      afterEventId: number;
      command: "audit";
      dbPath: string;
      json: boolean;
      limit: number;
      sessionId: string;
    }
  | { command: "help" };

export function parseCliArgs(args: string[], environment: NodeJS.ProcessEnv = env): CliCommand {
  const [command, ...rest] = args;

  if (!command) {
    return {
      command: "start-local",
      dbPath: environment.SHEPHERD_DB_PATH ?? "shepherd.sqlite",
      socketPath: environment.SHEPHERD_GATEWAY_SOCKET_PATH ?? "/tmp/shepherd.sock",
      workingContextPath: process.cwd(),
    };
  }

  if (command === "--help" || command === "-h" || command === "help") {
    return { command: "help" };
  }

  if (command === "gateway") {
    const [action = "status", ...gatewayRest] = rest;
    if (!isGatewayAction(action)) {
      throw new Error(`Unknown gateway action: ${action}`);
    }

    const parsed = parseOptions(gatewayRest);
    const configPath = parsed.config ?? environment.SHEPHERD_CONFIG;
    const base = {
      command: "gateway" as const,
      dbPath: parsed.db ?? environment.SHEPHERD_DB_PATH ?? "shepherd.sqlite",
      socketPath: parsed.socket ?? environment.SHEPHERD_GATEWAY_SOCKET_PATH ?? "/tmp/shepherd.sock",
    };

    if (action === "run") {
      return configPath ? { ...base, action, configPath } : { ...base, action };
    }

    return {
      ...base,
      action,
      ...(configPath ? { configPath } : {}),
      ...(parsed.log ? { logPath: parsed.log } : {}),
      ...(parsed.pid ? { pidPath: parsed.pid } : {}),
      timeoutMs: parsed["timeout-ms"] ? Number(parsed["timeout-ms"]) : 10_000,
    };
  }

  if (command === "send") {
    const parsed = parseOptions(rest);
    if (!parsed.session || !parsed.text) {
      throw new Error("send requires --session and --text");
    }

    return {
      command: "send",
      sessionId: parsed.session,
      socketPath: parsed.socket ?? environment.SHEPHERD_GATEWAY_SOCKET_PATH ?? "/tmp/shepherd.sock",
      text: parsed.text,
      ...(parsed.actor ? { actorId: parsed.actor } : {}),
      ...(parsed["display-name"] ? { displayName: parsed["display-name"] } : {}),
      ...(parsed.provider || parsed.model
        ? {
            providerOverride: {
              ...(parsed.model ? { model: parsed.model } : {}),
              ...(parsed.provider ? { provider: parsed.provider } : {}),
            },
          }
        : {}),
    };
  }

  if (command === "open") {
    const parsed = parseOptions(rest);
    if (!parsed.session) {
      throw new Error("open requires --session");
    }

    return {
      command: "open",
      dbPath: parsed.db ?? environment.SHEPHERD_DB_PATH ?? "shepherd.sqlite",
      sessionId: parsed.session,
      socketPath: parsed.socket ?? environment.SHEPHERD_GATEWAY_SOCKET_PATH ?? "/tmp/shepherd.sock",
    };
  }

  if (command === "watch") {
    const parsed = parseOptions(rest);
    if (!parsed.session) {
      throw new Error("watch requires --session");
    }

    return {
      afterEventId: parsed.after ? Number(parsed.after) : 0,
      command: "watch",
      sessionId: parsed.session,
      socketPath: parsed.socket ?? environment.SHEPHERD_GATEWAY_SOCKET_PATH ?? "/tmp/shepherd.sock",
    };
  }

  if (command === "audit") {
    const parsed = parseOptions(rest);
    if (!parsed.session) {
      throw new Error("audit requires --session");
    }

    return {
      afterEventId: parsed.after ? Number(parsed.after) : 0,
      command: "audit",
      dbPath: parsed.db ?? environment.SHEPHERD_DB_PATH ?? "shepherd.sqlite",
      json: parsed.json === "true",
      limit: parsed.limit ? Number(parsed.limit) : 100,
      sessionId: parsed.session,
    };
  }

  if (command === "rename") {
    const parsed = parseOptions(rest);
    if (!parsed.session || parsed.title === undefined) {
      throw new Error("rename requires --session and --title");
    }

    return {
      command: "rename",
      sessionId: parsed.session,
      socketPath: parsed.socket ?? environment.SHEPHERD_GATEWAY_SOCKET_PATH ?? "/tmp/shepherd.sock",
      title: parsed.title.length === 0 ? null : parsed.title,
    };
  }

  throw new Error(`Unknown command: ${command}`);
}

export function helpText(): string {
  return `Usage:
  shepherd gateway start [--socket <path>] [--db <path>] [--config <path>] [--pid <path>] [--log <path>]
  shepherd gateway stop [--socket <path>] [--db <path>] [--pid <path>] [--timeout-ms <ms>]
  shepherd gateway restart [--socket <path>] [--db <path>] [--config <path>] [--pid <path>] [--log <path>] [--timeout-ms <ms>]
  shepherd gateway status [--socket <path>] [--db <path>] [--pid <path>]
  shepherd
  shepherd gateway run [--socket <path>] [--db <path>] [--config <path>]
  shepherd send --session <id> --text <text> [--socket <path>] [--actor <id>] [--display-name <name>] [--provider <name>] [--model <id>]
  shepherd open --session <id> [--socket <path>] [--db <path>]
  shepherd watch --session <id> [--socket <path>] [--after <event-id>]
  shepherd rename --session <id> --title <title> [--socket <path>]
  shepherd audit --session <id> [--db <path>] [--after <event-id>] [--limit <n>] [--json true]

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

export function gatewayStartHint(environment: NodeJS.ProcessEnv = env): string {
  return `Shepherd Gateway is not reachable. Start the Gateway first:\n  shepherd gateway start --config ${environment.SHEPHERD_CONFIG ?? "<path>"}`;
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
  command: Extract<CliCommand, { command: "start-local" }>,
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
  command: Extract<CliCommand, { command: "open" }>,
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

  if (command.command === "start-local") {
    try {
      exit(await runLocalPiStartup(command));
    } catch (error) {
      printLocalStartupError(error);
      exit(1);
    }
  }

  if (command.command === "gateway" && command.action !== "run") {
    const paths = resolveGatewayControlPaths({
      dbPath: command.dbPath,
      ...(command.logPath !== undefined ? { logPath: command.logPath } : {}),
      ...(command.pidPath !== undefined ? { pidPath: command.pidPath } : {}),
    });

    if (command.action === "status") {
      const status = await getGatewayStatus({ ...paths, socketPath: command.socketPath });
      console.log(JSON.stringify(status));
      return;
    }

    if (command.action === "stop") {
      const result = await stopGatewayProcess({
        pidPath: paths.pidPath,
        socketPath: command.socketPath,
        timeoutMs: command.timeoutMs,
      });
      console.log(JSON.stringify(result));
      return;
    }

    if (command.action === "restart") {
      await stopGatewayProcess({
        pidPath: paths.pidPath,
        socketPath: command.socketPath,
        timeoutMs: command.timeoutMs,
      });
    }

    const result = await startGatewayProcess({
      cliPath: fileURLToPath(import.meta.url),
      ...(command.configPath !== undefined ? { configPath: command.configPath } : {}),
      dbPath: command.dbPath,
      env,
      logPath: paths.logPath,
      nodePath: process.execPath,
      pidPath: paths.pidPath,
      socketPath: command.socketPath,
    });
    console.log(JSON.stringify({ ...result, logPath: paths.logPath, pidPath: paths.pidPath }));
    return;
  }

  if (command.command === "send") {
    const client = await ShepherdSessionClient.connect(command.socketPath);
    try {
      const result = await client.sendUserMessage({
        actorId: command.actorId ?? "tui:user",
        presentation: {
          displayName: command.displayName ?? command.actorId ?? "TUI User",
          sourcePlatform: "tui",
        },
        ...(command.providerOverride !== undefined
          ? { providerOverride: command.providerOverride }
          : {}),
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
      exit(await runOpenPiSession(command));
    } catch (error) {
      printLocalStartupError(error);
      exit(1);
    }
  }

  if (command.command === "watch") {
    const client = await ShepherdSessionClient.connect(command.socketPath);
    await client.subscribe({
      afterEventId: command.afterEventId,
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
    const client = await ShepherdSessionClient.connect(command.socketPath);
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
    const { sqlite } = openSqlite(command.dbPath);
    try {
      applyMigrations(sqlite, { migrationsFolder: "drizzle" });
      const events = new EventStore(sqlite);
      for (const event of events.listEvents(
        command.sessionId,
        command.afterEventId,
        command.limit,
      )) {
        console.log(command.json ? JSON.stringify(event) : formatAuditEvent(event));
      }
    } finally {
      sqlite.close();
    }
    return;
  }

  const stateDir = dirname(resolve(command.dbPath));
  const { sqlite } = openSqlite(command.dbPath);
  applyMigrations(sqlite, { migrationsFolder: "drizzle" });
  const events = new EventStore(sqlite);
  const sessionBindings = new SessionBindingStore(sqlite);
  const summaries = new SessionSummaryStore(sqlite);
  recoverGatewayState({ events, sqlite });
  const config = command.configPath ? loadConfigOrThrow(command.configPath) : undefined;
  const workingContexts = new WorkingContextResolver({
    allowedRoots: config?.context?.allowed_roots ?? [],
    allowUnconfiguredLocalPaths: true,
    store: new WorkingContextStore(sqlite),
  });
  const piSessions = new PiSessionMetadataStore({
    events,
    sessionDir: resolve(stateDir, "pi-sessions"),
  });
  let server: ShepherdGatewayServer;
  const gatewayRuntime = config
    ? createGatewayRuntime({
        config,
        events,
        piSessionDir: resolve(stateDir, "pi-sessions"),
        receiveHerdrProgress: async (input) => server.receiveHerdrProgress(input),
        sqlite,
      })
    : undefined;
  const headlessPi =
    config && gatewayRuntime && !gatewayRuntime.runner
      ? new HeadlessPiSupervisor({
          idleTimeoutMs: config.gateway.pi?.idle_timeout_ms ?? 600_000,
          socketPath: command.socketPath,
        })
      : undefined;
  const platformRuntime = config
    ? createPlatformRuntime({
        config,
        events,
        receiveUserMessage: async (input) => server.receiveUserMessage(input),
        sqlite,
      })
    : undefined;

  server = new ShepherdGatewayServer({
    gatewayId: readOrCreateGatewayId(stateDir),
    ...(platformRuntime?.deliveryFanout ? { deliveryFanout: platformRuntime.deliveryFanout } : {}),
    ...(platformRuntime?.streamDelivery ? { streamDelivery: platformRuntime.streamDelivery } : {}),
    ...(gatewayRuntime?.runner ? { gatewayRunner: gatewayRuntime.runner } : {}),
    ...(gatewayRuntime && !gatewayRuntime.runner ? { gatewayRuns: gatewayRuntime.runs } : {}),
    ...(headlessPi ? { headlessPi } : {}),
    localWorkingContexts: workingContexts,
    ...(gatewayRuntime ? { logicalTools: gatewayRuntime.tools } : {}),
    ...(config
      ? {
          providerOverrides: createConfiguredProviderOverrideResolver({
            bindings: sessionBindings,
            config,
          }),
        }
      : {}),
    piSessions,
    socketPath: command.socketPath,
    store: events,
    summaries,
    ...(command.configPath ? { configPath: command.configPath } : {}),
  });

  await server.start();
  if (config && shouldCheckPiReadiness(gatewayRuntime)) {
    await checkPiReadiness({
      socketPath: command.socketPath,
      timeoutMs: config.gateway.pi?.readiness_timeout_ms ?? 10_000,
      waitForHandshake: (timeoutMs) => server.waitForPiHandshake({ timeoutMs }),
    });
  }
  await platformRuntime?.start();
  console.log(`Shepherd gateway listening on ${command.socketPath}`);

  const stop = async () => {
    await platformRuntime?.close();
    headlessPi?.stopAll();
    await server.stop();
    await gatewayRuntime?.close();
    sqlite.close();
    exit(0);
  };

  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
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

function shouldCheckPiReadiness(
  gatewayRuntime: ReturnType<typeof createGatewayRuntime> | undefined,
): boolean {
  return gatewayRuntime !== undefined && gatewayRuntime.runner === undefined;
}

function loadConfigOrThrow(configPath: string) {
  const config = loadShepherdConfig(configPath);
  if (!config.ok) {
    throw new Error(
      `Invalid Shepherd config: ${config.errors.map((error) => error.message).join("; ")}`,
    );
  }

  return config.value;
}

function isGatewayAction(value: string): value is GatewayAction {
  return ["restart", "run", "start", "status", "stop"].includes(value);
}

function parseOptions(args: string[]): Record<string, string | undefined> {
  const options: Record<string, string | undefined> = {};

  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];

    if (!key?.startsWith("--") || !value) {
      throw new Error(`Invalid option: ${key ?? ""}`);
    }

    options[key.slice(2)] = value;
  }

  return options;
}

if (fileURLToPath(import.meta.url) === resolve(argv[1] ?? "")) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    exit(1);
  });
}
