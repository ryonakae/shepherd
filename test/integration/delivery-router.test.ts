import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { applyMigrations } from "@/db/apply-migrations.js";
import { openSqlite } from "@/db/client.js";
import { EventStore } from "@/db/event-store.js";
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

describe("DeliveryRouter", () => {
  test("records sent delivery receipts and prevents duplicate sends", async () => {
    const { event, router, sent, store } = openHarness();

    await expect(
      router.deliver({
        event,
        platform: "slack",
        targetId: "C123:1700000000.000001",
      }),
    ).resolves.toMatchObject({
      remoteMessageId: "remote-1",
      status: "sent",
    });
    await expect(
      router.deliver({
        event,
        platform: "slack",
        targetId: "C123:1700000000.000001",
      }),
    ).resolves.toMatchObject({
      remoteMessageId: "remote-1",
      status: "skipped",
    });

    expect(sent).toHaveLength(1);
    expect(store.getReceipt(event.id, "slack", "C123:1700000000.000001")).toMatchObject({
      remoteMessageId: "remote-1",
      status: "sent",
    });
  });

  test("marks failed receipts for retryable delivery errors", async () => {
    const { event, store } = openHarness();
    const router = new DeliveryRouter({
      adapters: {
        slack: {
          async deliver() {
            throw new Error("Slack unavailable");
          },
        },
      },
      receipts: store,
    });

    await expect(
      router.deliver({
        event,
        platform: "slack",
        targetId: "C123:1700000000.000001",
      }),
    ).rejects.toThrow("Slack unavailable");
    expect(store.getReceipt(event.id, "slack", "C123:1700000000.000001")).toMatchObject({
      failureReason: "Slack unavailable",
      status: "failed",
    });
  });
});

function openHarness(): {
  event: ReturnType<EventStore["appendEvent"]>;
  router: DeliveryRouter;
  sent: unknown[];
  store: DeliveryReceiptStore;
} {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-delivery-"));
  tempDirs.push(dir);

  const { sqlite } = openSqlite(join(dir, "test.sqlite"));
  applyMigrations(sqlite, { migrationsFolder: "drizzle" });
  const events = new EventStore(sqlite);
  const session = events.createSession({ id: "session-1" });
  const event = events.appendEvent({
    payload: { text: "hello" },
    sessionId: session.id,
    type: "gateway.message",
  });
  const store = new DeliveryReceiptStore(sqlite);
  const sent: unknown[] = [];
  const adapter: PlatformDeliveryAdapter = {
    async deliver(input) {
      sent.push(input);
      return { remoteMessageId: `remote-${sent.length}` };
    },
  };

  return {
    event,
    router: new DeliveryRouter({
      adapters: { slack: adapter },
      receipts: store,
    }),
    sent,
    store,
  };
}
