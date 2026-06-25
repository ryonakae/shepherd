#!/usr/bin/env node
import { resolve } from "node:path";
import { argv, env, exit } from "node:process";
import { fileURLToPath } from "node:url";
import { loadShepherdConfig } from "@/config/load.js";
import { recoverDaemonState } from "@/daemon/recovery.js";
import { ShepherdDaemonServer } from "@/daemon/server.js";
import { applyMigrations } from "@/db/apply-migrations.js";
import { openSqlite } from "@/db/client.js";
import { EventStore } from "@/db/event-store.js";
import { SessionBindingStore } from "@/db/session-bindings.js";
import { SessionSummaryStore } from "@/db/session-summary.js";
import { checkPiReadiness } from "@/gateway/pi-readiness.js";
import { createConfiguredProviderOverrideResolver } from "@/gateway/provider-overrides.js";
import { createGatewayRuntime } from "@/gateway/runtime.js";
import { createPlatformRuntime } from "@/platforms/runtime.js";
import { ShepherdSessionClient } from "@/tui/client.js";

export type CliCommand =
  | {
      command: "daemon";
      configPath?: string;
      dbPath: string;
      socketPath: string;
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

  if (!command || command === "--help" || command === "-h" || command === "help") {
    return { command: "help" };
  }

  if (command === "send") {
    const parsed = parseOptions(rest);
    if (!parsed.session || !parsed.text) {
      throw new Error("send requires --session and --text");
    }

    return {
      command: "send",
      sessionId: parsed.session,
      socketPath: parsed.socket ?? environment.SHEPHERD_SOCKET_PATH ?? "/tmp/shepherd.sock",
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

  if (command === "watch") {
    const parsed = parseOptions(rest);
    if (!parsed.session) {
      throw new Error("watch requires --session");
    }

    return {
      afterEventId: parsed.after ? Number(parsed.after) : 0,
      command: "watch",
      sessionId: parsed.session,
      socketPath: parsed.socket ?? environment.SHEPHERD_SOCKET_PATH ?? "/tmp/shepherd.sock",
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
      socketPath: parsed.socket ?? environment.SHEPHERD_SOCKET_PATH ?? "/tmp/shepherd.sock",
      title: parsed.title.length === 0 ? null : parsed.title,
    };
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
  shepherd send --session <id> --text <text> [--socket <path>] [--actor <id>] [--display-name <name>] [--provider <name>] [--model <id>]
  shepherd watch --session <id> [--socket <path>] [--after <event-id>]
  shepherd rename --session <id> --title <title> [--socket <path>]
  shepherd audit --session <id> [--db <path>] [--after <event-id>] [--limit <n>] [--json true]

Commands:
  daemon    Start the local Shepherd daemon
  send      Send a user message into a Shepherd session
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

async function main(): Promise<void> {
  const command = parseCliArgs(argv.slice(2));

  if (command.command === "help") {
    console.log(helpText());
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

  const { sqlite } = openSqlite(command.dbPath);
  applyMigrations(sqlite, { migrationsFolder: "drizzle" });
  const events = new EventStore(sqlite);
  const sessionBindings = new SessionBindingStore(sqlite);
  const summaries = new SessionSummaryStore(sqlite);
  recoverDaemonState({ events, sqlite });
  const config = command.configPath ? loadConfigOrThrow(command.configPath) : undefined;
  let server: ShepherdDaemonServer;
  const gatewayRuntime = config
    ? createGatewayRuntime({
        config,
        events,
        receiveHerdrProgress: async (input) => server.receiveHerdrProgress(input),
        sqlite,
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

  server = new ShepherdDaemonServer({
    ...(platformRuntime?.deliveryFanout ? { deliveryFanout: platformRuntime.deliveryFanout } : {}),
    ...(gatewayRuntime?.runner ? { gatewayRunner: gatewayRuntime.runner } : {}),
    ...(gatewayRuntime && !gatewayRuntime.runner ? { gatewayRuns: gatewayRuntime.runs } : {}),
    ...(gatewayRuntime ? { logicalTools: gatewayRuntime.tools } : {}),
    ...(config
      ? {
          providerOverrides: createConfiguredProviderOverrideResolver({
            bindings: sessionBindings,
            config,
          }),
        }
      : {}),
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
  console.log(`Shepherd daemon listening on ${command.socketPath}`);

  const stop = async () => {
    await platformRuntime?.close();
    await server.stop();
    await gatewayRuntime?.close();
    sqlite.close();
    exit(0);
  };

  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
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
