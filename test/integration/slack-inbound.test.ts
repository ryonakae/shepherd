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

  test("applies team, channel, and user allowlists as an AND policy", async () => {
    const { stores } = openSlackInboundHarness();
    const debugLogs: unknown[] = [];
    const handler = new SlackInboundHandler(stores, {
      logger: {
        debug(message, metadata) {
          debugLogs.push({ message, metadata });
        },
      },
      policy: {
        allowedChannels: ["C123"],
        allowedTeams: ["T123"],
        allowedUsers: ["U123"],
      },
    });

    const allowed = await handler.handleMessageEvent({
      channel: "C123",
      team: "T123",
      text: "allowed",
      ts: "1700000001.000001",
      type: "message",
      user: "U123",
    });
    const wrongTeam = await handler.handleMessageEvent({
      channel: "C123",
      team: "T999",
      text: "blocked by team",
      ts: "1700000002.000001",
      type: "message",
      user: "U123",
    });
    const wrongChannel = await handler.handleMessageEvent({
      channel: "C999",
      team: "T123",
      text: "blocked by channel",
      ts: "1700000003.000001",
      type: "message",
      user: "U123",
    });
    const wrongUser = await handler.handleMessageEvent({
      channel: "C123",
      team: "T123",
      text: "blocked by user",
      ts: "1700000004.000001",
      type: "message",
      user: "U999",
    });

    expect(allowed?.event.type).toBe("user.message");
    expect(wrongTeam).toBeUndefined();
    expect(wrongChannel).toBeUndefined();
    expect(wrongUser).toBeUndefined();
    expect(stores.sqlite.prepare("select count(*) as count from sessions").get()).toEqual({
      count: 1,
    });
    expect(stores.sqlite.prepare("select count(*) as count from events").get()).toEqual({
      count: 1,
    });
    expect(debugLogs).toEqual([
      {
        message: "slack policy denied: team",
        metadata: { channelId: "C123", teamId: "T999", userId: "U123" },
      },
      {
        message: "slack policy denied: channel",
        metadata: { channelId: "C999", teamId: "T123", userId: "U123" },
      },
      {
        message: "slack policy denied: user",
        metadata: { channelId: "C123", teamId: "T123", userId: "U999" },
      },
    ]);
  });

  test("treats unset allowlists as unrestricted for that axis", async () => {
    const { handler } = openSlackInboundHarness({
      policy: {
        allowedChannels: ["C123"],
      },
    });

    const result = await handler.handleMessageEvent({
      channel: "C123",
      team: "T999",
      text: "allowed without team or user allowlists",
      ts: "1700000001.000001",
      type: "message",
      user: "U999",
    });

    expect(result?.event.type).toBe("user.message");
  });

  test("does not store bot, edit, or delete message events", async () => {
    const { handler, stores } = openSlackInboundHarness();

    for (const event of [
      {
        bot_id: "B123",
        channel: "C123",
        text: "bot",
        ts: "1700000001.000001",
        type: "message",
      },
      {
        channel: "C123",
        subtype: "message_changed",
        text: "edited",
        ts: "1700000002.000001",
        type: "message",
        user: "U123",
      },
      {
        channel: "C123",
        subtype: "message_deleted",
        ts: "1700000003.000001",
        type: "message",
        user: "U123",
      },
    ]) {
      await expect(handler.handleMessageEvent(event)).resolves.toBeUndefined();
    }

    expect(stores.sqlite.prepare("select count(*) as count from sessions").get()).toEqual({
      count: 0,
    });
    expect(stores.sqlite.prepare("select count(*) as count from events").get()).toEqual({
      count: 0,
    });
  });
});

function openSlackInboundHarness(
  options: ConstructorParameters<typeof SlackInboundHandler>[1] = {},
): {
  handler: SlackInboundHandler;
  stores: {
    bindings: SessionBindingStore;
    events: EventStore;
    sqlite: ReturnType<typeof openSqlite>["sqlite"];
  };
} {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-slack-inbound-"));
  tempDirs.push(dir);

  const { sqlite } = openSqlite(join(dir, "test.sqlite"));
  applyMigrations(sqlite, { migrationsFolder: "drizzle" });

  const stores = {
    bindings: new SessionBindingStore(sqlite),
    events: new EventStore(sqlite),
    sqlite,
  };

  return {
    handler: new SlackInboundHandler(stores, options),
    stores,
  };
}
