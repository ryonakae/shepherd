import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { applyMigrations } from "@/db/apply-migrations.js";
import { openSqlite } from "@/db/client.js";
import { EventStore } from "@/db/event-store.js";
import { SessionBindingStore } from "@/db/session-bindings.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("SessionBindingStore", () => {
  test("creates and resolves a platform thread binding", () => {
    const { bindings, events } = openMigratedStores();
    const session = events.createSession({ id: "session-1" });

    const binding = bindings.ensureBinding({
      messageId: "1700000000.000001",
      metadata: { teamId: "T123" },
      platform: "slack",
      sessionId: session.id,
      spaceId: "C123",
      threadId: "1700000000.000001",
    });

    expect(bindings.findByPlatformThread("slack", "C123", "1700000000.000001")).toEqual(binding);
    expect(binding).toMatchObject({
      messageId: "1700000000.000001",
      metadata: { teamId: "T123" },
      platform: "slack",
      sessionId: "session-1",
      spaceId: "C123",
      threadId: "1700000000.000001",
    });
  });

  test("returns the existing binding for duplicate platform threads", () => {
    const { bindings, events } = openMigratedStores();
    events.createSession({ id: "session-1" });
    events.createSession({ id: "session-2" });

    const first = bindings.ensureBinding({
      platform: "slack",
      sessionId: "session-1",
      spaceId: "C123",
      threadId: "1700000000.000001",
    });
    const second = bindings.ensureBinding({
      messageId: "1700000000.000002",
      metadata: { retried: true },
      platform: "slack",
      sessionId: "session-2",
      spaceId: "C123",
      threadId: "1700000000.000001",
    });

    expect(second).toEqual(first);
    expect(bindings.listForSession("session-1")).toEqual([first]);
    expect(bindings.listForSession("session-2")).toEqual([]);
  });
});

function openMigratedStores(): {
  bindings: SessionBindingStore;
  events: EventStore;
} {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-bindings-"));
  tempDirs.push(dir);

  const { sqlite } = openSqlite(join(dir, "test.sqlite"));
  applyMigrations(sqlite, { migrationsFolder: "drizzle" });

  return {
    bindings: new SessionBindingStore(sqlite),
    events: new EventStore(sqlite),
  };
}
