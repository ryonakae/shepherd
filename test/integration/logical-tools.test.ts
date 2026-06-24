import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, test } from "vitest";
import { applyMigrations } from "@/db/apply-migrations.js";
import { openSqlite } from "@/db/client.js";
import { EventStore } from "@/db/event-store.js";
import { LogicalToolCallStore, LogicalToolRegistry, LogicalToolRunner } from "@/gateway/tools.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("LogicalToolRunner", () => {
  test("validates input, executes an allowed tool, and logs call/result events", async () => {
    const { events, sessionId } = openStore();
    const registry = new LogicalToolRegistry();
    registry.register({
      description: "Read recent session events",
      execute: (input: { limit: number }) => ({ limit: input.limit }),
      inputSchema: Type.Object({ limit: Type.Number() }),
      name: "session_read",
    });
    const runner = new LogicalToolRunner({
      events,
      policy: { allowedTools: new Set(["session_read"]) },
      registry,
    });

    await expect(runner.run("session_read", { limit: 3 }, { sessionId })).resolves.toEqual({
      limit: 3,
    });

    expect(events.listEvents(sessionId).map((event) => event.type)).toEqual([
      "gateway.tool.call",
      "gateway.tool.result",
    ]);
  });

  test("denies tools that are not visible under policy", async () => {
    const { events, sessionId } = openStore();
    const registry = new LogicalToolRegistry();
    registry.register({
      description: "Open a pane",
      execute: () => ({ ok: true }),
      inputSchema: Type.Object({}),
      name: "open_pane",
    });
    const runner = new LogicalToolRunner({
      events,
      policy: { allowedTools: new Set() },
      registry,
    });

    await expect(runner.run("open_pane", {}, { sessionId })).rejects.toThrow(
      "Logical tool is not allowed",
    );
    expect(events.listEvents(sessionId).map((event) => event.type)).toEqual([
      "gateway.tool.denied",
    ]);
  });

  test("reuses completed idempotent tool results without rerunning side effects", async () => {
    const { events, sessionId, sqlite } = openStore();
    const registry = new LogicalToolRegistry();
    const calls: unknown[] = [];
    registry.register({
      description: "Run a command",
      execute: (input: { command: string }) => {
        calls.push(input);
        return { output: `ran ${input.command}` };
      },
      inputSchema: Type.Object({ command: Type.String() }),
      name: "run_pane_command",
    });
    const runner = new LogicalToolRunner({
      events,
      policy: { allowedTools: new Set(["run_pane_command"]) },
      registry,
      toolCalls: new LogicalToolCallStore(sqlite),
    });

    await expect(
      runner.run(
        "run_pane_command",
        { command: "pnpm test", idempotencyKey: "tool-1" },
        { sessionId },
      ),
    ).resolves.toEqual({ output: "ran pnpm test" });
    await expect(
      runner.run(
        "run_pane_command",
        { command: "pnpm test", idempotencyKey: "tool-1" },
        { sessionId },
      ),
    ).resolves.toEqual({ output: "ran pnpm test" });

    expect(calls).toEqual([{ command: "pnpm test", idempotencyKey: "tool-1" }]);
  });
});

function openStore(): {
  events: EventStore;
  sessionId: string;
  sqlite: ReturnType<typeof openSqlite>["sqlite"];
} {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-tools-"));
  tempDirs.push(dir);

  const { sqlite } = openSqlite(join(dir, "test.sqlite"));
  applyMigrations(sqlite, { migrationsFolder: "drizzle" });
  const events = new EventStore(sqlite);
  const session = events.createSession({ id: "session-1" });

  return { events, sessionId: session.id, sqlite };
}
