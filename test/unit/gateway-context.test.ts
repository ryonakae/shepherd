import { describe, expect, test } from "vitest";
import type { EventRecord } from "@/db/event-store.js";
import { buildGatewayMessagesFromEvents } from "@/gateway/context.js";

describe("buildGatewayMessagesFromEvents", () => {
  test("projects recent session events into gateway messages", () => {
    expect(
      buildGatewayMessagesFromEvents([
        event({ payload: { text: "hello" }, type: "user.message" }),
        event({ payload: { sourceRuntime: "pi", text: "working" }, type: "assistant.message" }),
        event({ payload: { text: "bash completed" }, type: "pi.tool.completed" }),
        event({ payload: { text: "bash failed" }, type: "pi.tool.failed" }),
        event({ payload: { text: "bash started" }, type: "pi.tool.started" }),
        event({ payload: { message: "Pi turn was in flight." }, type: "recovery.note" }),
        event({ payload: { text: "Herdr progress" }, type: "herdr.progress" }),
      ]),
    ).toEqual([
      { content: "hello", role: "user" },
      { content: "Pi assistant: working", role: "assistant" },
      { content: "Pi tool: bash completed", role: "system" },
      { content: "Pi tool: bash failed", role: "system" },
      { content: "Recovery note: Pi turn was in flight.", role: "system" },
    ]);
  });

  test("formats Pi mirrored user delivery context", () => {
    expect(
      buildGatewayMessagesFromEvents([
        event({
          payload: { presentation: { sourcePlatform: "pi" }, text: "inspect" },
          type: "user.message",
        }),
        event({
          payload: { presentation: { sourcePlatform: "pi-rpc" }, text: "inspect rpc" },
          type: "user.message",
        }),
        event({ payload: { delivery: "steer", text: "stop" }, type: "user.message" }),
        event({ payload: { delivery: "followUp", text: "next" }, type: "user.message" }),
      ]),
    ).toEqual([
      { content: "Pi: inspect", role: "user" },
      { content: "Pi RPC: inspect rpc", role: "user" },
      { content: "Pi steer: stop", role: "user" },
      { content: "Pi follow-up: next", role: "user" },
    ]);
  });

  test("prepends an existing session summary as system context when explicitly requested", () => {
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
