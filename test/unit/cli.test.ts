import { describe, expect, test } from "vitest";
import { helpText, parseCliArgs, runCliCommand } from "@/cli/shepherd.js";

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
    expect(JSON.parse(output[0] ?? "")).toEqual({ agent: { messages: [] } });
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
    expect(output[0]).toContain("status\tagent\tpane\tlast user\tlast assistant\tupdated");
    expect(output[0]).toContain("idle\tpi\twB:p1\tfix bug\tdone");
  });
});

function createFakeClient(): FakeClient {
  const calls: unknown[] = [];
  return {
    calls,
    close: () => calls.push(["close"]),
    async request(method, params) {
      calls.push([method, params]);
      if (method === "agent.list") {
        return {
          agents: [
            {
              agent: "pi",
              agentStatus: "idle",
              history: {
                lastAssistantMessage: { text: "done", timestamp: null, ref: "r2" },
                lastUserMessage: { text: "fix bug", timestamp: null, ref: "r1" },
                source: "pi-jsonl",
                updatedAt: "2026-07-08T00:00:00.000Z",
              },
              paneId: "wB:p1",
            },
          ],
        };
      }
      if (method === "agent.get") return { agent: { agent: "pi", history: {}, paneId: "wB:p1" } };
      if (method === "agent.read") return { agent: { messages: [] } };
      return {};
    },
  };
}
