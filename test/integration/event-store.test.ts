import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { applyMigrations } from "@/db/apply-migrations.js";
import { openSqlite } from "@/db/client.js";
import { EventStore } from "@/db/event-store.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("EventStore", () => {
  test("creates sessions and replays ordered events after a cursor", () => {
    const store = openMigratedEventStore();
    const session = store.createSession({ id: "session-1", title: "Plan MVP" });

    const first = store.appendEvent({
      payload: { text: "start" },
      sessionId: session.id,
      type: "user.message",
    });
    const second = store.appendEvent({
      payload: { text: "working" },
      sessionId: session.id,
      type: "gateway.message",
    });

    expect(store.listEvents(session.id).map((event) => event.id)).toEqual([first.id, second.id]);
    expect(store.listEvents(session.id, first.id)).toEqual([second]);
  });

  test("deduplicates idempotent event appends per session", () => {
    const store = openMigratedEventStore();
    const session = store.createSession({ id: "session-1" });

    const first = store.appendEvent({
      idempotencyKey: "slack:delivery:123",
      payload: { text: "hello" },
      sessionId: session.id,
      type: "delivery.sent",
    });
    const second = store.appendEvent({
      idempotencyKey: "slack:delivery:123",
      payload: { text: "different retry payload" },
      sessionId: session.id,
      type: "delivery.sent",
    });

    expect(second).toEqual(first);
    expect(store.listEvents(session.id)).toHaveLength(1);
  });

  test("lists recent events in ascending event order", () => {
    const store = openMigratedEventStore();
    const session = store.createSession({ id: "session-1" });

    for (let index = 0; index < 5; index += 1) {
      store.appendEvent({
        payload: { text: `event ${index}` },
        sessionId: session.id,
        type: "user.message",
      });
    }

    expect(store.listRecentEvents(session.id, 2).map((event) => event.payload)).toEqual([
      { text: "event 3" },
      { text: "event 4" },
    ]);
  });

  test("updates session titles", () => {
    const store = openMigratedEventStore();
    const session = store.createSession({ id: "session-1", title: "Old title" });

    expect(store.updateSessionTitle(session.id, "New title")).toMatchObject({
      id: "session-1",
      title: "New title",
    });
    expect(store.updateSessionTitle(session.id, null)).toMatchObject({
      id: "session-1",
      title: null,
    });
  });
});

function openMigratedEventStore(): EventStore {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-events-"));
  tempDirs.push(dir);

  const { sqlite } = openSqlite(join(dir, "test.sqlite"));
  applyMigrations(sqlite, { migrationsFolder: "drizzle" });

  return new EventStore(sqlite);
}
