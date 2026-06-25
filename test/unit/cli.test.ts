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
  test("parses no args as local Pi startup", () => {
    expect(
      parseCliArgs([], {
        PWD: "/repo/shepherd",
        SHEPHERD_DB_PATH: "/tmp/shepherd.sqlite",
        SHEPHERD_GATEWAY_SOCKET_PATH: "/tmp/shepherd.sock",
      }),
    ).toEqual({
      command: "start-local",
      dbPath: "/tmp/shepherd.sqlite",
      socketPath: "/tmp/shepherd.sock",
      workingContextPath: process.cwd(),
    });
  });

  test("parses gateway run options", () => {
    expect(
      parseCliArgs([
        "gateway",
        "run",
        "--socket",
        "/tmp/shepherd.sock",
        "--db",
        "/tmp/shepherd.sqlite",
        "--config",
        "/tmp/shepherd.yaml",
      ]),
    ).toEqual({
      action: "run",
      command: "gateway",
      configPath: "/tmp/shepherd.yaml",
      dbPath: "/tmp/shepherd.sqlite",
      socketPath: "/tmp/shepherd.sock",
    });
  });

  test("uses environment defaults for gateway run options", () => {
    expect(
      parseCliArgs(["gateway", "run"], {
        SHEPHERD_CONFIG: "/tmp/env.yaml",
        SHEPHERD_DB_PATH: "/tmp/env.sqlite",
        SHEPHERD_GATEWAY_SOCKET_PATH: "/tmp/env.sock",
      }),
    ).toEqual({
      action: "run",
      command: "gateway",
      configPath: "/tmp/env.yaml",
      dbPath: "/tmp/env.sqlite",
      socketPath: "/tmp/env.sock",
    });
  });

  test("parses gateway managed actions", () => {
    expect(
      parseCliArgs([
        "gateway",
        "start",
        "--socket",
        "/tmp/shepherd.sock",
        "--db",
        "/tmp/shepherd.sqlite",
        "--config",
        "/tmp/shepherd.yaml",
        "--pid",
        "/tmp/shepherd.pid",
        "--log",
        "/tmp/shepherd.log",
        "--timeout-ms",
        "2500",
      ]),
    ).toEqual({
      action: "start",
      command: "gateway",
      configPath: "/tmp/shepherd.yaml",
      dbPath: "/tmp/shepherd.sqlite",
      logPath: "/tmp/shepherd.log",
      pidPath: "/tmp/shepherd.pid",
      socketPath: "/tmp/shepherd.sock",
      timeoutMs: 2500,
    });

    expect(parseCliArgs(["gateway", "status"])).toMatchObject({
      action: "status",
      command: "gateway",
    });
  });

  test("rejects old service command", () => {
    const oldCommand = "dae" + "mon";
    expect(() => parseCliArgs([oldCommand])).toThrow(`Unknown command: ${oldCommand}`);
  });

  test("renders help", () => {
    expect(parseCliArgs(["--help"])).toEqual({ command: "help" });
    expect(helpText()).toContain("shepherd gateway start");
    expect(helpText()).toContain("shepherd gateway run");
    expect(helpText()).not.toContain(`shepherd ${"dae" + "mon"}`);
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

  test("parses open options", () => {
    expect(
      parseCliArgs([
        "open",
        "--socket",
        "/tmp/shepherd.sock",
        "--db",
        "/tmp/shepherd.sqlite",
        "--session",
        "session-1",
      ]),
    ).toEqual({
      command: "open",
      dbPath: "/tmp/shepherd.sqlite",
      sessionId: "session-1",
      socketPath: "/tmp/shepherd.sock",
    });
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
    expect(gatewayStartHint({ SHEPHERD_CONFIG: "/tmp/shepherd.yaml" })).toBe(
      "Shepherd Gateway is not reachable. Start the Gateway first:\n  shepherd gateway start --config /tmp/shepherd.yaml",
    );
    expect(gatewayStartHint({})).toContain("shepherd gateway start --config <path>");
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
