import { describe, expect, test } from "vitest";
import { helpText, parseCliArgs } from "@/cli/shepherd.js";

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
      ]),
    ).toEqual({
      actorId: "tui:ryo",
      command: "send",
      displayName: "Ryo",
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
});
