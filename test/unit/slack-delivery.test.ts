import { describe, expect, test } from "vitest";
import type { EventRecord } from "@/db/event-store.js";
import {
  parseSlackTargetId,
  SlackDeliveryAdapter,
  slackTargetId,
} from "@/platforms/slack/delivery.js";

describe("SlackDeliveryAdapter", () => {
  test("posts event text to a Slack thread", async () => {
    const calls: unknown[] = [];
    const adapter = new SlackDeliveryAdapter({
      client: {
        chat: {
          async postMessage(params: unknown) {
            calls.push(params);
            return { ts: "1700000001.000002" };
          },
        },
      },
    });

    await expect(
      adapter.deliver({
        event: openEvent({
          payload: { text: "hello from Shepherd" },
          type: "gateway.message",
        }),
        targetId: slackTargetId({ channelId: "C123", threadTs: "1700000000.000001" }),
      }),
    ).resolves.toEqual({ remoteMessageId: "1700000001.000002" });

    expect(calls).toEqual([
      {
        channel: "C123",
        text: "hello from Shepherd",
        thread_ts: "1700000000.000001",
      },
    ]);
  });

  test("uses customized username and avatar only when enabled", async () => {
    const calls: unknown[] = [];
    const adapter = new SlackDeliveryAdapter({
      allowCustomize: true,
      client: {
        chat: {
          async postMessage(params: unknown) {
            calls.push(params);
            return { ts: "1700000001.000002" };
          },
        },
      },
    });

    await adapter.deliver({
      event: openEvent({
        payload: {
          presentation: {
            avatarUrl: "https://example.com/avatar.png",
            displayName: "Ryo",
          },
          text: "from TUI",
        },
        type: "user.message",
      }),
      targetId: slackTargetId({ channelId: "C123" }),
    });

    expect(calls[0]).toMatchObject({
      channel: "C123",
      icon_url: "https://example.com/avatar.png",
      text: "from TUI",
      username: "Ryo",
    });
  });
});

describe("Slack target ids", () => {
  test("round-trips channel and optional thread ts", () => {
    expect(parseSlackTargetId(slackTargetId({ channelId: "C123" }))).toEqual({
      channelId: "C123",
    });
    expect(
      parseSlackTargetId(slackTargetId({ channelId: "C123", threadTs: "1700000000.000001" })),
    ).toEqual({
      channelId: "C123",
      threadTs: "1700000000.000001",
    });
  });
});

function openEvent(input: { payload: unknown; type: string }): EventRecord {
  return {
    actorId: null,
    createdAt: new Date(0),
    id: 1,
    idempotencyKey: null,
    payload: input.payload,
    sessionId: "session-1",
    type: input.type,
  };
}
