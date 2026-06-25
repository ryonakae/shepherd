import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, test } from "vitest";
import { encodeJsonLine, JsonLineDecoder } from "@/daemon/json-lines.js";
import { ShepherdDaemonServer } from "@/daemon/server.js";
import { applyMigrations } from "@/db/apply-migrations.js";
import { openSqlite } from "@/db/client.js";
import { EventStore } from "@/db/event-store.js";
import { SessionSummaryStore } from "@/db/session-summary.js";
import { ExternalGatewayRunQueue } from "@/gateway/external-run-queue.js";
import { PiSessionMetadataStore } from "@/gateway/pi-sessions.js";
import { GatewayRunner } from "@/gateway/runner.js";
import { LogicalToolRegistry, LogicalToolRunner } from "@/gateway/tools.js";
import { GatewayRunStore } from "@/gateway/turn-queue.js";

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
  test("creates sessions with optional Slack auto-bind metadata", async () => {
    const { server, socketPath, store } = await openServer();
    servers.push(server);

    const client = await connect(socketPath);
    client.write(
      encodeJsonLine({
        id: "create-1",
        method: "session.create",
        params: {
          slackAutoBind: { channelId: "C123" },
          title: "TUI session",
        },
      }),
    );

    const [response] = await readMessages(client, 1);

    expect(response).toMatchObject({
      id: "create-1",
      result: {
        session: {
          metadata: {
            slackAutoBind: {
              channelId: "C123",
              status: "pending",
            },
          },
          title: "TUI session",
        },
      },
    });
    const sessionId = (response as { result: { session: { id: string } } }).result.session.id;
    expect(store.getSession(sessionId)).toMatchObject({
      metadata: { slackAutoBind: { channelId: "C123", status: "pending" } },
      title: "TUI session",
    });
  });

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

  test("renames sessions and broadcasts a session event", async () => {
    const { server, socketPath, store } = await openServer();
    servers.push(server);

    const session = store.createSession({ id: "session-1", title: "Old title" });
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
        id: "rename-1",
        method: "session.rename",
        params: {
          sessionId: session.id,
          title: "New title",
        },
      }),
    );

    const messages = await readMessages(client, 2);

    expect(messages[0]).toMatchObject({
      id: "rename-1",
      result: {
        session: {
          id: session.id,
          title: "New title",
        },
      },
    });
    expect(messages[1]).toMatchObject({
      method: "session.event",
      params: {
        event: {
          payload: { title: "New title" },
          type: "session.renamed",
        },
      },
    });
  });

  test("records approval requests and responses as delivered session events", async () => {
    const delivered: unknown[] = [];
    const { server, socketPath, store } = await openServer({
      configureDeliveryFanout() {
        return {
          async deliverEvent(event) {
            delivered.push({ payload: event.payload, type: event.type });
          },
        };
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
        id: "approval-1",
        method: "approval.request",
        params: {
          approvalId: "codex-tool-1",
          provider: "codex",
          request: { command: "pnpm test" },
          sessionId: session.id,
          text: "Codex requests approval to run pnpm test.",
        },
      }),
    );

    const requestMessages = await readMessages(client, 2);

    client.write(
      encodeJsonLine({
        id: "approval-2",
        method: "approval.respond",
        params: {
          approvalId: "codex-tool-1",
          decision: "approved",
          responderActorId: "tui:user",
          sessionId: session.id,
        },
      }),
    );

    const responseMessages = await readMessages(client, 2);
    const messages = [...requestMessages, ...responseMessages];

    expect(messages[0]).toMatchObject({
      method: "session.event",
      params: { event: { type: "approval.requested" } },
    });
    expect(messages[1]).toMatchObject({
      id: "approval-1",
      result: {
        event: {
          payload: {
            approvalId: "codex-tool-1",
            provider: "codex",
            request: { command: "pnpm test" },
            text: "Codex requests approval to run pnpm test.",
          },
          type: "approval.requested",
        },
      },
    });
    expect(messages[2]).toMatchObject({
      method: "session.event",
      params: { event: { type: "approval.responded" } },
    });
    expect(messages[3]).toMatchObject({
      id: "approval-2",
      result: {
        event: {
          actorId: "tui:user",
          payload: {
            approvalId: "codex-tool-1",
            decision: "approved",
            text: "Approval approved: codex-tool-1",
          },
          type: "approval.responded",
        },
      },
    });
    expect(delivered).toEqual([
      expect.objectContaining({ type: "approval.requested" }),
      expect.objectContaining({ type: "approval.responded" }),
    ]);
  });

  test("records Herdr progress and publishes it to subscribers and delivery fanout", async () => {
    const delivered: unknown[] = [];
    const { server, socketPath, store } = await openServer({
      configureDeliveryFanout() {
        return {
          async deliverEvent(event) {
            delivered.push({ payload: event.payload, type: event.type });
          },
        };
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
        id: "herdr-progress-1",
        method: "herdr.progress",
        params: {
          herdrSessionName: "shepherd-api",
          rawEvent: {
            data: { agent: "claude-impl", status: "idle" },
            id: "evt-1",
            type: "agent.status",
          },
          sessionId: session.id,
          workspaceId: "w1",
        },
      }),
    );

    const messages = await readMessages(client, 2);

    expect(messages[0]).toMatchObject({
      method: "session.event",
      params: {
        event: {
          idempotencyKey: "herdr:shepherd-api:event:evt-1",
          payload: {
            agent: "claude-impl",
            eventId: "evt-1",
            eventType: "agent.status",
            herdrSessionName: "shepherd-api",
            status: "idle",
            text: "Herdr progress agent.status status=idle agent=claude-impl",
            workspaceId: "w1",
          },
          type: "herdr.progress",
        },
      },
    });
    expect(messages[1]).toMatchObject({
      id: "herdr-progress-1",
      result: {
        event: {
          type: "herdr.progress",
        },
      },
    });
    expect(delivered).toEqual([expect.objectContaining({ type: "herdr.progress" })]);
  });

  test("records Pi extension handshakes", async () => {
    const { server, socketPath } = await openServer();
    servers.push(server);

    const handshake = server.waitForPiHandshake({ timeoutMs: 500 });
    const client = await connect(socketPath);
    client.write(
      encodeJsonLine({
        id: "pi-handshake-1",
        method: "pi.handshake",
        params: {
          extensionVersion: "0.1.0",
          mode: "rpc",
          piSessionFile: "/tmp/pi-session.jsonl",
          piSessionId: "pi-session-1",
        },
      }),
    );

    const [response, recorded] = await Promise.all([readMessages(client, 1), handshake]);

    expect(response[0]).toMatchObject({
      id: "pi-handshake-1",
      result: {
        attached: false,
        daemonId: "default",
        ownerKind: "headless_pi",
      },
    });
    expect(recorded).toMatchObject({
      attached: false,
      extensionVersion: "0.1.0",
      mode: "rpc",
      ownerKind: "headless_pi",
      piSessionFile: "/tmp/pi-session.jsonl",
      piSessionId: "pi-session-1",
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

  test("passes explicit gateway provider overrides through RPC", async () => {
    const providerOverrides: unknown[] = [];
    const { server, socketPath, store } = await openServer({
      configureGatewayRunner(events) {
        const registry = new LogicalToolRegistry();
        return new GatewayRunner({
          events,
          provider: {
            async generate(input) {
              providerOverrides.push(input.providerOverride);
              return { text: "override accepted" };
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
        id: "gateway-override-1",
        method: "gateway.run_turn",
        params: {
          messages: [{ content: "please coordinate this", role: "user" }],
          providerOverride: { model: "gpt-4.1", provider: "openai" },
          sessionId: session.id,
        },
      }),
    );

    await expect(readMessages(client, 1)).resolves.toEqual([
      { id: "gateway-override-1", result: { text: "override accepted" } },
    ]);
    expect(providerOverrides).toEqual([{ model: "gpt-4.1", provider: "openai" }]);
  });

  test("uses configured provider overrides when a message has no explicit override", async () => {
    const providerOverrides: unknown[] = [];
    const { server, socketPath, store } = await openServer({
      configureGatewayRunner(events) {
        const registry = new LogicalToolRegistry();
        return new GatewayRunner({
          events,
          provider: {
            async generate(input) {
              providerOverrides.push(input.providerOverride);
              return { text: "configured override accepted" };
            },
          },
          tools: new LogicalToolRunner({
            events,
            policy: { allowedTools: new Set() },
            registry,
          }),
        });
      },
      providerOverrides: () => ({ model: "gpt-5.3-codex-high", provider: "codex" }),
    });
    servers.push(server);

    const session = store.createSession({ id: "session-1" });
    const client = await connect(socketPath);

    client.write(
      encodeJsonLine({
        id: "message-override-1",
        method: "session.user_message",
        params: {
          sessionId: session.id,
          text: "please start",
        },
      }),
    );
    await readMessages(client, 1);
    await waitFor(() => providerOverrides.length === 1);

    expect(providerOverrides).toEqual([{ model: "gpt-5.3-codex-high", provider: "codex" }]);
  });

  test("queues, claims, and completes a final-only Pi gateway run", async () => {
    const delivered: string[] = [];
    const startedHeadlessPi: unknown[] = [];
    const { server, socketPath, store } = await openServer({
      configureDeliveryFanout() {
        return {
          async deliverEvent(event) {
            delivered.push(event.type);
          },
        };
      },
      configureHeadlessPi() {
        return {
          ensureStarted(input) {
            startedHeadlessPi.push(input);
          },
        };
      },
      enableGatewayRuns: true,
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
          actorId: "slack:T123:U123",
          presentation: { displayName: "U123", sourcePlatform: "slack", sourceUserId: "U123" },
          sessionId: session.id,
          text: "from Slack",
        },
      }),
    );

    const queuedMessages = await readMessages(client, 3);
    expect(queuedMessages[0]).toMatchObject({ id: "message-1" });
    expect(queuedMessages.slice(1).map((message) => eventType(message))).toEqual([
      "user.message",
      "gateway.run.queued",
    ]);
    expect(queuedMessages[2]).toMatchObject({
      params: {
        event: {
          payload: {
            piSessionFile: expect.stringContaining("pi-sessions/session-1.jsonl"),
            piSessionId: expect.any(String),
          },
        },
      },
    });
    expect(startedHeadlessPi).toEqual([
      {
        piSessionFile: expect.stringContaining("pi-sessions/session-1.jsonl"),
        sessionId: session.id,
      },
    ]);

    client.write(
      encodeJsonLine({
        id: "claim-1",
        method: "gateway.claim_next_run",
        params: { ownerId: "owner-1", sessionId: session.id },
      }),
    );
    const claimMessages = await readMessages(client, 2);
    expect(claimMessages[0]).toMatchObject({
      id: "claim-1",
      result: {
        run: {
          actorId: "slack:T123:U123",
          piSessionFile: expect.stringContaining("pi-sessions/session-1.jsonl"),
          piSessionId: expect.any(String),
          userText: "from Slack",
        },
      },
    });
    expect(eventType(claimMessages[1])).toBe("gateway.run.started");

    const gatewayRunId = (claimMessages[0] as { result: { run: { id: string } } }).result.run.id;
    client.write(
      encodeJsonLine({
        id: "start-1",
        method: "gateway.start_run",
        params: { gatewayRunId, ownerId: "owner-1" },
      }),
    );
    await expect(readMessages(client, 1)).resolves.toEqual([
      expect.objectContaining({
        id: "start-1",
        result: { run: expect.objectContaining({ status: "running" }) },
      }),
    ]);

    client.write(
      encodeJsonLine({
        id: "complete-1",
        method: "gateway.complete_run",
        params: {
          gatewayRunId,
          ownerId: "owner-1",
          piSessionFile: "/tmp/pi-session.jsonl",
          piSessionId: "pi-session-1",
          text: "final answer",
        },
      }),
    );

    const completeMessages = await readMessages(client, 3);
    expect(completeMessages[0]).toMatchObject({
      id: "complete-1",
      result: { run: { status: "completed" } },
    });
    expect(completeMessages.slice(1).map((message) => eventType(message))).toEqual([
      "gateway.message",
      "gateway.run.completed",
    ]);
    expect(delivered).toEqual([
      "user.message",
      "gateway.run.queued",
      "gateway.run.started",
      "gateway.message",
      "gateway.run.completed",
    ]);
  });

  test("lists and runs logical tools through RPC", async () => {
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
    const client = await connect(socketPath);
    client.write(encodeJsonLine({ id: "tools-1", method: "tool.list" }));
    client.write(
      encodeJsonLine({
        id: "tools-2",
        method: "tool.run",
        params: {
          input: { text: "hello" },
          name: "echo",
          sessionId: session.id,
        },
      }),
    );

    const messages = await readMessages(client, 2);

    expect(messages[0]).toMatchObject({
      id: "tools-1",
      result: {
        tools: [
          {
            description: "Echo a message",
            name: "echo",
          },
        ],
      },
    });
    expect(messages[1]).toEqual({
      id: "tools-2",
      result: { output: { echoed: "hello" } },
    });
    expect(store.listEvents(session.id).map((event) => event.type)).toEqual([
      "gateway.tool.call",
      "gateway.tool.result",
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

  test("wakes the gateway with recent session context", async () => {
    const generatedMessages: unknown[] = [];
    const { server, socketPath, store } = await openServer({
      configureGatewayRunner(events) {
        const registry = new LogicalToolRegistry();
        return new GatewayRunner({
          events,
          provider: {
            async generate(input) {
              generatedMessages.push(input.messages);
              return { text: "I remember the context." };
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
    store.appendEvent({
      payload: { text: "previous user message" },
      sessionId: session.id,
      type: "user.message",
    });
    store.appendEvent({
      payload: { text: "previous gateway response" },
      sessionId: session.id,
      type: "gateway.message",
    });
    const client = await connect(socketPath);

    client.write(
      encodeJsonLine({
        id: "message-1",
        method: "session.user_message",
        params: {
          sessionId: session.id,
          text: "new user message",
        },
      }),
    );
    await readMessages(client, 1);
    await waitFor(() => generatedMessages.length === 1);

    expect(generatedMessages[0]).toEqual([
      { content: "previous user message", role: "user" },
      { content: "previous gateway response", role: "assistant" },
      { content: "new user message", role: "user" },
    ]);
  });

  test("includes stored session summary when waking the gateway", async () => {
    const generatedMessages: unknown[] = [];
    const { server, socketPath, store, summaries } = await openServer({
      configureGatewayRunner(events) {
        const registry = new LogicalToolRegistry();
        return new GatewayRunner({
          events,
          provider: {
            async generate(input) {
              generatedMessages.push(input.messages);
              return { text: "I have summary context." };
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
    summaries.upsertSummary({
      content: "Existing durable session summary.",
      sessionId: session.id,
      summarizedThroughEventId: 1,
    });
    const client = await connect(socketPath);

    client.write(
      encodeJsonLine({
        id: "message-1",
        method: "session.user_message",
        params: {
          sessionId: session.id,
          text: "new user message",
        },
      }),
    );
    await readMessages(client, 1);
    await waitFor(() => generatedMessages.length === 1);

    expect(generatedMessages[0]).toEqual([
      {
        content: "Session summary so far:\nExisting durable session summary.",
        role: "system",
      },
      { content: "new user message", role: "user" },
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
    configureHeadlessPi?: () => {
      ensureStarted(input: { piSessionFile: string; sessionId: string }): unknown;
    };
    configureLogicalTools?: (store: EventStore) => LogicalToolRunner;
    enableGatewayRuns?: boolean;
    providerOverrides?: () => { model?: string; provider?: string } | undefined;
  } = {},
): Promise<{
  server: ShepherdDaemonServer;
  socketPath: string;
  store: EventStore;
  summaries: SessionSummaryStore;
}> {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-daemon-"));
  tempDirs.push(dir);

  const { sqlite } = openSqlite(join(dir, "test.sqlite"));
  applyMigrations(sqlite, { migrationsFolder: "drizzle" });
  const store = new EventStore(sqlite);
  const summaries = new SessionSummaryStore(sqlite);
  const socketPath = join(dir, "shepherd.sock");
  const server = new ShepherdDaemonServer({
    ...(options.configureDeliveryFanout
      ? { deliveryFanout: options.configureDeliveryFanout() }
      : {}),
    ...(options.configureGatewayRunner
      ? { gatewayRunner: options.configureGatewayRunner(store) }
      : {}),
    ...(options.enableGatewayRuns
      ? {
          gatewayRuns: new ExternalGatewayRunQueue({
            events: store,
            piSessions: new PiSessionMetadataStore({
              events: store,
              sessionDir: join(dir, "pi-sessions"),
            }),
            runStore: new GatewayRunStore(sqlite),
          }),
        }
      : {}),
    ...(options.configureHeadlessPi ? { headlessPi: options.configureHeadlessPi() } : {}),
    ...(options.configureLogicalTools
      ? { logicalTools: options.configureLogicalTools(store) }
      : {}),
    ...(options.providerOverrides ? { providerOverrides: options.providerOverrides } : {}),
    socketPath,
    store,
    summaries,
    ...(options.configPath ? { configPath: options.configPath } : {}),
  });
  await server.start();

  return { server, socketPath, store, summaries };
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
