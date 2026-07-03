import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMigrations } from "@/db/apply-migrations.js";
import { openSqlite } from "@/db/client.js";
import { NotificationCursorStore } from "@/db/notification-cursors.js";
import { ObservedWorkspaceStore } from "@/db/observed-workspaces.js";
import { WorkerEventStore } from "@/db/worker-events.js";
import { WorkerSnapshotStore } from "@/db/worker-snapshots.js";
import { WorkerStore } from "@/db/workers.js";

export const tempDirs: string[] = [];

export function cleanupTempDirs() {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
}

export function openObservabilityDbHarness() {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-observability-db-"));
  tempDirs.push(dir);

  const { sqlite } = openSqlite(join(dir, "test.sqlite"));
  applyMigrations(sqlite, { migrationsFolder: "drizzle" });

  const observedWorkspaces = new ObservedWorkspaceStore(sqlite);
  const workerEvents = new WorkerEventStore(sqlite);
  return {
    cursors: new NotificationCursorStore(sqlite),
    events: workerEvents,
    observedWorkspaces,
    snapshots: new WorkerSnapshotStore(sqlite),
    sqlite,
    workerEvents,
    workers: new WorkerStore(sqlite),
    workspaces: observedWorkspaces,
  };
}
