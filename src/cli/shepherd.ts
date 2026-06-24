#!/usr/bin/env node
import { resolve } from "node:path";
import { argv, env, exit } from "node:process";
import { fileURLToPath } from "node:url";
import { ShepherdDaemonServer } from "@/daemon/server.js";
import { applyMigrations } from "@/db/apply-migrations.js";
import { openSqlite } from "@/db/client.js";
import { EventStore } from "@/db/event-store.js";

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

  const server = new ShepherdDaemonServer({
    socketPath: command.socketPath,
    store: new EventStore(sqlite),
    ...(command.configPath ? { configPath: command.configPath } : {}),
  });

  await server.start();
  console.log(`Shepherd daemon listening on ${command.socketPath}`);

  const stop = async () => {
    await server.stop();
    sqlite.close();
    exit(0);
  };

  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
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
