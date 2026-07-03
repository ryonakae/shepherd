import { Value } from "@sinclair/typebox/value";
import { describe, expect, test } from "vitest";
import { workerIdentityKey } from "@/observability/contracts.js";
import {
  observeWorkspaceInputSchema,
  runtimeTelemetryInputSchema,
} from "@/observability/schemas.js";

describe("observability contracts", () => {
  test("builds stable worker keys", () => {
    expect(
      workerIdentityKey({
        kind: "agent_session",
        session: { source: "herdr:pi", agent: "pi", kind: "path", value: "/tmp/session.jsonl" },
      }),
    ).toBe("session:herdr:pi:pi:path:/tmp/session.jsonl");

    expect(
      workerIdentityKey({
        kind: "live_pane",
        fallback: { herdrSessionName: "herdr-main", workspaceId: "w1", paneId: "w1:p1" },
      }),
    ).toBe("pane:herdr-main:w1:w1:p1");
  });

  test("validates observe workspace input", () => {
    expect(
      Value.Check(observeWorkspaceInputSchema, { herdrSessionName: "main", workspaceId: "w1" }),
    ).toBe(true);
    expect(Value.Check(observeWorkspaceInputSchema, { workspaceId: "w1" })).toBe(false);
  });

  test("validates runtime telemetry input", () => {
    expect(
      Value.Check(runtimeTelemetryInputSchema, {
        event: {
          artifactRefs: ["pi-session:/tmp/session.jsonl#entry=a1b2c3d4"],
          isError: false,
          occurredAt: "2026-07-02T00:00:00.000Z",
          redactionApplied: true,
          runtime: "pi",
          sessionRef: {
            source: "herdr:pi",
            agent: "pi",
            kind: "path",
            value: "/tmp/session.jsonl",
          },
          toolCallId: "tool-1",
          toolName: "bash",
          turnId: "turn-1",
          type: "worker.tool.completed",
          workerKey: null,
        },
      }),
    ).toBe(true);
  });
});
