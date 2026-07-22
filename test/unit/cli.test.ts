import { describe, expect, test } from "vitest";
import { helpText, parseCliArgs, runCliCommand, shouldRunCliMain } from "@/cli/shepherd.js";

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

  test("rejects unknown commands", () => {
    expect(() => parseCliArgs(["legacy-command"])).toThrow("Unknown command");
  });

  test("renders help for agent commands", () => {
    expect(helpText()).toContain("shepherd agent list");
    expect(helpText()).toContain("shepherd agent get <target>");
    expect(helpText()).toContain("shepherd agent read <target>");
    expect(helpText()).toContain("shepherd help");
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
