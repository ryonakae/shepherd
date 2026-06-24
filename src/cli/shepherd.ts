#!/usr/bin/env node
import { resolve } from "node:path";
import { argv, env, exit } from "node:process";
import { fileURLToPath } from "node:url";
import { loadShepherdConfig } from "@/config/load.js";
import { ShepherdDaemonServer } from "@/daemon/server.js";
import { applyMigrations } from "@/db/apply-migrations.js";
import { openSqlite } from "@/db/client.js";
import { EventStore } from "@/db/event-store.js";
import { createGatewayRuntime, type GatewayRuntime } from "@/gateway/runtime.js";

export type CliCommand =
  | {
      command: "daemon";
      configPath?: string;
      dbPath: string;
      socketPath: string;
    }
  | { command: "help" };

export function parseCliArgs(args: string[], environment: NodeJS.ProcessEnv = env): CliCommand {
  const [command, ...rest] = args;

  if (!command || command === "--help" || command === "-h" || command === "help") {
    return { command: "help" };
  }

  if (command !== "daemon") {
    throw new Error(`Unknown command: ${command}`);
  }

  const parsed = parseOptions(rest);
  const configPath = parsed.config ?? environment.SHEPHERD_CONFIG;
  const baseCommand = {
    command: "daemon" as const,
    dbPath: parsed.db ?? environment.SHEPHERD_DB_PATH ?? "shepherd.sqlite",
    socketPath: parsed.socket ?? environment.SHEPHERD_SOCKET_PATH ?? "/tmp/shepherd.sock",
  };

  return configPath ? { ...baseCommand, configPath } : baseCommand;
}

export function helpText(): string {
  return `Usage:
  shepherd daemon [--socket <path>] [--db <path>] [--config <path>]

Commands:
  daemon    Start the local Shepherd daemon
  help      Show this help
`;
}

async function main(): Promise<void> {
  const command = parseCliArgs(argv.slice(2));

  if (command.command === "help") {
    console.log(helpText());
    return;
  }

  const { sqlite } = openSqlite(command.dbPath);
  applyMigrations(sqlite, { migrationsFolder: "drizzle" });
  const events = new EventStore(sqlite);
  const gatewayRuntime = command.configPath
    ? createRuntimeFromConfig(command.configPath, events, sqlite)
    : undefined;

  const server = new ShepherdDaemonServer({
    ...(gatewayRuntime ? { gatewayRunner: gatewayRuntime.runner } : {}),
    socketPath: command.socketPath,
    store: events,
    ...(command.configPath ? { configPath: command.configPath } : {}),
  });

  await server.start();
  console.log(`Shepherd daemon listening on ${command.socketPath}`);

  const stop = async () => {
    await server.stop();
    await gatewayRuntime?.close();
    sqlite.close();
    exit(0);
  };

  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

function createRuntimeFromConfig(
  configPath: string,
  events: EventStore,
  sqlite: ReturnType<typeof openSqlite>["sqlite"],
): GatewayRuntime {
  const config = loadShepherdConfig(configPath);
  if (!config.ok) {
    throw new Error(
      `Invalid Shepherd config: ${config.errors.map((error) => error.message).join("; ")}`,
    );
  }

  return createGatewayRuntime({
    config: config.value,
    events,
    sqlite,
  });
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
