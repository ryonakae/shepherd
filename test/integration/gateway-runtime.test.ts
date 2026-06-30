import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { ShepherdConfig } from "@/config/schema.js";
import { applyMigrations } from "@/db/apply-migrations.js";
import { openSqlite } from "@/db/client.js";
import { EventStore } from "@/db/event-store.js";
import { createGatewayRuntime } from "@/gateway/runtime.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("createGatewayRuntime", () => {
  test("returns provider-free Pi runtime surfaces", async () => {
    const { events, sqlite } = openMigratedDatabase();
    const runtime = createGatewayRuntime({
      config: openConfig(),
      events,
      receiveHerdrProgress: async () => undefined,
      sqlite,
    });

    expect(Object.keys(runtime).sort()).toEqual(["close", "herdrProgress", "tools", "turns"]);
    expect(runtime.tools.list().map((tool) => tool.name)).toContain("herdr_start_agent");
    expect(runtime.tools.list().map((tool) => tool.name)).not.toContain("gateway_provider");

    await runtime.close();
  });

  test("queues Pi turns without provider/model config", async () => {
    const { events, sqlite } = openMigratedDatabase();
    const session = events.createSession({ id: "session-abcdef123456" });
    const userEvent = events.appendEvent({
      payload: { text: "start implementation" },
      sessionId: session.id,
      type: "user.message",
    });
    const runtime = createGatewayRuntime({
      config: openConfig(),
      events,
      piSessionDir: join(tempDirs[0] ?? tmpdir(), "pi-sessions"),
      sqlite,
    });

    const queued = runtime.turns.queueTurn({
      sessionId: session.id,
      triggeringEventId: userEvent.id,
    });

    expect(queued.event).toMatchObject({
      payload: {
        piTurnId: queued.turn.id,
        triggeringEventId: userEvent.id,
      },
      type: "pi.turn.queued",
    });
    expect(runtime.turns.claimNextTurn({ ownerId: "owner-1", sessionId: session.id })).toMatchObject(
      {
        turn: {
          id: queued.turn.id,
          piTurnId: queued.turn.id,
          userText: "start implementation",
        },
      },
    );

    await runtime.close();
  });
});

function openConfig(): ShepherdConfig {
  return {
    agents: {
      claude: { args: ["--dangerously-skip-permissions"], command: "claude" },
    },
    default_agent: "claude",
    gateway: {
      pi: {
        idle_timeout_ms: 600_000,
        readiness_timeout_ms: 10_000,
      },
    },
  };
}

function openMigratedDatabase(): {
  events: EventStore;
  sqlite: ReturnType<typeof openSqlite>["sqlite"];
} {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-gateway-runtime-"));
  tempDirs.push(dir);

  const { sqlite } = openSqlite(join(dir, "test.sqlite"));
  applyMigrations(sqlite, { migrationsFolder: "drizzle" });
  return { events: new EventStore(sqlite), sqlite };
}
