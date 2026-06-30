import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection, type Socket } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { applyMigrations } from "@/db/apply-migrations.js";
import { openSqlite } from "@/db/client.js";
import { EventStore } from "@/db/event-store.js";
import { PiTurnStore } from "@/db/pi-turns.js";
import { PiSessionMetadataStore } from "@/gateway/pi-sessions.js";
import { PiTurnQueue } from "@/gateway/pi-turn-queue.js";
import { encodeJsonLine, JsonLineDecoder } from "@/gateway/json-lines.js";
import { ShepherdGatewayServer } from "@/gateway/server.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("ShepherdGatewayServer JSON Lines RPC", () => {
  test("queues Slack/user messages as Pi turns and lets Pi claim/start/complete them", async () => {
    const delivered: string[] = [];
    const { client, server, store } = await openServer({
      deliveryFanout: {
        async deliverEvent(event) {
          delivered.push(event.type);
        },
      },
    });
    const session = store.createSession({ id: "session-1" });
    await client.request("pi.handshake", {
      extensionVersion: "0.0.0-test",
      mode: "tui",
    });
    const attach = await client.request("pi.attach", {
      mode: "tui",
      piSessionFile: "/tmp/pi.jsonl",
      piSessionId: "pi-session-1",
      sessionId: session.id,
    });
    const ownerId = (attach as { ownerId: string }).ownerId;

    const userResponse = await client.request("session.user_message", {
      actorId: "slack:U1",
      presentation: { sourcePlatform: "slack", sourceUserId: "U1" },
      sessionId: session.id,
      text: "start work",
    });
    expect((userResponse as { event: { type: string } }).event.type).toBe("user.message");
    await waitFor(() => store.listEvents(session.id).some((event) => event.type === "pi.turn.queued"));

    const claim = await client.request("pi.claim_next_turn", { ownerId, sessionId: session.id });
    const turn = (claim as { turn: { piTurnId: string; userText: string } }).turn;
    expect(turn.userText).toBe("start work");

    await client.request("pi.start_turn", {
      inputEventIds: [1],
      ownerId,
      ownerKind: "tui_pi",
      piSessionFile: "/tmp/pi.jsonl",
      piSessionId: "pi-session-1",
      piTurnId: turn.piTurnId,
      sessionId: session.id,
      source: "extension",
    });
    await client.request("pi.complete_turn", {
      finalText: "done",
      ownerId,
      ownerKind: "tui_pi",
      piSessionFile: "/tmp/pi.jsonl",
      piSessionId: "pi-session-1",
      piTurnId: turn.piTurnId,
      sessionId: session.id,
    });

    expect(store.listEvents(session.id).map((event) => event.type)).toEqual([
      "user.message",
      "pi.turn.queued",
      "pi.turn.started",
      "assistant.message",
      "pi.turn.completed",
    ]);
    expect(delivered).toEqual([
      "user.message",
      "pi.turn.queued",
      "pi.turn.started",
      "assistant.message",
      "pi.turn.completed",
    ]);

    client.close();
    await server.stop();
  });

  test("mirrors direct Pi user messages without queueing a new turn", async () => {
    const { client, server, store } = await openServer();
    const session = store.createSession({ id: "session-1" });
    const attach = await client.request("pi.attach", {
      mode: "tui",
      piSessionFile: "/tmp/pi.jsonl",
      piSessionId: "pi-session-1",
      sessionId: session.id,
    });
    const ownerId = (attach as { ownerId: string }).ownerId;

    const mirrored = await client.request("pi.mirror_user_message", {
      delivery: "immediate",
      displayName: "Pi / local",
      ownerId,
      ownerKind: "tui_pi",
      piSessionFile: "/tmp/pi.jsonl",
      piSessionId: "pi-session-1",
      piTurnId: "turn-direct",
      sessionId: session.id,
      source: "interactive",
      text: "inspect directly",
    });

    expect((mirrored as { event: { type: string } }).event.type).toBe("user.message");
    expect(store.listEvents(session.id).map((event) => event.type)).toEqual(["user.message"]);

    client.close();
    await server.stop();
  });

  test("streams, records tool progress, and completes direct Pi turns", async () => {
    const runtimeCalls: unknown[] = [];
    const finished = new Set<string>();
    const { client, server, store } = await openServer({
      runtimeDelivery: {
        async completeToolProgress(input) {
          runtimeCalls.push({ completeToolProgress: input });
        },
        async delta(input) {
          runtimeCalls.push({ delta: input });
        },
        async failToolProgress(input) {
          runtimeCalls.push({ failToolProgress: input });
        },
        async finish(input) {
          runtimeCalls.push({ finish: input });
          finished.add(input.streamId);
        },
        hasFinished(streamId) {
          return finished.has(streamId);
        },
        async recordToolProgress(input) {
          runtimeCalls.push({ recordToolProgress: input });
        },
      },
    });
    const session = store.createSession({ id: "session-1" });
    const attach = await client.request("pi.attach", {
      mode: "tui",
      piSessionFile: "/tmp/pi.jsonl",
      piSessionId: "pi-session-1",
      sessionId: session.id,
    });
    const ownerId = (attach as { ownerId: string }).ownerId;

    await client.request("pi.start_turn", {
      inputEventIds: [],
      ownerId,
      ownerKind: "tui_pi",
      piSessionFile: "/tmp/pi.jsonl",
      piSessionId: "pi-session-1",
      piTurnId: "turn-direct",
      sessionId: session.id,
      source: "interactive",
    });
    await client.request("pi.stream_delta", {
      delta: "partial",
      ownerId,
      piTurnId: "turn-direct",
      sessionId: session.id,
    });
    await client.request("pi.stream_finish", {
      finalText: "final",
      ownerId,
      piTurnId: "turn-direct",
      sessionId: session.id,
    });
    await client.request("pi.record_tool_progress", {
      ownerId,
      ownerKind: "tui_pi",
      piSessionFile: "/tmp/pi.jsonl",
      piSessionId: "pi-session-1",
      piTurnId: "turn-direct",
      sessionId: session.id,
      status: "completed",
      text: "bash completed token=secret-value",
      toolCallId: "tool-1",
      toolName: "bash",
    });
    await client.request("pi.complete_turn", {
      finalText: "final",
      ownerId,
      ownerKind: "tui_pi",
      piSessionFile: "/tmp/pi.jsonl",
      piSessionId: "pi-session-1",
      piTurnId: "turn-direct",
      sessionId: session.id,
    });

    expect(runtimeCalls).toEqual([
      { delta: { delta: "partial", sessionId: session.id, streamId: "turn-direct" } },
      { finish: { finalText: "final", streamId: "turn-direct" } },
      {
        recordToolProgress: {
          piTurnId: "turn-direct",
          sessionId: session.id,
          status: "completed",
          text: "bash completed token=[redacted]",
          toolName: "bash",
        },
      },
      { completeToolProgress: { piTurnId: "turn-direct", sessionId: session.id } },
    ]);
    expect(store.listEvents(session.id).map((event) => event.type)).toEqual([
      "pi.turn.started",
      "pi.tool.completed",
      "assistant.message",
      "pi.turn.completed",
    ]);
    expect(store.listEvents(session.id)[2]?.payload).toMatchObject({ deliveredByStream: true });

    client.close();
    await server.stop();
  });

  test("marks stale running Pi owner turns as recovery required", async () => {
    const { client, server, store } = await openServer({ ownerHeartbeatTimeoutMs: 1_000 });
    const session = store.createSession({ id: "session-1" });
    const attach = await client.request("pi.attach", {
      mode: "tui",
      piSessionFile: "/tmp/pi.jsonl",
      piSessionId: "pi-session-1",
      sessionId: session.id,
    });
    const ownerId = (attach as { ownerId: string }).ownerId;
    await client.request("pi.start_turn", {
      inputEventIds: [],
      ownerId,
      ownerKind: "tui_pi",
      piSessionFile: "/tmp/pi.jsonl",
      piSessionId: "pi-session-1",
      piTurnId: "turn-stale",
      sessionId: session.id,
      source: "interactive",
    });

    server.reapStalePiOwners(Date.now() + 2_000);

    expect(store.listEvents(session.id).map((event) => event.type)).toEqual([
      "pi.turn.started",
      "pi.turn.recovery_required",
      "recovery.note",
    ]);

    client.close();
    await server.stop();
  });

  test("returns unknown method for legacy gateway run RPCs", async () => {
    const { client, server } = await openServer();

    for (const method of [
      "gateway.claim_next_run",
      "gateway.start_run",
      "gateway.stream_delta",
      "gateway.stream_finish",
      "gateway.stream_segment_break",
      "gateway.stream_tool_progress",
      "gateway.complete_run",
      "gateway.fail_run",
    ]) {
      await expect(client.request(method, {})).rejects.toThrow(`Unknown method: ${method}`);
    }

    client.close();
    await server.stop();
  });
});

