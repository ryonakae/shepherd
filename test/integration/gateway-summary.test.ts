import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { applyMigrations } from "@/db/apply-migrations.js";
import { openSqlite } from "@/db/client.js";
import { EventStore } from "@/db/event-store.js";
import { SessionSummaryStore } from "@/db/session-summary.js";
import { GatewaySummaryUpdater } from "@/gateway/summary.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("GatewaySummaryUpdater", () => {
  test("updates summary only after the threshold and records an event", async () => {
    const { events, summaries } = openHarness();
    events.createSession({ id: "session-1" });
    const generatedMessages: unknown[] = [];
    const updater = new GatewaySummaryUpdater({
      events,
      provider: {
        async generate(input) {
          generatedMessages.push(input.messages);
          return { text: "A compact summary." };
        },
      },
      summaries,
      thresholdEvents: 3,
    });

    events.appendEvent({ payload: { text: "one" }, sessionId: "session-1", type: "user.message" });
    await expect(updater.maybeUpdate("session-1")).resolves.toBeUndefined();

    events.appendEvent({ payload: { text: "two" }, sessionId: "session-1", type: "user.message" });
    events.appendEvent({
      payload: { text: "three" },
      sessionId: "session-1",
      type: "gateway.message",
    });

    await expect(updater.maybeUpdate("session-1")).resolves.toMatchObject({
      content: "A compact summary.",
      summarizedThroughEventId: 3,
    });

    expect(generatedMessages).toHaveLength(1);
    expect(events.listEvents("session-1").map((event) => event.type)).toEqual([
      "user.message",
      "user.message",
      "gateway.message",
      "summary.updated",
    ]);
    await expect(updater.maybeUpdate("session-1")).resolves.toBeUndefined();
  });
});

function openHarness(): {
  events: EventStore;
  summaries: SessionSummaryStore;
} {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-gateway-summary-"));
  tempDirs.push(dir);

  const { sqlite } = openSqlite(join(dir, "test.sqlite"));
  applyMigrations(sqlite, { migrationsFolder: "drizzle" });

  return {
    events: new EventStore(sqlite),
    summaries: new SessionSummaryStore(sqlite),
  };
}
