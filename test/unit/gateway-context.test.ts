import { describe, expect, test } from "vitest";
import type { EventRecord } from "@/db/event-store.js";
import { buildGatewayMessagesFromEvents } from "@/gateway/context.js";

describe("buildGatewayMessagesFromEvents", () => {
  test("projects recent session events into gateway messages", () => {
    expect(
      buildGatewayMessagesFromEvents([
        event({ payload: { text: "hello" }, type: "user.message" }),
        event({ payload: { text: "working" }, type: "gateway.message" }),
        event({
          payload: {
            message: "Gateway run was in flight during daemon startup.",
          },
          type: "recovery.note",
        }),
        event({
          payload: {
            text: "Herdr progress agent.status status=idle agent=claude-impl",
          },
          type: "herdr.progress",
        }),
        event({ payload: { tool: "x" }, type: "logical_tool.started" }),
      ]),
    ).toEqual([
      { content: "hello", role: "user" },
      { content: "working", role: "assistant" },
      {
        content: "Recovery note: Gateway run was in flight during daemon startup.",
        role: "system",
      },
      {
        content: "Herdr progress: Herdr progress agent.status status=idle agent=claude-impl",
        role: "system",
      },
    ]);
  });

  test("prepends an existing session summary as system context", () => {
    expect(
      buildGatewayMessagesFromEvents(
        [event({ payload: { text: "hello" }, type: "user.message" })],
        {
          summary: "User asked for a Slack sync implementation.",
        },
      ),
    ).toEqual([
      {
        content: "Session summary so far:\nUser asked for a Slack sync implementation.",
        role: "system",
      },
      { content: "hello", role: "user" },
    ]);
  });
});

function event(input: { payload: unknown; type: string }): EventRecord {
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
