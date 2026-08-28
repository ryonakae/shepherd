import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  formatCliError,
  helpText,
  parseCliArgs,
  runCliCommand,
  shouldRunCliMain,
  versionText,
} from "@/cli/shepherd.js";

type FakeClient = {
  calls: unknown[];
  close(): void;
  request(method: string, params: unknown): Promise<unknown>;
};

describe("shepherd CLI", () => {
  test("parses agent list with current Herdr workspace", () => {
    expect(parseCliArgs(["agent", "list"], { HERDR_ENV: "1", HERDR_WORKSPACE_ID: "wB" })).toEqual({
      command: "agent-list",
      json: false,
      workspaceId: "wB",
    });
  });

  test("parses explicit agent scopes", () => {
    expect(parseCliArgs(["agent", "list", "--all", "--json"])).toEqual({
      all: true,
      command: "agent-list",
      json: true,
    });
    expect(parseCliArgs(["agent", "list", "--workspace", "wB", "--session", "default"])).toEqual({
      command: "agent-list",
      herdrSessionName: "default",
      json: false,
      workspaceId: "wB",
    });
    expect(parseCliArgs(["agent", "list", "--session", "default"])).toEqual({
      command: "agent-list",
      herdrSessionName: "default",
      json: false,
    });
  });

  test("parses agent get and read", () => {
    expect(
      parseCliArgs(["agent", "get", "claude", "--json"], {
        HERDR_ENV: "1",
        HERDR_WORKSPACE_ID: "wB",
      }),
    ).toEqual({ command: "agent-get", json: true, target: "claude", workspaceId: "wB" });
    expect(parseCliArgs(["agent", "get", "claude", "--session", "default", "--json"])).toEqual({
      command: "agent-get",
      herdrSessionName: "default",
      json: true,
      target: "claude",
    });
    expect(
      parseCliArgs(["agent", "read", "wB:p2", "--limit", "20", "--json"], {
        HERDR_ENV: "1",
        HERDR_WORKSPACE_ID: "wB",
      }),
    ).toEqual({ command: "agent-read", json: true, limit: 20, target: "wB:p2", workspaceId: "wB" });
    expect(() => parseCliArgs(["agent", "read", "wB:p2", "--limit", "0"])).toThrow(
      "--limit must be between 1 and 500",
    );
  });

  test("parses root help and version flags", () => {
    expect(parseCliArgs([])).toEqual({ command: "help", topic: "root" });
    expect(parseCliArgs(["--help"])).toEqual({ command: "help", topic: "root" });
    expect(parseCliArgs(["-h"])).toEqual({ command: "help", topic: "root" });
    expect(parseCliArgs(["--version"])).toEqual({ command: "version" });
    expect(parseCliArgs(["-v"])).toEqual({ command: "version" });
  });

  test.each([
    { args: ["agent", "--help"], topic: "agent" },
    { args: ["agent", "-h"], topic: "agent" },
    { args: ["agent", "list", "--help"], topic: "agent-list" },
    { args: ["agent", "list", "-h"], topic: "agent-list" },
    { args: ["agent", "get", "--help"], topic: "agent-get" },
    { args: ["agent", "get", "-h"], topic: "agent-get" },
    { args: ["agent", "read", "--help"], topic: "agent-read" },
    { args: ["agent", "read", "-h"], topic: "agent-read" },
    { args: ["daemon", "--help"], topic: "daemon" },
    { args: ["daemon", "-h"], topic: "daemon" },
    { args: ["daemon", "start", "--help"], topic: "daemon-start" },
    { args: ["daemon", "start", "-h"], topic: "daemon-start" },
    { args: ["daemon", "stop", "--help"], topic: "daemon-stop" },
    { args: ["daemon", "stop", "-h"], topic: "daemon-stop" },
    { args: ["daemon", "restart", "--help"], topic: "daemon-restart" },
    { args: ["daemon", "restart", "-h"], topic: "daemon-restart" },
    { args: ["daemon", "status", "--help"], topic: "daemon-status" },
    { args: ["daemon", "status", "-h"], topic: "daemon-status" },
  ])("parses contextual help for $args", ({ args, topic }) => {
    expect(parseCliArgs(args)).toEqual({ command: "help", topic });
  });

  test("help flags take precedence over trailing arguments", () => {
    expect(parseCliArgs(["--help", "unexpected"])).toEqual({ command: "help", topic: "root" });
    expect(parseCliArgs(["agent", "--help", "unexpected"])).toEqual({
      command: "help",
      topic: "agent",
    });
    expect(parseCliArgs(["agent", "list", "--help", "unexpected"])).toEqual({
      command: "help",
      topic: "agent-list",
    });
    expect(parseCliArgs(["daemon", "start", "--help", "unexpected"])).toEqual({
      command: "help",
      topic: "daemon-start",
    });
  });

  test("rejects unknown commands", () => {
    expect(() => parseCliArgs(["legacy-command"])).toThrow("Unknown command");
    expect(() => parseCliArgs(["help"])).toThrow("Unknown command: help");
  });

  test("renders root and contextual help", () => {
    expect(helpText()).toContain("Shepherd observes coding agents managed by Herdr.");
    expect(helpText()).toContain("shepherd agent --help");
    expect(helpText()).toContain("-v, --version");
    expect(helpText("agent")).toContain("list            List indexed agents");
    expect(helpText("agent-list")).toContain("--all");
    expect(helpText("agent-get")).toContain("shepherd agent get <target>");
    expect(helpText("agent-read")).toContain("--limit <number>");
    expect(helpText("daemon")).toContain("start       Start the daemon");
    expect(helpText("daemon-start")).toContain("shepherd daemon start");
  });

  test("renders the package version", () => {
    const manifest = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
    expect(versionText()).toBe(`shepherd ${manifest.version}`);
  });

  test("adds contextual help hints only to usage errors", () => {
    expect(formatCliError(captureError(() => parseCliArgs(["unknown"])))).toBe(
      "Unknown command: unknown\nRun `shepherd --help` for usage.",
    );
    expect(formatCliError(captureError(() => parseCliArgs(["agent", "unknown"])))).toBe(
      "Unknown agent command: unknown\nRun `shepherd agent --help` for usage.",
    );
    expect(formatCliError(captureError(() => parseCliArgs(["agent", "read"])))).toBe(
      "agent read requires <target>\nRun `shepherd agent read --help` for usage.",
    );
    expect(formatCliError(captureError(() => parseCliArgs(["daemon", "unknown"])))).toBe(
      "Unknown daemon action: unknown\nRun `shepherd daemon --help` for usage.",
    );
    expect(formatCliError(new Error("request failed"))).toBe("request failed");
  });

  test("runs main when the package bin symlink points at the CLI module", () => {
    expect(
      shouldRunCliMain({
        argvPath: "/tmp/prefix/bin/shepherd",
        modulePath: "/tmp/prefix/lib/node_modules/shepherd/dist/src/cli/shepherd.js",
        realArgvPath: "/tmp/prefix/lib/node_modules/shepherd/dist/src/cli/shepherd.js",
      }),
    ).toBe(true);
  });

  test("prints help and version without connecting to the daemon", async () => {
    const output: string[] = [];
    const deps = {
      connect: async () => {
        throw new Error("should not connect");
      },
      output: (line: string) => output.push(line),
      socketPath: "/tmp/s.sock",
    };

    await runCliCommand({ command: "help", topic: "agent" }, deps);
    await runCliCommand({ command: "version" }, deps);

    expect(output).toEqual([helpText("agent"), versionText()]);
  });

  test("dispatches agent JSON commands", async () => {
    const client = createFakeClient();
    const output: string[] = [];
    await runCliCommand(
      { command: "agent-read", json: true, limit: 10, target: "claude", workspaceId: "wB" },
      {
        connect: async () => client,
        output: (line) => output.push(line),
        socketPath: "/tmp/s.sock",
      },
    );
    expect(client.calls).toEqual([
      ["agent.read", { limit: 10, target: "claude", workspaceId: "wB" }],
      ["close"],
    ]);
    expect(JSON.parse(output[0] ?? "")).toMatchObject({
      agent: { agent: "codex", messages: [], name: "reviewer" },
    });
  });

  test("renders human agent list", async () => {
    const client = createFakeClient();
    const output: string[] = [];
    await runCliCommand(
      { command: "agent-list", json: false, workspaceId: "wB" },
      {
        connect: async () => client,
        output: (line) => output.push(line),
        socketPath: "/tmp/s.sock",
      },
    );
    expect(output[0]).toContain("status\tname\tagent\tpane\tlast user\tlast assistant\tupdated");
    expect(output[0]).toContain("idle\treviewer\tcodex\twB:p1\tfix bug\tdone");
    expect(output[0]).toContain("idle\t\tcodex\twB:p2");
  });

  test("renders separate live name and agent kind in human get and read output", async () => {
    const client = createFakeClient();
    const getOutput: string[] = [];
    await runCliCommand(
      { command: "agent-get", json: false, target: "reviewer", workspaceId: "wB" },
      {
        connect: async () => client,
        output: (line) => getOutput.push(line),
        socketPath: "/tmp/s.sock",
      },
    );
    expect(getOutput[0]).toContain("name: reviewer\nagent: codex");

    const readOutput: string[] = [];
    await runCliCommand(
      { command: "agent-read", json: false, target: "reviewer", workspaceId: "wB" },
      {
        connect: async () => client,
        output: (line) => readOutput.push(line),
        socketPath: "/tmp/s.sock",
      },
    );
    expect(readOutput[0]).toContain("name: reviewer\nagent: codex\npane: wB:p1");

    const unnamedOutput: string[] = [];
    const unnamed = createFakeClient({ name: null });
    await runCliCommand(
      { command: "agent-get", json: false, target: "codex", workspaceId: "wB" },
      {
        connect: async () => unnamed,
        output: (line) => unnamedOutput.push(line),
        socketPath: "/tmp/s.sock",
      },
    );
    expect(unnamedOutput[0]).toContain("name: unnamed\nagent: codex");
  });
});

