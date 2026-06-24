import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { applyMigrations } from "@/db/apply-migrations.js";
import { openSqlite } from "@/db/client.js";
import { EventStore } from "@/db/event-store.js";
import { SessionSummaryStore } from "@/db/session-summary.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("SessionSummaryStore", () => {
  test("upserts compact session summaries with a summarized event cursor", () => {
    const { events, summaries } = openHarness();
    events.createSession({ id: "session-1" });

    const first = summaries.upsertSummary({
      content: "Initial summary",
      sessionId: "session-1",
      summarizedThroughEventId: 10,
    });
    const second = summaries.upsertSummary({
      content: "Updated summary",
      sessionId: "session-1",
      summarizedThroughEventId: 20,
    });

    expect(first).toMatchObject({
      content: "Initial summary",
      sessionId: "session-1",
      summarizedThroughEventId: 10,
    });
    expect(second).toMatchObject({
      content: "Updated summary",
      sessionId: "session-1",
      summarizedThroughEventId: 20,
    });
    expect(summaries.getSummary("session-1")).toEqual(second);
  });
});

function openHarness(): {
  events: EventStore;
  summaries: SessionSummaryStore;
} {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-session-summary-"));
  tempDirs.push(dir);

  const { sqlite } = openSqlite(join(dir, "test.sqlite"));
  applyMigrations(sqlite, { migrationsFolder: "drizzle" });

  return {
    events: new EventStore(sqlite),
    summaries: new SessionSummaryStore(sqlite),
  };
}
