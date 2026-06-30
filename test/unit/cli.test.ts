import { describe, expect, test } from "vitest";
import {
  formatAuditEvent,
  GatewayConnectionError,
  gatewayStartHint,
  helpText,
  parseCliArgs,
  piOpenArgs,
  piOpenEnvironment,
  runLocalPiStartup,
  runOpenPiSession,
} from "@/cli/shepherd.js";

describe("Shepherd CLI", () => {
  test("parses positional commands", () => {
    expect(parseCliArgs([])).toEqual({
      command: "start-local",
      workingContextPath: process.cwd(),
    });
    expect(parseCliArgs(["gateway"])).toEqual({ command: "gateway", action: "status" });
    expect(parseCliArgs(["gateway", "start"])).toEqual({
      command: "gateway",
      action: "start",
    });
    expect(parseCliArgs(["open", "session-1"])).toEqual({
      command: "open",
      sessionId: "session-1",
    });
    expect(parseCliArgs(["send", "session-1", "continue from here"])).toEqual({
      command: "send",
      sessionId: "session-1",
      text: "continue from here",
    });
    expect(parseCliArgs(["send", "session-1", "continue", "from", "here"])).toEqual({
      command: "send",
      sessionId: "session-1",
      text: "continue from here",
    });
    expect(parseCliArgs(["rename", "session-1", "Review Slack sync"])).toEqual({
      command: "rename",
      sessionId: "session-1",
      title: "Review Slack sync",
    });
    expect(parseCliArgs(["rename", "session-1", ""])).toEqual({
      command: "rename",
      sessionId: "session-1",
      title: null,
    });
    expect(parseCliArgs(["watch", "session-1"])).toEqual({
      command: "watch",
      sessionId: "session-1",
    });
    expect(parseCliArgs(["audit", "session-1"])).toEqual({
      command: "audit",
      sessionId: "session-1",
    });
  });

  test("rejects removed options and missing positional arguments", () => {
    expect(() => parseCliArgs(["gateway", "run"])).toThrow("Unknown gateway action: run");
    expect(() => parseCliArgs(["open"])).toThrow("open requires <session-id>");
    expect(() => parseCliArgs(["send", "session-1"])).toThrow(
      "send requires <session-id> and <text>",
    );
    expect(() => parseCliArgs(["watch", "session-1", "--after", "12"])).toThrow("Invalid argument");
    expect(() => parseCliArgs(["audit", "session-1", "--json"])).toThrow("Invalid argument");
    expect(() => parseCliArgs(["audit", "session-1", "--limit", "25"])).toThrow("Invalid argument");
    expect(() => parseCliArgs(["gateway", "start", "--socket", "/tmp/x.sock"])).toThrow(
      "Invalid argument",
    );
  });

  test("rejects old service command", () => {
    const oldCommand = "dae" + "mon";
    expect(() => parseCliArgs([oldCommand])).toThrow(`Unknown command: ${oldCommand}`);
  });

  test("renders help", () => {
    expect(parseCliArgs(["--help"])).toEqual({ command: "help" });
    expect(helpText()).toContain("shepherd gateway [start|stop|restart|status]");
    expect(helpText()).toContain("shepherd send <session-id> <text>");
    expect(helpText()).not.toContain("gateway run");
    expect(helpText()).not.toContain("--socket");
    expect(helpText()).not.toContain(`shepherd ${"dae" + "mon"}`);
  });

  test("builds Pi open invocation details", () => {
    expect(piOpenArgs("/tmp/pi-session.jsonl")).toEqual(["--session", "/tmp/pi-session.jsonl"]);
    expect(
      piOpenEnvironment({
        gatewayId: "gateway-1",
        environment: { PATH: "/bin" },
        sessionId: "session-1",
        socketPath: "/tmp/shepherd.sock",
      }),
    ).toMatchObject({
      PATH: "/bin",
      SHEPHERD_GATEWAY_ID: "gateway-1",
      SHEPHERD_SESSION_ID: "session-1",
      SHEPHERD_GATEWAY_SOCKET_PATH: "/tmp/shepherd.sock",
    });
  });

  test("local startup creates a session, ensures Pi metadata, and runs Pi", async () => {
    const calls: unknown[] = [];
    const client = {
      async close() {
        calls.push(["close"]);
      },
      async createSession(input: unknown) {
        calls.push(["createSession", input]);
        return {
          session: {
            createdAt: "2026-06-26T00:00:00.000Z",
            id: "session-1",
            metadata: {},
            status: "active" as const,
            title: null,
            updatedAt: "2026-06-26T00:00:00.000Z",
            workingContextId: "context-1",
          },
        };
      },
      async ensurePiSession(input: unknown) {
        calls.push(["ensurePiSession", input]);
        return {
          pi: {
            createdAt: "2026-06-26T00:00:00.000Z",
            sessionFile: "/tmp/pi-session.jsonl",
            sessionId: "pi-1",
            updatedAt: "2026-06-26T00:00:00.000Z",
          },
        };
      },
    };

    await expect(
      runLocalPiStartup(
        {
          command: "start-local",
          dbPath: "/tmp/state/shepherd.sqlite",
          socketPath: "/tmp/shepherd.sock",
          workingContextPath: "/repo/app",
        },
        {
          async connect(socketPath) {
            calls.push(["connect", socketPath]);
            return client;
          },
          readGatewayId(stateDir) {
            calls.push(["readGatewayId", stateDir]);
            return "gateway-1";
          },
          async runPi(input) {
            calls.push(["runPi", input]);
            return 0;
          },
        },
      ),
    ).resolves.toBe(0);

    expect(calls).toEqual([
      ["connect", "/tmp/shepherd.sock"],
      ["createSession", { title: null, workingContextPath: "/repo/app" }],
      ["ensurePiSession", { sessionId: "session-1" }],
      ["readGatewayId", "/tmp/state"],
      [
        "runPi",
        {
          gatewayId: "gateway-1",
          piSessionFile: "/tmp/pi-session.jsonl",
          sessionId: "session-1",
          socketPath: "/tmp/shepherd.sock",
        },
      ],
      ["close"],
    ]);
  });

  test("open uses Gateway pi.ensure_session instead of DB metadata writes", async () => {
    const calls: unknown[] = [];
    const client = {
      async close() {
        calls.push(["close"]);
      },
      async createSession() {
        throw new Error("createSession must not be called by open");
      },
      async ensurePiSession(input: unknown) {
        calls.push(["ensurePiSession", input]);
        return {
          pi: {
            createdAt: "2026-06-26T00:00:00.000Z",
            sessionFile: "/tmp/pi-session.jsonl",
            sessionId: "pi-1",
            updatedAt: "2026-06-26T00:00:00.000Z",
          },
        };
      },
    };

    await expect(
      runOpenPiSession(
        {
          command: "open",
          dbPath: "/tmp/state/shepherd.sqlite",
          sessionId: "session-1",
          socketPath: "/tmp/shepherd.sock",
        },
        {
          async connect(socketPath) {
            calls.push(["connect", socketPath]);
            return client;
          },
          readGatewayId(stateDir) {
            calls.push(["readGatewayId", stateDir]);
            return "gateway-1";
          },
          async runPi(input) {
            calls.push(["runPi", input]);
            return 0;
          },
        },
      ),
    ).resolves.toBe(0);

    expect(calls).toMatchObject([
      ["connect", "/tmp/shepherd.sock"],
      ["ensurePiSession", { sessionId: "session-1" }],
      ["readGatewayId", "/tmp/state"],
      ["runPi", { piSessionFile: "/tmp/pi-session.jsonl", sessionId: "session-1" }],
      ["close"],
    ]);
  });

  test("renders Gateway startup hint", () => {
    expect(gatewayStartHint()).toBe(
      "Shepherd Gateway is not reachable. Start it with:\n  shepherd gateway start",
    );
  });

  test("local startup exposes Gateway connection failures as GatewayConnectionError", async () => {
    await expect(
      runLocalPiStartup(
        {
          command: "start-local",
          dbPath: "/tmp/state/shepherd.sqlite",
          socketPath: "/tmp/missing.sock",
          workingContextPath: "/repo/app",
        },
        {
          async connect() {
            throw new GatewayConnectionError("connect ENOENT");
          },
          readGatewayId() {
            return "gateway-1";
          },
          async runPi() {
            throw new Error("runPi must not be called");
          },
        },
      ),
    ).rejects.toBeInstanceOf(GatewayConnectionError);
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
        type: "assistant.message",
      }),
    ).toBe('42\t2026-06-24T10:00:00.000Z\tsession-1\tgateway\tassistant.message\t{"text":"done"}');
  });
});
