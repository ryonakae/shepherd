import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { recoverDaemonState } from "@/daemon/recovery.js";
import { applyMigrations } from "@/db/apply-migrations.js";
import { openSqlite } from "@/db/client.js";
import { EventStore } from "@/db/event-store.js";
import { GatewayRunStore } from "@/gateway/turn-queue.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("recoverDaemonState", () => {
  test("marks in-flight gateway runs as recovery required and emits notes", () => {
    const { events, runStore, sqlite } = openHarness();
    events.createSession({ id: "session-1" });
    const queued = runStore.createQueuedRun({ sessionId: "session-1" });
    const running = runStore.markRunning(runStore.createQueuedRun({ sessionId: "session-1" }).id);

    const result = recoverDaemonState({ events, sqlite });

    expect(result.gatewayRuns).toEqual([
      expect.objectContaining({ gatewayRunId: queued.id, previousStatus: "queued" }),
      expect.objectContaining({ gatewayRunId: running.id, previousStatus: "running" }),
    ]);
    expect(runStore.getRun(queued.id)).toMatchObject({
      recovery: expect.objectContaining({ previousStatus: "queued" }),
      status: "recovery_required",
    });
    expect(runStore.getRun(running.id)).toMatchObject({
      recovery: expect.objectContaining({ previousStatus: "running" }),
      status: "recovery_required",
    });
    expect(events.listEvents("session-1").map((event) => event.type)).toEqual([
      "recovery.note",
      "recovery.note",
    ]);

    expect(recoverDaemonState({ events, sqlite }).gatewayRuns).toEqual([]);
    expect(events.listEvents("session-1")).toHaveLength(2);
  });
});

function openHarness(): {
  events: EventStore;
  runStore: GatewayRunStore;
  sqlite: ReturnType<typeof openSqlite>["sqlite"];
} {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-daemon-recovery-"));
  tempDirs.push(dir);

  const { sqlite } = openSqlite(join(dir, "test.sqlite"));
  applyMigrations(sqlite, { migrationsFolder: "drizzle" });

  return {
    events: new EventStore(sqlite),
    runStore: new GatewayRunStore(sqlite),
    sqlite,
  };
}
