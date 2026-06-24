import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { ShepherdConfig } from "@/config/schema.js";
import { applyMigrations } from "@/db/apply-migrations.js";
import { openSqlite } from "@/db/client.js";
import { type EventRecord, EventStore } from "@/db/event-store.js";
import { createPlatformRuntime } from "@/platforms/runtime.js";
import type { SlackBoltLikeApp } from "@/platforms/slack/socket-mode.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("createPlatformRuntime", () => {
  test("returns a no-op runtime when no platforms are configured", () => {
    const { events, sqlite } = openHarness();

    const runtime = createPlatformRuntime({
      config: minimalConfig(),
      events,
      receiveUserMessage: async () => {
        throw new Error("unexpected message");
      },
      sqlite,
    });

    expect(runtime.deliveryFanout).toBeUndefined();
  });

  test("requires Slack token environment variables", () => {
    const { events, sqlite } = openHarness();

    expect(() =>
      createPlatformRuntime({
        config: minimalConfig({
          platforms: {
            slack: {
              app_token_env: "SLACK_APP_TOKEN",
              bot_token_env: "SLACK_BOT_TOKEN",
            },
          },
        }),
        environment: {},
        events,
        receiveUserMessage: async () => {
          throw new Error("unexpected message");
        },
        sqlite,
      }),
    ).toThrow("Missing required environment variable: SLACK_BOT_TOKEN");
  });

  test("wires Slack inbound messages through the daemon user message receiver", async () => {
    const { events, sqlite } = openHarness();
    const app = new FakeSlackApp();
    const received: unknown[] = [];
    const runtime = createPlatformRuntime({
      config: minimalConfig({
        platforms: {
          slack: {
            app_token_env: "SLACK_APP_TOKEN",
            bot_token_env: "SLACK_BOT_TOKEN",
          },
        },
      }),
      createSlackApp() {
        return app;
      },
      createSlackWebClient() {
        return fakeSlackWebClient();
      },
      environment: {
        SLACK_APP_TOKEN: "xapp-test",
        SLACK_BOT_TOKEN: "xoxb-test",
      },
      events,
      async receiveUserMessage(input) {
        received.push(input);
        return { event: appendReceivedUserMessage(events, input) };
      },
      sqlite,
    });

    await runtime.start();
    await app.emitMessage({
      channel: "C123",
      team: "T123",
      text: "from Slack",
      ts: "1700000001.000001",
      type: "message",
      user: "U123",
    });

    expect(received).toMatchObject([
      {
        actorId: "slack:T123:U123",
        idempotencyKey: "slack:T123:C123:1700000001.000001",
        presentation: {
          displayName: "U123",
          sourcePlatform: "slack",
          sourceUserId: "U123",
        },
        text: "from Slack",
      },
    ]);
  });

  test("delivers gateway events to Slack through the configured Web API client", async () => {
    const { events, sqlite } = openHarness();
    const app = new FakeSlackApp();
    const posts: unknown[] = [];
    let sessionId = "";
    const runtime = createPlatformRuntime({
      config: minimalConfig({
        platforms: {
          slack: {
            allow_customize: true,
            app_token_env: "SLACK_APP_TOKEN",
            bot_token_env: "SLACK_BOT_TOKEN",
          },
        },
      }),
      createSlackApp() {
        return app;
      },
      createSlackWebClient() {
        return fakeSlackWebClient(posts);
      },
      environment: {
        SLACK_APP_TOKEN: "xapp-test",
        SLACK_BOT_TOKEN: "xoxb-test",
      },
      events,
      async receiveUserMessage(input) {
        sessionId = input.sessionId;
        return { event: appendReceivedUserMessage(events, input) };
      },
      sqlite,
    });

    await runtime.start();
    await app.emitMessage({
      channel: "C123",
      team: "T123",
      text: "start",
      ts: "1700000001.000001",
      type: "message",
      user: "U123",
    });
    const gatewayEvent = events.appendEvent({
      payload: { text: "done" },
      sessionId,
      type: "gateway.message",
    });

    await runtime.deliveryFanout?.deliverEvent(gatewayEvent);

    expect(posts).toEqual([
      {
        channel: "C123",
        text: "done",
        thread_ts: "1700000001.000001",
      },
    ]);
  });

  test("applies Slack platform allowlists before receiving messages", async () => {
    const { events, sqlite } = openHarness();
    const app = new FakeSlackApp();
    const received: unknown[] = [];
    const runtime = createPlatformRuntime({
      config: minimalConfig({
        platforms: {
          slack: {
            allowed_channels: ["C999"],
            app_token_env: "SLACK_APP_TOKEN",
            bot_token_env: "SLACK_BOT_TOKEN",
          },
        },
      }),
      createSlackApp() {
        return app;
      },
      createSlackWebClient() {
        return fakeSlackWebClient();
      },
      environment: {
        SLACK_APP_TOKEN: "xapp-test",
        SLACK_BOT_TOKEN: "xoxb-test",
      },
      events,
      async receiveUserMessage(input) {
        received.push(input);
        return { event: appendReceivedUserMessage(events, input) };
      },
      sqlite,
    });

    await runtime.start();
    await app.emitMessage({
      channel: "C123",
      team: "T123",
      text: "blocked",
      ts: "1700000001.000001",
      type: "message",
      user: "U123",
    });

    expect(received).toEqual([]);
  });
});

