import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { applyMigrations } from "@/db/apply-migrations.js";
import { openSqlite } from "@/db/client.js";
import { EventStore } from "@/db/event-store.js";
import { SessionBindingStore } from "@/db/session-bindings.js";
import { normalizeSlackMessageEvent, SlackInboundHandler } from "@/platforms/slack/inbound.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("normalizeSlackMessageEvent", () => {
  test("normalizes a user-authored Slack message", () => {
    expect(
      normalizeSlackMessageEvent({
        channel: "C123",
        team: "T123",
        text: "ship it",
        ts: "1700000001.000001",
        type: "message",
        user: "U123",
      }),
    ).toEqual({
      actor: {
        displayName: "U123",
        id: "slack:T123:U123",
        presentation: {
          displayName: "U123",
          sourcePlatform: "slack",
          sourceUserId: "U123",
        },
        sourceUserId: "U123",
      },
      channelId: "C123",
      idempotencyKey: "slack:T123:C123:1700000001.000001",
      messageTs: "1700000001.000001",
      teamId: "T123",
      text: "ship it",
      threadTs: "1700000001.000001",
    });
  });

  test("ignores bot messages and non-message events", () => {
    expect(
      normalizeSlackMessageEvent({
        channel: "C123",
        subtype: "bot_message",
        text: "bot",
        ts: "1700000001.000001",
        type: "message",
        user: "U123",
      }),
    ).toBeUndefined();
    expect(normalizeSlackMessageEvent({ type: "reaction_added" })).toBeUndefined();
  });
});

describe("SlackInboundHandler", () => {
  test("creates a Shepherd session for a new Slack thread", async () => {
    const { handler, stores } = openSlackInboundHarness();

    const result = await handler.handleMessageEvent({
      channel: "C123",
      team: "T123",
      text: "please review this branch",
      ts: "1700000001.000001",
      type: "message",
      user: "U123",
    });

    expect(result).toMatchObject({
      createdSession: true,
      event: {
        actorId: "slack:T123:U123",
        payload: {
          presentation: {
            displayName: "U123",
            sourcePlatform: "slack",
            sourceUserId: "U123",
          },
          text: "please review this branch",
        },
        type: "user.message",
      },
      session: {
        title: "please review this branch",
      },
    });
    expect(
      stores.bindings.findByPlatformThread("slack", "C123", "1700000001.000001"),
    ).toMatchObject({
      metadata: { teamId: "T123" },
      sessionId: result?.session.id,
    });
  });

  test("appends follow-up thread messages to the existing session", async () => {
    const { handler, stores } = openSlackInboundHarness();
    const first = await handler.handleMessageEvent({
      channel: "C123",
      team: "T123",
      text: "first",
      ts: "1700000001.000001",
      type: "message",
      user: "U123",
    });
    const second = await handler.handleMessageEvent({
      channel: "C123",
      team: "T123",
      text: "second",
      thread_ts: "1700000001.000001",
      ts: "1700000002.000001",
      type: "message",
      user: "U123",
    });

    expect(second?.createdSession).toBe(false);
    expect(second?.session.id).toBe(first?.session.id);
    expect(stores.events.listEvents(first?.session.id ?? "").map((event) => event.id)).toEqual([
      first?.event.id,
      second?.event.id,
    ]);
  });

  test("deduplicates retried Slack delivery events", async () => {
    const { handler, stores } = openSlackInboundHarness();
    const first = await handler.handleMessageEvent({
      channel: "C123",
      team: "T123",
      text: "hello",
      ts: "1700000001.000001",
      type: "message",
      user: "U123",
    });
    const retry = await handler.handleMessageEvent({
      channel: "C123",
      team: "T123",
      text: "hello again",
      ts: "1700000001.000001",
      type: "message",
      user: "U123",
    });

    expect(retry?.event).toEqual(first?.event);
    expect(stores.events.listEvents(first?.session.id ?? "")).toHaveLength(1);
  });
});

function openSlackInboundHarness(): {
  handler: SlackInboundHandler;
  stores: {
    bindings: SessionBindingStore;
    events: EventStore;
  };
} {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-slack-inbound-"));
  tempDirs.push(dir);

  const { sqlite } = openSqlite(join(dir, "test.sqlite"));
  applyMigrations(sqlite, { migrationsFolder: "drizzle" });

  const stores = {
    bindings: new SessionBindingStore(sqlite),
    events: new EventStore(sqlite),
  };

  return {
    handler: new SlackInboundHandler(stores),
    stores,
  };
}
