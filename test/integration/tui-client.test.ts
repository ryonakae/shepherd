import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, test } from "vitest";
import { ShepherdDaemonServer } from "@/daemon/server.js";
import { applyMigrations } from "@/db/apply-migrations.js";
import { openSqlite } from "@/db/client.js";
import { EventStore } from "@/db/event-store.js";
import { LogicalToolRegistry, LogicalToolRunner } from "@/gateway/tools.js";
import { ShepherdSessionClient } from "@/tui/client.js";

const tempDirs: string[] = [];
const servers: ShepherdDaemonServer[] = [];
const clients: ShepherdSessionClient[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("ShepherdSessionClient", () => {
  test("subscribes to replayed and live session events", async () => {
    const { server, socketPath, store } = await openServer();
    servers.push(server);

    const session = store.createSession({ id: "session-1" });
    const replayed = store.appendEvent({
      payload: { text: "already there" },
      sessionId: session.id,
      type: "gateway.message",
    });
    const events: unknown[] = [];
    const client = await ShepherdSessionClient.connect(socketPath);
    clients.push(client);

    await expect(
      client.subscribe({
        afterEventId: 0,
        onEvent(event) {
          events.push(event);
        },
        sessionId: session.id,
      }),
    ).resolves.toEqual({ replayed: 1, subscribed: true });

    expect(events).toMatchObject([{ id: replayed.id, type: "gateway.message" }]);

    await client.sendUserMessage({
      actorId: "tui:user",
      presentation: { displayName: "TUI User", sourcePlatform: "tui" },
      sessionId: session.id,
      text: "hello from TUI",
    });
    await waitFor(() => events.length === 2);

    expect(events[1]).toMatchObject({
      actorId: "tui:user",
      payload: {
        presentation: { displayName: "TUI User", sourcePlatform: "tui" },
        text: "hello from TUI",
      },
      type: "user.message",
    });
  });

  test("renames sessions through the daemon socket", async () => {
    const { server, socketPath, store } = await openServer();
    servers.push(server);

    const session = store.createSession({ id: "session-1", title: "Old title" });
    const client = await ShepherdSessionClient.connect(socketPath);
    clients.push(client);

    await expect(
      client.renameSession({
        sessionId: session.id,
        title: "New title",
      }),
    ).resolves.toMatchObject({
      session: {
        id: session.id,
        title: "New title",
      },
    });
  });

  test("lists and runs logical tools through the daemon socket", async () => {
    const { server, socketPath, store } = await openServer({
      configureLogicalTools(events) {
        const registry = new LogicalToolRegistry();
        registry.register({
          description: "Echo a message",
          execute: (input: { text: string }) => ({ echoed: input.text }),
          inputSchema: Type.Object({ text: Type.String() }),
          name: "echo",
        });
        return new LogicalToolRunner({
          events,
          policy: { allowedTools: new Set(["echo"]) },
          registry,
        });
      },
    });
    servers.push(server);

    const session = store.createSession({ id: "session-1" });
    const client = await ShepherdSessionClient.connect(socketPath);
    clients.push(client);

    await expect(client.listTools()).resolves.toMatchObject({
      tools: [{ description: "Echo a message", name: "echo" }],
    });
    await expect(
      client.runTool({
        input: { text: "hello" },
        name: "echo",
        sessionId: session.id,
      }),
    ).resolves.toEqual({ output: { echoed: "hello" } });
  });
});

async function openServer(
  options: { configureLogicalTools?: (store: EventStore) => LogicalToolRunner } = {},
): Promise<{
  server: ShepherdDaemonServer;
  socketPath: string;
  store: EventStore;
}> {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-tui-client-"));
  tempDirs.push(dir);

  const { sqlite } = openSqlite(join(dir, "test.sqlite"));
  applyMigrations(sqlite, { migrationsFolder: "drizzle" });
  const store = new EventStore(sqlite);
  const socketPath = join(dir, "shepherd.sock");
  const server = new ShepherdDaemonServer({
    ...(options.configureLogicalTools
      ? { logicalTools: options.configureLogicalTools(store) }
      : {}),
    socketPath,
    store,
  });
  await server.start();

  return { server, socketPath, store };
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
