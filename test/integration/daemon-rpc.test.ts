import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { encodeJsonLine, JsonLineDecoder } from "@/daemon/json-lines.js";
import { ShepherdDaemonServer } from "@/daemon/server.js";
import { applyMigrations } from "@/db/apply-migrations.js";
import { openSqlite } from "@/db/client.js";
import { EventStore } from "@/db/event-store.js";
import { GatewayRunner } from "@/gateway/runner.js";
import { LogicalToolRegistry, LogicalToolRunner } from "@/gateway/tools.js";

const tempDirs: string[] = [];
const servers: ShepherdDaemonServer[] = [];
const sockets: Socket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    socket.destroy();
  }
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("ShepherdDaemonServer JSON Lines RPC", () => {
  test("replays subscribed session events after a cursor", async () => {
    const { server, socketPath, store } = await openServer();
    servers.push(server);

    const session = store.createSession({ id: "session-1" });
    const first = store.appendEvent({
      payload: { text: "already seen" },
      sessionId: session.id,
      type: "user.message",
    });
    const second = store.appendEvent({
      payload: { text: "missed" },
      sessionId: session.id,
      type: "gateway.message",
    });

    const client = await connect(socketPath);
    client.write(
      encodeJsonLine({
        id: "subscribe-1",
        method: "session.subscribe",
        params: { afterEventId: first.id, sessionId: session.id },
      }),
    );

    const messages = await readMessages(client, 2);

    expect(messages[0]).toEqual({ id: "subscribe-1", result: { replayed: 1, subscribed: true } });
    expect(messages[1]).toMatchObject({
      method: "session.event",
      params: {
        event: {
          createdAt: second.createdAt.toISOString(),
          id: second.id,
          payload: { text: "missed" },
          sessionId: session.id,
          type: "gateway.message",
        },
      },
    });
  });

  test("broadcasts appended events to live subscribers", async () => {
    const { server, socketPath, store } = await openServer();
    servers.push(server);

    const session = store.createSession({ id: "session-1" });
    const client = await connect(socketPath);
    client.write(
      encodeJsonLine({
        id: "subscribe-1",
        method: "session.subscribe",
        params: { afterEventId: 0, sessionId: session.id },
      }),
    );
    await readMessages(client, 1);

    client.write(
      encodeJsonLine({
        id: "append-1",
        method: "session.append_event",
        params: {
          payload: { text: "hello from TUI" },
          sessionId: session.id,
          type: "user.message",
        },
      }),
    );

    const messages = await readMessages(client, 2);

    expect(messages[0]).toMatchObject({
      id: "append-1",
      result: {
        event: {
          payload: { text: "hello from TUI" },
          sessionId: session.id,
          type: "user.message",
        },
      },
    });
    expect(messages[1]).toMatchObject({
      method: "session.event",
      params: {
        event: {
          payload: { text: "hello from TUI" },
          sessionId: session.id,
          type: "user.message",
        },
      },
    });
  });

  test("reloads config through RPC", async () => {
    const configPath = writeTempFile(
      "shepherd.yaml",
      `
gateway:
  default_provider: codex
  model: gpt-5.3-codex
providers:
  codex:
    type: codex_cli
    mode: app_server
    auth_source: codex_cli
default_agent: implementer
agents:
  implementer:
    command: codex
`,
    );
    const { server, socketPath } = await openServer({ configPath });
    servers.push(server);

    const client = await connect(socketPath);
    client.write(encodeJsonLine({ id: "reload-1", method: "config.reload" }));

    await expect(readMessages(client, 1)).resolves.toEqual([
      { id: "reload-1", result: { ok: true } },
    ]);
  });

  test("runs a gateway turn through RPC and broadcasts resulting events", async () => {
    const { server, socketPath, store } = await openServer({
      configureGatewayRunner(events) {
        const registry = new LogicalToolRegistry();
        return new GatewayRunner({
          events,
          provider: {
            async generate() {
              return { text: "I will start Herdr work now." };
            },
          },
          tools: new LogicalToolRunner({
            events,
            policy: { allowedTools: new Set() },
            registry,
          }),
        });
      },
    });
    servers.push(server);

    const session = store.createSession({ id: "session-1" });
    const client = await connect(socketPath);
    client.write(
      encodeJsonLine({
        id: "subscribe-1",
        method: "session.subscribe",
        params: { afterEventId: 0, sessionId: session.id },
      }),
    );
    await readMessages(client, 1);

    client.write(
      encodeJsonLine({
        id: "gateway-1",
        method: "gateway.run_turn",
        params: {
          messages: [{ content: "please coordinate this", role: "user" }],
          sessionId: session.id,
        },
      }),
    );

    const messages = await readMessages(client, 4);

    expect(messages[0]).toEqual({
      id: "gateway-1",
      result: { text: "I will start Herdr work now." },
    });
    expect(messages.slice(1).map((message) => eventType(message))).toEqual([
      "gateway.run.started",
      "gateway.message",
      "gateway.run.completed",
    ]);
  });
});

async function openServer(
  options: {
    configPath?: string;
    configureGatewayRunner?: (store: EventStore) => GatewayRunner;
  } = {},
): Promise<{
  server: ShepherdDaemonServer;
  socketPath: string;
  store: EventStore;
}> {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-daemon-"));
  tempDirs.push(dir);

  const { sqlite } = openSqlite(join(dir, "test.sqlite"));
  applyMigrations(sqlite, { migrationsFolder: "drizzle" });
  const store = new EventStore(sqlite);
  const socketPath = join(dir, "shepherd.sock");
  const server = new ShepherdDaemonServer({
    ...(options.configureGatewayRunner
      ? { gatewayRunner: options.configureGatewayRunner(store) }
      : {}),
    socketPath,
    store,
    ...(options.configPath ? { configPath: options.configPath } : {}),
  });
  await server.start();

  return { server, socketPath, store };
}

function writeTempFile(name: string, contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-file-"));
  tempDirs.push(dir);

  const path = join(dir, name);
  writeFileSync(path, contents);

  return path;
}

function connect(socketPath: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    sockets.push(socket);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

function readMessages(socket: Socket, count: number): Promise<unknown[]> {
  const decoder = new JsonLineDecoder();
  const messages: unknown[] = [];

  return new Promise((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      try {
        messages.push(...decoder.push(chunk.toString("utf8")));
        if (messages.length >= count) {
          socket.off("data", onData);
          socket.off("error", reject);
          resolve(messages.slice(0, count));
        }
      } catch (error) {
        reject(error);
      }
    };

    socket.on("data", onData);
    socket.once("error", reject);
  });
}

function eventType(message: unknown): string | undefined {
  return (message as { params?: { event?: { type?: string } } }).params?.event?.type;
}
