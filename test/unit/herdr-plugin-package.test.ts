import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

type FakeClient = {
  calls: unknown[];
  close: () => void;
  request: (method: string, params: unknown) => Promise<unknown>;
};

describe("shepherd Herdr plugin package", () => {
  test("declares agent actions", () => {
    const manifest = readFileSync("packages/shepherd-herdr-plugin/herdr-plugin.toml", "utf8");
    expect(manifest).toContain('id = "agent-list"');
    expect(manifest).toContain('title = "Show Shepherd agents"');
    expect(manifest).toContain('title = "Shepherd Agents"');
    expect(manifest).toContain('id = "agents"');
    expect(manifest).not.toContain('id = "legacy"');
  });

  test("renders agent rows from daemon RPC", async () => {
    const { runPluginCommand } = await importPlugin();
    const client = createFakeClient();
    const output: string[] = [];
    await expect(
      runPluginCommand(["agent-list"], {
        clientFactory: () => client,
        env: { HERDR_ENV: "1", HERDR_WORKSPACE_ID: "wB" },
        output: (line: string) => output.push(line),
      }),
    ).resolves.toBe(0);

    expect(client.calls).toEqual([["agent.list", { workspaceId: "wB" }], ["close"]]);
    expect(output[0]).toContain("status\tname\tagent\tpane\tlast user\tlast assistant");
    expect(output[0]).toContain(
      "done\treviewer\tcodex\twB:p2\tReview the diff\tNo blocking issues",
    );
    expect(output[0]).toContain("idle\t\tcodex\twB:p3");
  });

  test("rejects missing Herdr context", async () => {
    const { runPluginCommand } = await importPlugin();
    const client = createFakeClient();
    const output: string[] = [];
    await expect(
      runPluginCommand(["agent-list"], {
        clientFactory: () => client,
        env: {},
        output: (line: string) => output.push(line),
      }),
    ).resolves.toBe(2);
    expect(output[0]).toContain("HERDR_ENV=1");
  });

  test("renders empty agents", async () => {
    const { renderAgents } = await importPlugin();
    expect(renderAgents({ agents: [] })).toBe("No Shepherd agents indexed.");
  });

  test("packages the runtime entrypoint without build output", () => {
    const pack = JSON.parse(
      execFileSync("npm", ["pack", "--dry-run", "--json"], {
        cwd: "packages/shepherd-herdr-plugin",
        encoding: "utf8",
      }),
    ) as Array<{ files: Array<{ path: string }> }>;
    const files = pack[0]?.files.map((file) => file.path) ?? [];

    expect(files).toContain("index.mjs");
    expect(files).toContain("herdr-plugin.toml");
    expect(files.some((file) => file.startsWith("dist/"))).toBe(false);
  });
});

async function importPlugin() {
  const pluginModuleUrl = new URL("../../packages/shepherd-herdr-plugin/index.mjs", import.meta.url)
    .href;
  return import(pluginModuleUrl) as Promise<{
    renderAgents(input: unknown): string;
    runPluginCommand(args: string[], deps: unknown): Promise<number>;
  }>;
}

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
              agent: "codex",
              agentStatus: "done",
              history: {
                lastAssistantMessage: { text: "No blocking issues" },
                lastUserMessage: { text: "Review the diff" },
              },
              name: "reviewer",
              paneId: "wB:p2",
            },
            {
              agent: "codex",
              agentStatus: "idle",
              history: {},
              name: null,
              paneId: "wB:p3",
            },
          ],
        };
      }
      return {};
    },
  };
}
