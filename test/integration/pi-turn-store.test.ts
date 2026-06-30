import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { applyMigrations } from "@/db/apply-migrations.js";
import { openSqlite } from "@/db/client.js";
import { EventStore } from "@/db/event-store.js";
import { PiTurnStore } from "@/db/pi-turns.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("PiTurnStore", () => {
  test("creates queued turns without appending events", () => {
    const { events, turns } = openHarness();
    const event = events.appendEvent({
      payload: { text: "hello" },
      sessionId: "session-1",
      type: "user.message",
    });

    const turn = turns.createQueuedTurn({
      sessionId: "session-1",
      triggeringEventId: event.id,
    });

    expect(turn).toMatchObject({
      inputEventIds: [],
      ownerId: null,
      sessionId: "session-1",
      status: "queued",
      triggeringEventId: event.id,
    });
    expect(events.listEvents("session-1").map((record) => record.type)).toEqual(["user.message"]);
  });

  test("claims the oldest queued turn only when no turn is running", () => {
    const { turns } = openHarness();
    const first = turns.createQueuedTurn({ id: "turn-1", sessionId: "session-1" });
    const second = turns.createQueuedTurn({ id: "turn-2", sessionId: "session-1" });

    expect(turns.claimNextQueuedTurn("session-1")).toMatchObject({
      id: first.id,
      status: "queued",
    });
    turns.markRunning({
      id: first.id,
      inputEventIds: [1],
      ownerId: "owner-1",
      ownerKind: "tui_pi",
      piSessionFile: "/tmp/pi.jsonl",
      piSessionId: "pi-session-1",
      source: "extension",
    });

    expect(turns.claimNextQueuedTurn("session-1")).toBeUndefined();
    turns.markCompletedIfRunning(first.id);
    expect(turns.claimNextQueuedTurn("session-1")).toMatchObject({
      id: second.id,
      status: "queued",
    });
  });

  test("marks queued turns running with owner and Pi metadata", () => {
    const { turns } = openHarness();
    turns.createQueuedTurn({ id: "turn-1", sessionId: "session-1" });

    const running = turns.markRunning({
      id: "turn-1",
      inputEventIds: [10, 11],
      ownerId: "owner-1",
      ownerKind: "headless_pi",
      piSessionFile: "/tmp/pi.jsonl",
      piSessionId: "pi-session-1",
      source: "rpc",
    });

    expect(running).toMatchObject({
      id: "turn-1",
      inputEventIds: [10, 11],
      ownerId: "owner-1",
      ownerKind: "headless_pi",
      piSessionFile: "/tmp/pi.jsonl",
      piSessionId: "pi-session-1",
      source: "rpc",
      status: "running",
    });
    expect(running.startedAt).toBeInstanceOf(Date);
  });

  test("creates direct running turns", () => {
    const { events, turns } = openHarness();
    const event = events.appendEvent({
      payload: { text: "direct" },
      sessionId: "session-1",
      type: "user.message",
    });

    const running = turns.createRunningTurn({
      id: "turn-direct",
      inputEventIds: [event.id],
      ownerId: "owner-1",
      ownerKind: "tui_pi",
      piSessionFile: "/tmp/pi.jsonl",
      piSessionId: "pi-session-1",
      sessionId: "session-1",
      source: "interactive",
      triggeringEventId: event.id,
    });

    expect(running).toMatchObject({
      id: "turn-direct",
      inputEventIds: [event.id],
      ownerId: "owner-1",
      ownerKind: "tui_pi",
      sessionId: "session-1",
      source: "interactive",
      status: "running",
      triggeringEventId: event.id,
    });
    expect(running.startedAt).toBeInstanceOf(Date);
  });

  test("marks queued or running turns completed first-terminal-wins", () => {
    const { turns } = openHarness();
    turns.createQueuedTurn({ id: "turn-1", sessionId: "session-1" });

    const completed = turns.markCompletedIfRunning("turn-1");
    expect(completed.changed).toBe(true);
    expect(completed.turn.status).toBe("completed");
    expect(completed.turn.completedAt).toBeInstanceOf(Date);

    const completedAt = completed.turn.completedAt?.getTime();
    const failed = turns.markFailedIfRunning("turn-1", new Error("late failure"));
    expect(failed.changed).toBe(false);
    expect(failed.turn.status).toBe("completed");
    expect(failed.turn.completedAt?.getTime()).toBe(completedAt);
  });

  test("marks queued or running turns failed first-terminal-wins", () => {
    const { turns } = openHarness();
    turns.createQueuedTurn({ id: "turn-1", sessionId: "session-1" });

    const failed = turns.markFailedIfRunning("turn-1", new Error("provider failed"));
    expect(failed.changed).toBe(true);
    expect(failed.turn.status).toBe("failed");
    expect(failed.turn.recovery).toEqual({ message: "provider failed" });

    const completed = turns.markCompletedIfRunning("turn-1");
    expect(completed.changed).toBe(false);
    expect(completed.turn.status).toBe("failed");
  });

  test("marks recovery required only for the current owner/session running turn", () => {
    const { turns } = openHarness();
    turns.createRunningTurn({
      id: "turn-1",
      inputEventIds: [],
      ownerId: "owner-1",
      ownerKind: "tui_pi",
      piSessionFile: "/tmp/pi.jsonl",
      piSessionId: "pi-session-1",
      sessionId: "session-1",
      source: "extension",
    });
    turns.createRunningTurn({
      id: "turn-2",
      inputEventIds: [],
      ownerId: "owner-2",
      ownerKind: "headless_pi",
      piSessionFile: "/tmp/pi2.jsonl",
      piSessionId: "pi-session-2",
      sessionId: "session-2",
      source: "extension",
    });

    expect(
      turns.markRecoveryRequiredForRunning({
        message: "owner stale",
        ownerId: "owner-3",
        sessionId: "session-1",
      }),
    ).toBeUndefined();

    const recovered = turns.markRecoveryRequiredForRunning({
      message: "owner stale",
      ownerId: "owner-1",
      sessionId: "session-1",
    });

    expect(recovered).toMatchObject({
      id: "turn-1",
      recovery: { message: "owner stale" },
      status: "recovery_required",
    });
    expect(turns.getTurn("turn-2").status).toBe("running");
  });
});

function openHarness(): { events: EventStore; turns: PiTurnStore } {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-pi-turns-"));
  tempDirs.push(dir);

  const { sqlite } = openSqlite(join(dir, "test.sqlite"));
  applyMigrations(sqlite, { migrationsFolder: "drizzle" });
  const events = new EventStore(sqlite);
  events.createSession({ id: "session-1" });
  events.createSession({ id: "session-2" });

  return { events, turns: new PiTurnStore(sqlite) };
}
