import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, test } from "vitest";
import { applyMigrations } from "@/db/apply-migrations.js";
import { openSqlite } from "@/db/client.js";
import { EventStore } from "@/db/event-store.js";
import { WorkingContextStore } from "@/db/working-contexts.js";
import { PiSessionMetadataStore } from "@/gateway/pi-sessions.js";
import { ShepherdGatewayServer } from "@/gateway/server.js";
import { LogicalToolRegistry, LogicalToolRunner } from "@/gateway/tools.js";
import { WorkingContextResolver } from "@/gateway/working-contexts.js";
import { ShepherdSessionClient } from "@/tui/client.js";

const tempDirs: string[] = [];
const servers: ShepherdGatewayServer[] = [];
const clients: ShepherdSessionClient[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("ShepherdSessionClient", () => {
  test("creates sessions through the gateway socket", async () => {
    const { server, socketPath, store } = await openServer();
    servers.push(server);

    const client = await ShepherdSessionClient.connect(socketPath);
    clients.push(client);

    const result = await client.createSession({
      slackAutoBind: { channelId: "C123" },
      title: "TUI session",
    });

    expect(result.session).toMatchObject({
      metadata: {
        slackAutoBind: {
          channelId: "C123",
          status: "pending",
        },
      },
      title: "TUI session",
    });
    expect(store.getSession(result.session.id)).toMatchObject({
      metadata: { slackAutoBind: { channelId: "C123", status: "pending" } },
    });
  });

  test("creates sessions with a working context path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shepherd-tui-context-"));
    tempDirs.push(dir);
    const project = join(dir, "project");
    mkdirSync(project);
    const { server, socketPath, store } = await openServer({
      allowedRoots: [dir],
      enableLocalWorkingContexts: true,
    });
    servers.push(server);

    const client = await ShepherdSessionClient.connect(socketPath);
    clients.push(client);

    const result = await client.createSession({ title: null, workingContextPath: project });

    expect(result.session).toMatchObject({
      title: null,
      workingContextId: expect.any(String),
    });
    expect(store.getSession(result.session.id).workingContextId).toBe(
      result.session.workingContextId,
    );
  });

  test("ensures Pi session metadata through the gateway socket", async () => {
    const { server, socketPath, store } = await openServer({ enablePiSessionStore: true });
    servers.push(server);
    const session = store.createSession({ id: "session-1" });

    const client = await ShepherdSessionClient.connect(socketPath);
    clients.push(client);

    await expect(client.ensurePiSession({ sessionId: session.id })).resolves.toMatchObject({
      pi: {
        sessionFile: expect.stringContaining("session-1.jsonl"),
        sessionId: expect.any(String),
      },
    });
    expect(store.getSession(session.id).metadata.pi).toMatchObject({
      sessionFile: expect.stringContaining("session-1.jsonl"),
    });
  });

  test("subscribes to replayed and live session events", async () => {
    const { server, socketPath, store } = await openServer();
    servers.push(server);

    const session = store.createSession({ id: "session-1" });
    const replayed = store.appendEvent({
      payload: { text: "already there" },
      sessionId: session.id,
      type: "assistant.message",
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

    expect(events).toMatchObject([{ id: replayed.id, type: "assistant.message" }]);

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

  test("renames sessions through the gateway socket", async () => {
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

  test("lists and runs logical tools through the gateway socket", async () => {
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
        piTurnId: "manual:test",
        sessionId: session.id,
      }),
    ).resolves.toEqual({ output: { echoed: "hello" } });
  });
});

async function openServer(
  options: {
    allowedRoots?: string[];
    configureLogicalTools?: (store: EventStore) => LogicalToolRunner;
    enableLocalWorkingContexts?: boolean;
    enablePiSessionStore?: boolean;
  } = {},
): Promise<{
  server: ShepherdGatewayServer;
  socketPath: string;
  store: EventStore;
}> {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-tui-client-"));
  tempDirs.push(dir);

  const { sqlite } = openSqlite(join(dir, "test.sqlite"));
  applyMigrations(sqlite, { migrationsFolder: "drizzle" });
  const store = new EventStore(sqlite);
  const socketPath = join(dir, "shepherd.sock");
  const server = new ShepherdGatewayServer({
    ...(options.enableLocalWorkingContexts
      ? {
          localWorkingContexts: new WorkingContextResolver({
            allowedRoots: options.allowedRoots ?? [],
            allowUnconfiguredLocalPaths: options.allowedRoots === undefined,
            store: new WorkingContextStore(sqlite),
          }),
        }
      : {}),
    ...(options.configureLogicalTools
      ? { logicalTools: options.configureLogicalTools(store) }
      : {}),
    ...(options.enablePiSessionStore
      ? {
          piSessions: new PiSessionMetadataStore({
            events: store,
            sessionDir: join(dir, "pi-sessions"),
          }),
        }
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