type RuntimeDelivery = ConstructorParameters<typeof ShepherdGatewayServer>[0]["runtimeDelivery"];

async function openServer(options: {
  deliveryFanout?: ConstructorParameters<typeof ShepherdGatewayServer>[0]["deliveryFanout"];
  ownerHeartbeatTimeoutMs?: number;
  runtimeDelivery?: RuntimeDelivery;
} = {}): Promise<{ client: RpcClient; server: ShepherdGatewayServer; store: EventStore }> {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-gateway-rpc-"));
  tempDirs.push(dir);
  const socketPath = join(dir, "gateway.sock");
  const { sqlite } = openSqlite(join(dir, "test.sqlite"));
  applyMigrations(sqlite, { migrationsFolder: "drizzle" });
  const store = new EventStore(sqlite);
  const turns = new PiTurnQueue({
    events: store,
    piSessions: new PiSessionMetadataStore({ events: store, sessionDir: join(dir, "pi-sessions") }),
    turnStore: new PiTurnStore(sqlite),
  });
  const server = new ShepherdGatewayServer({
    gatewayId: "gateway-test",
    ...(options.deliveryFanout ? { deliveryFanout: options.deliveryFanout } : {}),
    ...(options.ownerHeartbeatTimeoutMs !== undefined
      ? { ownerHeartbeatTimeoutMs: options.ownerHeartbeatTimeoutMs }
      : {}),
    piTurns: turns,
    ...(options.runtimeDelivery ? { runtimeDelivery: options.runtimeDelivery } : {}),
    socketPath,
    store,
  });
  await server.start();
  return { client: await RpcClient.connect(socketPath), server, store };
}

class RpcClient {
  readonly #decoder = new JsonLineDecoder();
  readonly #pending = new Map<string, { reject(error: Error): void; resolve(value: unknown): void }>();
  readonly #socket: Socket;
  #nextId = 1;

  private constructor(socket: Socket) {
    this.#socket = socket;
    socket.on("data", (chunk) => {
      for (const message of this.#decoder.push(chunk.toString("utf8"))) {
        const record = message as { error?: { message?: string }; id?: string | number; result?: unknown };
        if (record.id === undefined) {
          continue;
        }
        const pending = this.#pending.get(String(record.id));
        if (!pending) {
          continue;
        }
        this.#pending.delete(String(record.id));
        if (record.error) {
          pending.reject(new Error(record.error.message ?? "RPC error"));
        } else {
          pending.resolve(record.result);
        }
      }
    });
  }

  static connect(socketPath: string): Promise<RpcClient> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(socketPath);
      socket.once("connect", () => resolve(new RpcClient(socket)));
      socket.once("error", reject);
    });
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = String(this.#nextId++);
    this.#socket.write(encodeJsonLine({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { reject, resolve });
    });
  }

  close(): void {
    this.#socket.destroy();
  }
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
