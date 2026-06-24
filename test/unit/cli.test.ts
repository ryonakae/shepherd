import { describe, expect, test } from "vitest";
import { formatAuditEvent, helpText, parseCliArgs } from "@/cli/shepherd.js";

describe("Shepherd CLI", () => {
  test("parses daemon options", () => {
    expect(
      parseCliArgs([
        "daemon",
        "--socket",
        "/tmp/shepherd.sock",
        "--db",
        "/tmp/shepherd.sqlite",
        "--config",
        "/tmp/shepherd.yaml",
      ]),
    ).toEqual({
      command: "daemon",
      configPath: "/tmp/shepherd.yaml",
      dbPath: "/tmp/shepherd.sqlite",
      socketPath: "/tmp/shepherd.sock",
    });
  });

  test("uses environment defaults for daemon options", () => {
    expect(
      parseCliArgs(["daemon"], {
        SHEPHERD_CONFIG: "/tmp/env.yaml",
        SHEPHERD_DB_PATH: "/tmp/env.sqlite",
        SHEPHERD_SOCKET_PATH: "/tmp/env.sock",
      }),
    ).toEqual({
      command: "daemon",
      configPath: "/tmp/env.yaml",
      dbPath: "/tmp/env.sqlite",
      socketPath: "/tmp/env.sock",
    });
  });

  test("renders help", () => {
    expect(parseCliArgs(["--help"])).toEqual({ command: "help" });
    expect(helpText()).toContain("shepherd daemon");
  });

  test("parses send options", () => {
    expect(
      parseCliArgs([
        "send",
        "--socket",
        "/tmp/shepherd.sock",
        "--session",
        "session-1",
        "--text",
        "hello",
        "--actor",
        "tui:ryo",
        "--display-name",
        "Ryo",
        "--provider",
        "openai",
        "--model",
        "gpt-4.1",
      ]),
    ).toEqual({
      actorId: "tui:ryo",
      command: "send",
      displayName: "Ryo",
      providerOverride: {
        model: "gpt-4.1",
        provider: "openai",
      },
      sessionId: "session-1",
      socketPath: "/tmp/shepherd.sock",
      text: "hello",
    });
  });

  test("parses watch options", () => {
    expect(
      parseCliArgs([
        "watch",
        "--socket",
        "/tmp/shepherd.sock",
        "--session",
        "session-1",
        "--after",
        "12",
      ]),
    ).toEqual({
      afterEventId: 12,
      command: "watch",
      sessionId: "session-1",
      socketPath: "/tmp/shepherd.sock",
    });
  });

  test("parses rename options", () => {
    expect(
      parseCliArgs([
        "rename",
        "--socket",
        "/tmp/shepherd.sock",
        "--session",
        "session-1",
        "--title",
        "New title",
      ]),
    ).toEqual({
      command: "rename",
      sessionId: "session-1",
      socketPath: "/tmp/shepherd.sock",
      title: "New title",
    });
  });

  test("parses audit options", () => {
    expect(
      parseCliArgs([
        "audit",
        "--db",
        "/tmp/shepherd.sqlite",
        "--session",
        "session-1",
        "--after",
        "12",
        "--limit",
        "25",
        "--json",
        "true",
      ]),
    ).toEqual({
      afterEventId: 12,
      command: "audit",
      dbPath: "/tmp/shepherd.sqlite",
      json: true,
      limit: 25,
      sessionId: "session-1",
    });
  });

  test("formats audit events as tab-separated records", () => {
    expect(
      formatAuditEvent({
        actorId: "gateway",
        createdAt: new Date("2026-06-24T10:00:00.000Z"),
        id: 42,
        idempotencyKey: null,
        payload: { text: "done" },
        sessionId: "session-1",
        type: "gateway.message",
      }),
    ).toBe('42\t2026-06-24T10:00:00.000Z\tsession-1\tgateway\tgateway.message\t{"text":"done"}');
  });
});
