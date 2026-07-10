import { existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { JsonLineDecoder } from "@/shared/json-lines.js";
import {
  type DaemonStreamMessage,
  ReconnectingDaemonClient,
} from "../../packages/shepherd-pi/src/daemon-client.js";

const resources: Array<{ client?: ReconnectingDaemonClient; dir: string; server?: Server }> = [];

afterEach(async () => {
  for (const resource of resources.splice(0)) {
    resource.client?.close();
    await closeServer(resource.server);
    rmSync(resource.dir, { force: true, recursive: true });
  }
});

describe("ReconnectingDaemonClient", () => {
  test("connects after the server appears and handles responses and streams", async () => {
    const resource = createResource();
    const client = new ReconnectingDaemonClient({
      reconnectDelaysMs: [5],
      socketPath: resource.socketPath,
    });
    resource.client = client;
    let connected = 0;
    const streams: DaemonStreamMessage[] = [];
    client.onConnected = () => {
      connected += 1;
    };
    client.onStreamMessage = (message) => streams.push(message);

    const sockets: Socket[] = [];
    resource.server = await startServer(resource.socketPath, (socket, message) => {
      sockets.push(socket);
      socket.write(`${JSON.stringify({ id: message.id, result: { method: message.method } })}\n`);
      socket.write(
        `${JSON.stringify({ method: "agent.event", params: { event: { id: 1, payload: {}, type: "agent.done" } } })}\n`,
      );
    });
    await waitFor(() => connected === 1);

    await expect(client.request("agent.list", {})).resolves.toEqual({ method: "agent.list" });
    await waitFor(() => streams.length === 1);
    expect(streams[0]).toMatchObject({ method: "agent.event", params: { event: { id: 1 } } });
    expect(sockets.length).toBeGreaterThan(0);
  });

  test("rejects in-flight work, reconnects once, and accepts later requests", async () => {
    const resource = createResource();
    let connectionCount = 0;
    resource.server = await startServer(
      resource.socketPath,
      (socket, message) => {
        if (message.method === "hold") {
          socket.destroy();
          return;
        }
        socket.write(`${JSON.stringify({ id: message.id, result: { ok: true } })}\n`);
      },
      () => {
        connectionCount += 1;
      },
    );
    const client = new ReconnectingDaemonClient({
      reconnectDelaysMs: [5],
      socketPath: resource.socketPath,
    });
    resource.client = client;
    let disconnected = 0;
    client.onDisconnected = () => {
      disconnected += 1;
    };
    await waitFor(() => connectionCount === 1);

    await expect(client.request("hold", {})).rejects.toThrow("socket closed");
    await waitFor(() => connectionCount === 2);
    expect(disconnected).toBe(1);
    await expect(client.request("later", {})).resolves.toEqual({ ok: true });
  });

  test("malformed JSON disconnects without crashing and then reconnects", async () => {
    const resource = createResource();
    let connectionCount = 0;
    resource.server = await startServer(
      resource.socketPath,
      (socket, message) => {
        socket.write(`${JSON.stringify({ id: message.id, result: { ok: true } })}\n`);
      },
      (socket) => {
        connectionCount += 1;
        if (connectionCount === 1) socket.write("{not-json}\n");
      },
    );
    const client = new ReconnectingDaemonClient({
      reconnectDelaysMs: [5],
      socketPath: resource.socketPath,
    });
    resource.client = client;
    await waitFor(() => connectionCount === 2);

    await expect(client.request("healthy", {})).resolves.toEqual({ ok: true });
  });

  test("explicit close stops reconnect and rejects later requests", async () => {
    const resource = createResource();
    resource.server = await startServer(resource.socketPath, (socket, message) => {
      socket.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
    });
    const client = new ReconnectingDaemonClient({ socketPath: resource.socketPath });
    resource.client = client;
    await new Promise((resolve) => setTimeout(resolve, 10));

    client.close();
    await expect(client.request("agent.list", {})).rejects.toThrow(
      "Shepherd daemon client is closed",
    );
  });
});

type Message = { id?: number | string; method?: string; params?: unknown };

async function startServer(
  socketPath: string,
  onMessage: (socket: Socket, message: Message) => void,
  onConnection: (socket: Socket) => void = () => undefined,
): Promise<Server> {
  if (existsSync(socketPath)) unlinkSync(socketPath);
  const server = createServer((socket) => {
    onConnection(socket);
    const decoder = new JsonLineDecoder();
    socket.on("data", (chunk) => {
      for (const message of decoder.push(chunk.toString("utf8"))) {
        onMessage(socket, message as Message);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return server;
}

function createResource() {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-pi-client-"));
  const resource: {
    client?: ReconnectingDaemonClient;
    dir: string;
    server?: Server;
    socketPath: string;
  } = { dir, socketPath: join(dir, "daemon.sock") };
  resources.push(resource);
  return resource;
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition was not met");
}