class FakeSlackApp implements SlackBoltLikeApp {
  #handler: ((args: { event: unknown }) => Promise<void> | void) | undefined;

  event(_eventName: "message", handler: (args: { event: unknown }) => Promise<void> | void): void {
    this.#handler = handler;
  }

  async emitMessage(event: unknown): Promise<void> {
    await this.#handler?.({ event });
  }

  async start(): Promise<unknown> {
    return undefined;
  }
}

function fakeSlackWebClient(posts: unknown[] = []) {
  return {
    chat: {
      async postMessage(params: unknown): Promise<{ ts: string }> {
        posts.push(params);
        return { ts: "1700000002.000001" };
      },
    },
  };
}

function appendReceivedUserMessage(
  events: EventStore,
  input: {
    actorId: string;
    idempotencyKey: string;
    presentation: {
      displayName: string;
      sourcePlatform: "slack";
      sourceUserId: string;
    };
    sessionId: string;
    text: string;
  },
): EventRecord {
  events.upsertActor({
    displayName: input.presentation.displayName,
    id: input.actorId,
    kind: "user",
    presentation: input.presentation,
    sourcePlatform: input.presentation.sourcePlatform,
    sourceUserId: input.presentation.sourceUserId,
  });

  return events.appendEvent({
    actorId: input.actorId,
    idempotencyKey: input.idempotencyKey,
    payload: {
      presentation: input.presentation,
      text: input.text,
    },
    sessionId: input.sessionId,
    type: "user.message",
  });
}

function openHarness(): {
  events: EventStore;
  sqlite: ReturnType<typeof openSqlite>["sqlite"];
} {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-platform-runtime-"));
  tempDirs.push(dir);

  const { sqlite } = openSqlite(join(dir, "test.sqlite"));
  applyMigrations(sqlite, { migrationsFolder: "drizzle" });

  return {
    events: new EventStore(sqlite),
    sqlite,
  };
}

function minimalConfig(overrides: Partial<ShepherdConfig> = {}): ShepherdConfig {
  return {
    agents: {
      implementer: {
        command: "codex",
      },
    },
    default_agent: "implementer",
    gateway: {
      default_provider: "codex",
      model: "gpt-5.3-codex",
    },
    providers: {
      codex: {
        auth_source: "codex_cli",
        mode: "app_server",
        type: "codex_cli",
      },
    },
    ...overrides,
  };
}
