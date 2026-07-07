import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const pluginModuleUrl = new URL("../../packages/shepherd-herdr-plugin/index.mjs", import.meta.url)
  .href;

type PluginModule = {
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
      env: NodeJS.ProcessEnv;
      exec: (
        command: string,
        args: string[],
        options: { env: NodeJS.ProcessEnv },
      ) => Promise<string>;
      output: (line: string) => void;
    },
  ) => Promise<number>;
};

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

  test("observe command requires Herdr context and calls observe-current", async () => {
    const { runPluginCommand } = await importPlugin();
    const calls: unknown[] = [];
    await expect(
      runPluginCommand(["observe-workspace"], {
        env: {},
        exec: async () => "{}",
        output: () => undefined,
      }),
    ).resolves.toBe(2);
    await expect(
      runPluginCommand(["observe-workspace"], {
        env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/herdr.sock", HERDR_WORKSPACE_ID: "w1" },
        exec: async (command, args, options) => {
          calls.push([
            command,
            args,
            options.env?.HERDR_SOCKET_PATH,
            options.env?.HERDR_WORKSPACE_ID,
          ]);
          return JSON.stringify({ observedWorkspace: { id: "ow_1" } });
        },
        output: (line) => calls.push(["output", line]),
      }),
    ).resolves.toBe(0);
    expect(calls).toEqual([
      ["shepherd", ["observe-current", "--json"], "/tmp/herdr.sock", "w1"],
      ["output", "Observed workspace ow_1"],
    ]);
  });

  test("dashboard renders worker rows", async () => {
    const { renderDashboard } = await importPlugin();
    expect(
      renderDashboard({
        workers: [
          { agent: "pi", recommendedAction: "review", status: "done", summary: "completed" },
        ],
      }),
    ).toContain("done\tpi\tcompleted\treview");
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
