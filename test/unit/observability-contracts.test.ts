import { Value } from "@sinclair/typebox/value";
import { describe, expect, test } from "vitest";
import {
  agentGetInputSchema,
  agentListInputSchema,
  agentReadInputSchema,
  agentTelemetryInputSchema,
} from "@/observability/schemas.js";

describe("agent observability contracts", () => {
  test("validates agent list scopes", () => {
    expect(Value.Check(agentListInputSchema, {})).toBe(true);
    expect(Value.Check(agentListInputSchema, { all: true })).toBe(true);
    expect(
      Value.Check(agentListInputSchema, { herdrSessionName: "default", workspaceId: "wB" }),
    ).toBe(true);
    expect(Value.Check(agentListInputSchema, { observedWorkspaceId: "ow_1" })).toBe(false);
  });

  test("validates agent get and read input", () => {
    expect(Value.Check(agentGetInputSchema, { target: "claude", workspaceId: "wB" })).toBe(true);
    expect(Value.Check(agentReadInputSchema, { limit: 10, target: "wB:p2" })).toBe(true);
    expect(Value.Check(agentReadInputSchema, { limit: 0, target: "wB:p2" })).toBe(false);
    expect(Value.Check(agentReadInputSchema, { limit: 501, target: "wB:p2" })).toBe(false);
  });

  test("validates agent telemetry", () => {
    expect(
      Value.Check(agentTelemetryInputSchema, {
        event: {
          artifactRefs: [],
          isError: false,
          occurredAt: "2026-07-08T00:00:00.000Z",
          outputExcerpt: "ok",
          redactionApplied: false,
          runtime: "pi",
          sessionRef: null,
          toolCallId: "tool-1",
          toolName: "bash",
          turnId: "turn-1",
          type: "agent.tool.completed",
        },
        workspaceId: "wB",
      }),
    ).toBe(true);
  });
});
