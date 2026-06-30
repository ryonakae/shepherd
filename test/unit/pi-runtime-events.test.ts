import { describe, expect, test } from "vitest";
import {
  parsePiRecordToolProgressParams,
  parsePiStreamDeltaParams,
  piToolIdempotencyKey,
  piTurnIdempotencyKey,
  sanitizePiPreviewText,
} from "@/gateway/pi-runtime-events.js";

describe("Pi runtime event helpers", () => {
  test("sanitizes sensitive preview text", () => {
    expect(
      sanitizePiPreviewText(
        "Authorization: Bearer abc\ntoken=abc\npassword=abc\nsecret=abc\napi_key=abc",
      ),
    ).toBe(
      "Authorization: Bearer [redacted]\ntoken=[redacted]\npassword=[redacted]\nsecret=[redacted]\napi_key=[redacted]",
    );
  });

  test("truncates preview text to 240 characters by default", () => {
    const sanitized = sanitizePiPreviewText("x".repeat(260));

    expect(sanitized).toHaveLength(240);
    expect(sanitized.endsWith("...")).toBe(true);
  });

  test("builds Pi turn and tool idempotency keys", () => {
    expect(piTurnIdempotencyKey("turn-1", "assistant")).toBe("pi:turn:turn-1:assistant");
    expect(piToolIdempotencyKey("turn-1", "tool-1", "completed")).toBe(
      "pi:turn:turn-1:tool:tool-1:completed",
    );
  });

  test("rejects missing required fields with explicit messages", () => {
    expect(() =>
      parsePiStreamDeltaParams({ delta: "hi", ownerId: "owner-1", piTurnId: "turn-1" }),
    ).toThrow("sessionId is required");
    expect(() =>
      parsePiStreamDeltaParams({ delta: "hi", piTurnId: "turn-1", sessionId: "session-1" }),
    ).toThrow("ownerId is required");
    expect(() =>
      parsePiStreamDeltaParams({ delta: "hi", ownerId: "owner-1", sessionId: "session-1" }),
    ).toThrow("piTurnId is required");
  });

  test("rejects invalid owner kind and tool status", () => {
    const base = {
      ownerId: "owner-1",
      ownerKind: "bot",
      piSessionFile: "/tmp/session.json",
      piSessionId: "pi-session-1",
      piTurnId: "turn-1",
      sessionId: "session-1",
      status: "started",
      text: "running",
      toolCallId: "tool-call-1",
      toolName: "bash",
    };

    expect(() => parsePiRecordToolProgressParams(base)).toThrow("ownerKind is invalid");
    expect(() =>
      parsePiRecordToolProgressParams({ ...base, ownerKind: "headless_pi", status: "done" }),
    ).toThrow("status is invalid");
  });
});
