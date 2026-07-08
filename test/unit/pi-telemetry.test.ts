import { describe, expect, test } from "vitest";
import {
  normalizePiMessageFinalTelemetry,
  normalizePiToolTelemetry,
  piTelemetryIdempotencyKey,
  sanitizeTelemetryExcerpt,
} from "@/observability/pi-telemetry.js";

const sessionRef = {
  source: "herdr:pi",
  agent: "pi",
  kind: "path" as const,
  value: "/tmp/session.jsonl",
};

describe("Pi telemetry normalization", () => {
  test("redacts secret-like values and truncates excerpts", () => {
    const text = "Authorization: Bearer abc token=abc password=abc secret=abc api_key=abc";
    expect(sanitizeTelemetryExcerpt(text).text).toBe(
      "Authorization: Bearer [REDACTED] token=[REDACTED] password=[REDACTED] secret=[REDACTED] api_key=[REDACTED]",
    );
    expect(sanitizeTelemetryExcerpt("x".repeat(5000)).text).toHaveLength(4096);
  });

  test("normalizes tool telemetry and idempotency", () => {
    const event = normalizePiToolTelemetry({
      artifactRefs: ["pi-session:/tmp/session.jsonl#entry=t1"],
      inputPreview: { command: "echo token=abc" },
      isError: true,
      output: "failed password=abc",
      sessionRef,
      toolCallId: "tool-1",
      toolName: "bash",
      turnId: "turn-1",
    });

    expect(event).toMatchObject({
      artifactRefs: ["pi-session:/tmp/session.jsonl#entry=t1"],
      isError: true,
      redactionApplied: true,
      runtime: "pi",
      type: "agent.tool.completed",
    });
    expect(event.inputPreview).toContain("[REDACTED]");
    expect(event.errorExcerpt).toContain("[REDACTED]");
    expect(piTelemetryIdempotencyKey(event)).toBe("telemetry:pi:turn-1:tool:tool-1:completed");
  });

  test("normalizes final message hints", () => {
    const event = normalizePiMessageFinalTelemetry({
      sessionRef,
      stopReason: "stop",
      text: "Completed. Need input before deployment.",
      turnId: "turn-1",
    });

    expect(event).toMatchObject({
      completionHint: "Completed. Need input before deployment.",
      needsInputHint: "Completed. Need input before deployment.",
      redactionApplied: false,
      textExcerpt: "Completed. Need input before deployment.",
      type: "agent.message.final",
    });
    expect(piTelemetryIdempotencyKey(event)).toBe("telemetry:pi:turn-1:message:final");
  });
});