function captureError(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error("Expected action to throw");
}

function createFakeClient(overrides: { name?: string | null } = {}): FakeClient {
  const calls: unknown[] = [];
  const name = Object.hasOwn(overrides, "name") ? overrides.name : "reviewer";
  return {
    calls,
    close: () => calls.push(["close"]),
    async request(method, params) {
      calls.push([method, params]);
      if (method === "agent.list") {
        return {
          agents: [
            {
              agent: "codex",
              agentStatus: "idle",
              history: {
                lastAssistantMessage: { text: "done", timestamp: null, ref: "r2" },
                lastUserMessage: { text: "fix bug", timestamp: null, ref: "r1" },
                source: "codex-jsonl",
                updatedAt: "2026-07-22T00:00:00.000Z",
              },
              name,
              paneId: "wB:p1",
            },
            {
              agent: "codex",
              agentStatus: "idle",
              history: {},
              name: null,
              paneId: "wB:p2",
            },
          ],
        };
      }
      if (method === "agent.get") {
        return {
          agent: {
            agent: "codex",
            agentStatus: "idle",
            herdrSessionName: "default",
            history: {},
            name,
            paneId: "wB:p1",
            terminalId: "term_1",
            workspaceId: "wB",
          },
        };
      }
      if (method === "agent.read") {
        return { agent: { agent: "codex", messages: [], name, paneId: "wB:p1" } };
      }
      return {};
    },
  };
}
