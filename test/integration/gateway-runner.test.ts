import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, test } from "vitest";
import { applyMigrations } from "@/db/apply-migrations.js";
import { openSqlite } from "@/db/client.js";
import { EventStore } from "@/db/event-store.js";
import { GatewayRunner } from "@/gateway/runner.js";
import { LogicalToolRegistry, LogicalToolRunner } from "@/gateway/tools.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("GatewayRunner", () => {
  test("runs a provider turn and records gateway lifecycle events", async () => {
    const { events, sessionId, tools } = openGatewayHarness();
    const runner = new GatewayRunner({
      events,
      provider: {
        async generate(input) {
          await input.tools.run("session_read", { limit: 1 }, { sessionId: input.sessionId });
          return { text: "I checked the session." };
        },
      },
      tools,
    });

    await expect(
      runner.runTurn({
        messages: [{ content: "what happened?", role: "user" }],
        sessionId,
      }),
    ).resolves.toEqual({ text: "I checked the session." });

    expect(events.listEvents(sessionId).map((event) => event.type)).toEqual([
      "gateway.run.started",
      "gateway.tool.call",
      "gateway.tool.result",
      "gateway.message",
      "gateway.run.completed",
    ]);
  });

  test("records failed gateway turns", async () => {
    const { events, sessionId, tools } = openGatewayHarness();
    const runner = new GatewayRunner({
      events,
      provider: {
        async generate() {
          throw new Error("provider unavailable");
        },
      },
      tools,
    });

    await expect(
      runner.runTurn({
        messages: [{ content: "hello", role: "user" }],
        sessionId,
      }),
    ).rejects.toThrow("provider unavailable");

    expect(events.listEvents(sessionId).map((event) => event.type)).toEqual([
      "gateway.run.started",
      "gateway.run.failed",
    ]);
  });
});

function openGatewayHarness(): {
  events: EventStore;
  sessionId: string;
  tools: LogicalToolRunner;
} {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-gateway-"));
  tempDirs.push(dir);

  const { sqlite } = openSqlite(join(dir, "test.sqlite"));
  applyMigrations(sqlite, { migrationsFolder: "drizzle" });
  const events = new EventStore(sqlite);
  const session = events.createSession({ id: "session-1" });
  const registry = new LogicalToolRegistry();
  registry.register({
    description: "Read session events",
    execute: () => [],
    inputSchema: Type.Object({ limit: Type.Optional(Type.Number()) }),
    name: "session_read",
  });
  const tools = new LogicalToolRunner({
    events,
    policy: { allowedTools: new Set(["session_read"]) },
    registry,
  });

  return { events, sessionId: session.id, tools };
}
