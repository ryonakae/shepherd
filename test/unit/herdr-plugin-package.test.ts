import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

const pluginModuleUrl = new URL("../../packages/shepherd-herdr-plugin/index.mjs", import.meta.url)
  .href;
const tempDirs: string[] = [];

type FakeClient = {
  calls: unknown[];
  close: () => void;
  request: (method: string, params: unknown) => Promise<unknown>;
};

type PluginModule = {
  defaultSocketPath: (env?: NodeJS.ProcessEnv) => string;
  renderDashboard: (input: {
    workers?: Array<{
      agent?: string | null;
      recommendedAction?: string | null;
      status?: string;
      summary?: string | null;
    }>;
  }) => string;
  runPluginCommand: (
    args: string[],
    deps: {
      clientFactory: () => FakeClient;
      env: NodeJS.ProcessEnv;
      output: (line: string) => void;
    },
  ) => Promise<number>;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

async function importPlugin() {
  return (await import(pluginModuleUrl)) as PluginModule;
}

describe("shepherd Herdr plugin package", () => {
  test("declares manifest actions and panes", () => {
    const manifest = readFileSync("packages/shepherd-herdr-plugin/herdr-plugin.toml", "utf8");
    expect(manifest).toContain('id = "shepherd.observability"');
    expect(manifest).toContain('id = "observe-workspace"');
    expect(manifest).toContain('contexts = ["workspace"]');
    expect(manifest).toContain('id = "dashboard"');
  });

  test("reads Shepherd daemon socket path from runtime record", async () => {
    const { defaultSocketPath } = await importPlugin();
    const dir = join(tmpdir(), `shepherd-herdr-plugin-${process.pid}`);
    tempDirs.push(dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "runtime.json"), JSON.stringify({ socketPath: "/tmp/custom.sock" }));

    expect(defaultSocketPath({ SHEPHERD_HOME: dir })).toBe("/tmp/custom.sock");
  });

  test("observes Herdr context over Shepherd daemon RPC", async () => {
    const { runPluginCommand } = await importPlugin();
    const client = createFakeClient();
    const output: string[] = [];

    await expect(
      runPluginCommand(["observe-workspace"], {
        clientFactory: () => client,
        env: {},
        output: (line) => output.push(line),
      }),
    ).resolves.toBe(2);
    await expect(
      runPluginCommand(["observe-workspace"], {
        clientFactory: () => client,
        env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/herdr.sock", HERDR_WORKSPACE_ID: "w1" },
        output: (line) => output.push(line),
      }),
    ).resolves.toBe(0);

    expect(client.calls).toEqual([
      ["close"],
      ["workspace.observe", { socketPath: "/tmp/herdr.sock", workspaceId: "w1" }],
      ["close"],
    ]);
    expect(output).toContain("observe-workspace requires a Herdr-managed pane");
    expect(output).toContain("Observed workspace ow_1");
  });

  test("dashboard renders worker rows from Shepherd daemon RPC", async () => {
    const { runPluginCommand } = await importPlugin();
    const client = createFakeClient();
    const output: string[] = [];

    await expect(
      runPluginCommand(["dashboard"], {
        clientFactory: () => client,
        env: { SHEPHERD_OBSERVED_WORKSPACE_ID: "ow_1" },
        output: (line) => output.push(line),
      }),
    ).resolves.toBe(0);

    expect(client.calls).toEqual([
      ["workspace.snapshot", { observedWorkspaceId: "ow_1" }],
      ["close"],
    ]);
    expect(output).toContain("done\tpi\tcompleted\treview");
  });

  test("dashboard renders empty worker rows", async () => {
    const { renderDashboard } = await importPlugin();
    expect(renderDashboard({ workers: [] })).toBe("No Shepherd workers observed.");
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

function createFakeClient(): FakeClient {
  const calls: unknown[] = [];
  return {
    calls,
    close: () => calls.push(["close"]),
    async request(method, params) {
      calls.push([method, params]);
      if (method === "workspace.observe") return { observedWorkspace: { id: "ow_1" } };
      if (method === "workspace.snapshot") {
        return {
          workers: [
            { agent: "pi", recommendedAction: "review", status: "done", summary: "completed" },
          ],
        };
      }
      return {};
    },
  };
}
