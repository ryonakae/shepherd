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

  test("persists a user message and wakes the gateway turn", async () => {
    const { server, socketPath, store } = await openServer({
      configureGatewayRunner(events) {
        const registry = new LogicalToolRegistry();
        return new GatewayRunner({
          events,
          provider: {
            async generate(input) {
              return { text: `Gateway saw: ${input.messages.at(-1)?.content ?? ""}` };
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
        id: "message-1",
        method: "session.user_message",
        params: {
          actorId: "user-1",
          presentation: { displayName: "Ryo", sourcePlatform: "tui" },
          sessionId: session.id,
          text: "please start",
        },
      }),
    );

    const messages = await readMessages(client, 5);

    expect(messages[0]).toMatchObject({
      id: "message-1",
      result: {
        event: {
          actorId: "user-1",
          payload: {
            presentation: { displayName: "Ryo", sourcePlatform: "tui" },
            text: "please start",
          },
          sessionId: session.id,
          type: "user.message",
        },
      },
    });
    expect(messages.slice(1).map((message) => eventType(message))).toEqual([
      "user.message",
      "gateway.run.started",
      "gateway.message",
      "gateway.run.completed",
    ]);
  });

  test("publishes appended and gateway message events to the delivery fanout", async () => {
    const delivered: unknown[] = [];
    const { server, socketPath, store } = await openServer({
      configureDeliveryFanout() {
        return {
          async deliverEvent(event) {
            delivered.push({ id: event.id, type: event.type });
          },
        };
      },
      configureGatewayRunner(events) {
        const registry = new LogicalToolRegistry();
        return new GatewayRunner({
          events,
          provider: {
            async generate() {
              return { text: "Gateway response" };
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
        id: "message-1",
        method: "session.user_message",
        params: {
          sessionId: session.id,
          text: "please start",
        },
      }),
    );
    await readMessages(client, 1);
    await waitFor(() => delivered.length === 4);

    expect(delivered).toEqual([
      expect.objectContaining({ type: "user.message" }),
      expect.objectContaining({ type: "gateway.run.started" }),
      expect.objectContaining({ type: "gateway.message" }),
      expect.objectContaining({ type: "gateway.run.completed" }),
    ]);
  });

  test("exposes a public user message receiver for platform adapters", async () => {
    const delivered: unknown[] = [];
    const { server, store } = await openServer({
      configureDeliveryFanout() {
        return {
          async deliverEvent(event) {
            delivered.push(event.type);
          },
        };
      },
      configureGatewayRunner(events) {
        const registry = new LogicalToolRegistry();
        return new GatewayRunner({
          events,
          provider: {
            async generate(input) {
              return { text: `Gateway saw ${input.messages.at(-1)?.content ?? ""}` };
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
    const result = await server.receiveUserMessage({
      actorId: "slack:T123:U123",
      idempotencyKey: "slack:T123:C123:1700000001.000001",
      presentation: {
        displayName: "U123",
        sourcePlatform: "slack",
        sourceUserId: "U123",
      },
      sessionId: session.id,
      text: "from Slack",
    });

    expect(result.event).toMatchObject({
      actorId: "slack:T123:U123",
      payload: {
        presentation: {
          displayName: "U123",
          sourcePlatform: "slack",
          sourceUserId: "U123",
        },
        text: "from Slack",
      },
      type: "user.message",
    });
    expect(result.gatewayEvents.map((event) => event.type)).toEqual([
      "gateway.run.started",
      "gateway.message",
      "gateway.run.completed",
    ]);
    expect(delivered).toEqual([
      "user.message",
      "gateway.run.started",
      "gateway.message",
      "gateway.run.completed",
    ]);
  });
});

async function openServer(
  options: {
    configPath?: string;
    configureDeliveryFanout?: () => {
      deliverEvent(event: ReturnType<EventStore["appendEvent"]>): Promise<unknown>;
    };
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
    ...(options.configureDeliveryFanout
      ? { deliveryFanout: options.configureDeliveryFanout() }
      : {}),
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

async function waitFor(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > 1_000) {
      throw new Error("Timed out while waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
