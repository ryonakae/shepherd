import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  getGatewayStatus,
  resolveGatewayControlPaths,
  startGatewayProcess,
  stopGatewayProcess,
} from "@/gateway/process-manager.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-gateway-process-"));
  tempDirs.push(dir);
  return dir;
}

describe("gateway process manager", () => {
  test("resolves default control paths next to the database", () => {
    expect(resolveGatewayControlPaths({ dbPath: "/tmp/shepherd.sqlite" })).toEqual({
      logPath: "/tmp/shepherd.gateway.log",
      pidPath: "/tmp/shepherd.gateway.pid",
    });
  });

  test("reports stopped when the pid file does not exist", async () => {
    const dir = tempDir();
    await expect(
      getGatewayStatus({ pidPath: join(dir, "missing.pid"), socketPath: "/tmp/shepherd.sock" }),
    ).resolves.toEqual({
      pidPath: join(dir, "missing.pid"),
      socketPath: "/tmp/shepherd.sock",
      state: "stopped",
    });
  });

  test("reports running when the pid file contains a live process", async () => {
    const dir = tempDir();
    const pidPath = join(dir, "shepherd.pid");
    writeFileSync(pidPath, "1234\n");

    await expect(
      getGatewayStatus({
        deps: {
          connectSocket: async () => true,
          isProcessRunning: (pid) => pid === 1234,
        },
        pidPath,
        socketPath: "/tmp/shepherd.sock",
      }),
    ).resolves.toEqual({
      pid: 1234,
      pidPath,
      socketPath: "/tmp/shepherd.sock",
      socketReachable: true,
      state: "running",
    });
  });

  test("refuses to start when the gateway is already running", async () => {
    const dir = tempDir();
    const pidPath = join(dir, "shepherd.pid");
    writeFileSync(pidPath, "1234\n");

    await expect(
      startGatewayProcess({
        cliPath: "/repo/dist/src/cli/shepherd.js",
        dbPath: join(dir, "shepherd.sqlite"),
        deps: {
          connectSocket: async () => true,
          isProcessRunning: (pid) => pid === 1234,
          spawnProcess: () => ({ pid: 5678, unref() {} }),
        },
        env: {},
        logPath: join(dir, "shepherd.log"),
        nodePath: "/usr/bin/node",
        pidPath,
        socketPath: "/tmp/shepherd.sock",
      }),
    ).rejects.toThrow("Shepherd Gateway is already running with pid 1234");
  });

  test("starts a detached gateway process and writes its pid", async () => {
    const dir = tempDir();
    const pidPath = join(dir, "shepherd.pid");
    const logPath = join(dir, "shepherd.log");
    const spawned: unknown[] = [];

    const result = await startGatewayProcess({
      cliPath: "/repo/dist/src/cli/shepherd.js",
      configPath: "/tmp/shepherd.yaml",
      dbPath: join(dir, "shepherd.sqlite"),
      deps: {
        spawnProcess: (command, args, options) => {
          spawned.push({ args, command, options });
          return { pid: 5678, unref() {} };
        },
      },
      env: { PATH: "/bin" },
      logPath,
      nodePath: "/usr/bin/node",
      pidPath,
      socketPath: "/tmp/shepherd.sock",
    });

    expect(result).toEqual({ pid: 5678 });
    expect(readFileSync(pidPath, "utf8")).toBe("5678\n");
    expect(spawned).toMatchObject([
      {
        args: [
          "/repo/dist/src/cli/shepherd.js",
          "gateway",
          "run",
          "--db",
          join(dir, "shepherd.sqlite"),
          "--socket",
          "/tmp/shepherd.sock",
          "--config",
          "/tmp/shepherd.yaml",
        ],
        command: "/usr/bin/node",
        options: { detached: true, env: { PATH: "/bin" } },
      },
    ]);
    expect(existsSync(logPath)).toBe(true);
  });

  test("sends SIGTERM and removes the pid file after the process disappears", async () => {
    const dir = tempDir();
    const pidPath = join(dir, "shepherd.pid");
    writeFileSync(pidPath, "1234\n");
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    let running = true;

    const result = await stopGatewayProcess({
      deps: {
        connectSocket: async () => true,
        isProcessRunning: (pid) => pid === 1234 && running,
        killProcess: (pid, signal) => {
          signals.push({ pid, signal });
          running = false;
        },
        waitMs: async () => undefined,
      },
      pidPath,
      socketPath: "/tmp/shepherd.sock",
      timeoutMs: 100,
    });

    expect(result).toEqual({ alreadyStopped: false, pid: 1234 });
    expect(signals).toEqual([{ pid: 1234, signal: "SIGTERM" }]);
    expect(existsSync(pidPath)).toBe(false);
  });
});
