import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { applyMigrations } from "@/db/apply-migrations.js";
import { openSqlite } from "@/db/client.js";
import { EventStore } from "@/db/event-store.js";
import { PiTurnStore } from "@/db/pi-turns.js";
import { recoverGatewayState } from "@/gateway/recovery.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("recoverGatewayState", () => {
  test("marks in-flight Pi turns as recovery required and leaves queued turns queued", () => {
    const { events, sqlite, turnStore } = openHarness();
    events.createSession({ id: "session-1" });
    const queued = turnStore.createQueuedTurn({ sessionId: "session-1" });
    const running = turnStore.createRunningTurn({
      id: "turn-running",
      inputEventIds: [],
      ownerId: "owner-1",
      ownerKind: "tui_pi",
      piSessionFile: "/tmp/pi.jsonl",
      piSessionId: "pi-session-1",
      sessionId: "session-1",
      source: "extension",
    });

    const result = recoverGatewayState({ events, sqlite });

    expect(result.piTurns).toEqual([
      expect.objectContaining({ piTurnId: running.id, previousStatus: "running" }),
    ]);
    expect(turnStore.getTurn(queued.id)).toMatchObject({ status: "queued" });
    expect(turnStore.getTurn(running.id)).toMatchObject({
      recovery: expect.objectContaining({ message: expect.stringContaining("Pi turn") }),
      status: "recovery_required",
    });
    expect(events.listEvents("session-1").map((event) => event.type)).toEqual(["recovery.note"]);

    expect(recoverGatewayState({ events, sqlite }).piTurns).toEqual([]);
    expect(events.listEvents("session-1")).toHaveLength(1);
  });
});

function openHarness(): {
  events: EventStore;
  sqlite: ReturnType<typeof openSqlite>["sqlite"];
  turnStore: PiTurnStore;
} {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-gateway-recovery-"));
  tempDirs.push(dir);

  const { sqlite } = openSqlite(join(dir, "test.sqlite"));
  applyMigrations(sqlite, { migrationsFolder: "drizzle" });

  return {
    events: new EventStore(sqlite),
    sqlite,
    turnStore: new PiTurnStore(sqlite),
  };
}
