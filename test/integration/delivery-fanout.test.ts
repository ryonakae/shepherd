import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { applyMigrations } from "@/db/apply-migrations.js";
import { openSqlite } from "@/db/client.js";
import { EventStore } from "@/db/event-store.js";
import { SessionBindingStore } from "@/db/session-bindings.js";
import { SessionDeliveryFanout } from "@/delivery/fanout.js";
import {
  DeliveryReceiptStore,
  DeliveryRouter,
  type PlatformDeliveryAdapter,
} from "@/delivery/router.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("SessionDeliveryFanout", () => {
  test("delivers TUI-originated user messages to Slack bindings", async () => {
    const { bindings, events, fanout, sent } = openHarness();
    const session = events.createSession({ id: "session-1" });
    bindings.ensureBinding({
      platform: "slack",
      sessionId: session.id,
      spaceId: "C123",
      threadId: "1700000000.000001",
    });

    const event = events.appendEvent({
      payload: {
        presentation: { sourcePlatform: "tui" },
        text: "from TUI",
      },
      sessionId: session.id,
      type: "user.message",
    });

    await expect(fanout.deliverEvent(event)).resolves.toMatchObject([
      {
        platform: "slack",
        status: "sent",
        targetId: "C123:1700000000.000001",
      },
    ]);
    expect(sent).toEqual([
      {
        event,
        targetId: "C123:1700000000.000001",
      },
    ]);
  });

  test("does not echo Slack-originated user messages back to Slack", async () => {
    const { bindings, events, fanout, sent } = openHarness();
    const session = events.createSession({ id: "session-1" });
    bindings.ensureBinding({
      platform: "slack",
      sessionId: session.id,
      spaceId: "C123",
      threadId: "1700000000.000001",
    });

    const event = events.appendEvent({
      payload: {
        presentation: { sourcePlatform: "slack" },
        text: "from Slack",
      },
      sessionId: session.id,
      type: "user.message",
    });

    await expect(fanout.deliverEvent(event)).resolves.toEqual([]);
    expect(sent).toEqual([]);
  });

  test("delivers assistant messages to bound platforms", async () => {
    const { bindings, events, fanout, sent } = openHarness();
    const session = events.createSession({ id: "session-1" });
    bindings.ensureBinding({
      platform: "slack",
      sessionId: session.id,
      spaceId: "C123",
      threadId: "1700000000.000001",
    });

    const event = events.appendEvent({
      payload: { text: "work completed" },
      sessionId: session.id,
      type: "assistant.message",
    });

    await expect(fanout.deliverEvent(event)).resolves.toHaveLength(1);
    expect(sent[0]).toMatchObject({
      event,
      targetId: "C123:1700000000.000001",
    });
  });
});

function openHarness(): {
  bindings: SessionBindingStore;
  events: EventStore;
  fanout: SessionDeliveryFanout;
  sent: Array<{ event: unknown; targetId: string }>;
} {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-delivery-fanout-"));
  tempDirs.push(dir);

  const { sqlite } = openSqlite(join(dir, "test.sqlite"));
  applyMigrations(sqlite, { migrationsFolder: "drizzle" });
  const bindings = new SessionBindingStore(sqlite);
  const events = new EventStore(sqlite);
  const receipts = new DeliveryReceiptStore(sqlite);
  const sent: Array<{ event: unknown; targetId: string }> = [];
  const adapter: PlatformDeliveryAdapter = {
    async deliver(input) {
      sent.push(input);
      return { remoteMessageId: `remote-${sent.length}` };
    },
  };
  const router = new DeliveryRouter({
    adapters: { slack: adapter },
    receipts,
  });

  return {
    bindings,
    events,
    fanout: new SessionDeliveryFanout({ bindings, router }),
    sent,
  };
}
