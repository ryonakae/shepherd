import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { applyMigrations } from "@/db/apply-migrations.js";
import { openSqlite } from "@/db/client.js";
import { EventStore } from "@/db/event-store.js";
import { HerdrProgressAdapter, toHerdrProgressSignal } from "@/herdr/progress.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("HerdrProgressAdapter", () => {
  test("records Herdr events as structured progress signals", async () => {
    const store = openMigratedEventStore();
    const session = store.createSession({ id: "session-1" });
    const calls: Record<string, unknown>[] = [];
    const adapter = new HerdrProgressAdapter({
      events: store,
      herdrSessionName: "shepherd-api",
      sessionId: session.id,
      source: {
        async waitForEvent(params) {
          calls.push(params ?? {});
          return {
            data: {
              agent: "claude-impl",
              status: "idle",
            },
            id: "evt-1",
            type: "agent.status",
            workspace_id: "w1",
          };
        },
      },
      waitTimeoutMs: 1000,
      workspaceId: "w1",
    });

    const event = await adapter.pollOnce();

    expect(calls).toEqual([{ timeout_ms: 1000, workspace_id: "w1" }]);
    expect(event).toMatchObject({
      idempotencyKey: "herdr:shepherd-api:event:evt-1",
      sessionId: "session-1",
      type: "herdr.progress",
    });
    expect(event.payload).toEqual({
      agent: "claude-impl",
      eventId: "evt-1",
      eventType: "agent.status",
      herdrSessionName: "shepherd-api",
      rawEvent: {
        data: {
          agent: "claude-impl",
          status: "idle",
        },
        id: "evt-1",
        type: "agent.status",
        workspace_id: "w1",
      },
      status: "idle",
      text: "Herdr progress agent.status status=idle agent=claude-impl",
      workspaceId: "w1",
    });
  });

  test("deduplicates repeated Herdr event ids", async () => {
    const store = openMigratedEventStore();
    const session = store.createSession({ id: "session-1" });
    const adapter = new HerdrProgressAdapter({
      events: store,
      herdrSessionName: "shepherd-api",
      sessionId: session.id,
      source: {
        async waitForEvent() {
          return { id: "evt-1", type: "pane.changed" };
        },
      },
    });

    const first = await adapter.pollOnce();
    const second = await adapter.pollOnce();

    expect(second).toEqual(first);
    expect(store.listEvents(session.id)).toHaveLength(1);
  });

  test("normalizes common Herdr event fields without requiring a fixed schema", () => {
    expect(
      toHerdrProgressSignal(
        {
          data: {
            paneId: "w1:p1",
            state: "working",
            tab_id: "w1:t1",
          },
          event_id: 42,
          kind: "pane.output",
        },
        { herdrSessionName: "shepherd-api", workspaceId: "w1" },
      ),
    ).toMatchObject({
      eventId: "42",
      eventType: "pane.output",
      paneId: "w1:p1",
      status: "working",
      tabId: "w1:t1",
      text: "Herdr progress pane.output status=working pane=w1:p1",
      workspaceId: "w1",
    });
  });
});

function openMigratedEventStore(): EventStore {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-herdr-progress-"));
  tempDirs.push(dir);

  const { sqlite } = openSqlite(join(dir, "test.sqlite"));
  applyMigrations(sqlite, { migrationsFolder: "drizzle" });

  return new EventStore(sqlite);
}
