import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  type GatewayRuntimeRecord,
  getGatewayStatus,
  prepareGatewaySocketPath,
  readGatewayRuntimeRecord,
  startGatewayProcess,
  stopGatewayProcess,
  writeGatewayRuntimeRecord,
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

  test("writes and reads a gateway runtime record", () => {
    const dir = tempDir();
    const recordPath = join(dir, "runtime.json");
    const record = runtimeRecord(dir);

    writeGatewayRuntimeRecord(recordPath, record);

    expect(readGatewayRuntimeRecord(recordPath)).toEqual(record);
    expect(statSync(recordPath).mode & 0o777).toBe(0o600);
  });

  test("returns undefined for missing or invalid runtime records", () => {
    const dir = tempDir();
    expect(readGatewayRuntimeRecord(join(dir, "missing.json"))).toBeUndefined();

    const invalidPath = join(dir, "runtime.json");
    writeFileSync(invalidPath, "not-json");
    expect(readGatewayRuntimeRecord(invalidPath)).toBeUndefined();
  });

  test("refuses to remove a reachable gateway socket", async () => {
    const dir = tempDir();
    const socketPath = join(dir, "gateway.sock");
    writeFileSync(socketPath, "socket-placeholder");

    await expect(
      prepareGatewaySocketPath({
        deps: { connectSocket: async () => true },
        socketPath,
      }),
    ).rejects.toThrow("Shepherd Gateway socket is already reachable");
    expect(existsSync(socketPath)).toBe(true);
  });

  test("removes an unreachable stale gateway socket", async () => {
    const dir = tempDir();
    const socketPath = join(dir, "gateway.sock");
    writeFileSync(socketPath, "socket-placeholder");

    await prepareGatewaySocketPath({
      deps: { connectSocket: async () => false },
      socketPath,
    });

    expect(existsSync(socketPath)).toBe(false);
  });

  test("refuses to start when the gateway is already running", async () => {
    const dir = tempDir();
    const pidPath = join(dir, "shepherd.pid");
    writeFileSync(pidPath, "1234\n");

    await expect(
      startGatewayProcess({
        deps: {
          connectSocket: async () => true,
          isProcessRunning: (pid) => pid === 1234,
          spawnProcess: () => ({ pid: 5678, unref() {} }),
        },
        entrypointPath: "/repo/dist/src/cli/shepherd-gateway.js",
        env: {},
        logPath: join(dir, "shepherd.log"),
        nodePath: "/usr/bin/node",
        pidPath,
        runtimeRecord: runtimeRecord(dir),
        runtimeRecordPath: join(dir, "runtime.json"),
        socketPath: "/tmp/shepherd.sock",
      }),
    ).rejects.toThrow("Shepherd Gateway is already running with pid 1234");
  });

  test("starts a detached gateway process and writes its pid and runtime record", async () => {
    const dir = tempDir();
    const pidPath = join(dir, "shepherd.pid");
    const logPath = join(dir, "shepherd.log");
    const runtimeRecordPath = join(dir, "runtime.json");
    const spawned: unknown[] = [];

    const result = await startGatewayProcess({
      deps: {
        spawnProcess: (command, args, options) => {
          spawned.push({ args, command, options });
          return { pid: 5678, unref() {} };
        },
      },
      entrypointPath: "/repo/dist/src/cli/shepherd-gateway.js",
      env: { PATH: "/bin" },
      logPath,
      nodePath: "/usr/bin/node",
      pidPath,
      runtimeRecord: runtimeRecord(dir),
      runtimeRecordPath,
      socketPath: "/tmp/shepherd.sock",
    });

    expect(result).toEqual({ pid: 5678 });
    expect(readFileSync(pidPath, "utf8")).toBe("5678\n");
    expect(readGatewayRuntimeRecord(runtimeRecordPath)).toMatchObject({
      dbPath: join(dir, "state.db"),
      homeDir: dir,
      logPath,
      pid: 5678,
      pidPath,
      socketPath: "/tmp/shepherd.sock",
      version: 1,
    });
    expect(spawned).toMatchObject([
      {
        args: ["/repo/dist/src/cli/shepherd-gateway.js"],
        command: "/usr/bin/node",
        options: { detached: true, env: { PATH: "/bin" } },
      },
    ]);
    expect(JSON.stringify(spawned)).not.toContain('gateway","run');
    expect(JSON.stringify(spawned)).not.toContain("--db");
    expect(JSON.stringify(spawned)).not.toContain("--socket");
    expect(JSON.stringify(spawned)).not.toContain("--config");
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

function runtimeRecord(dir: string): GatewayRuntimeRecord {
  return {
    dbPath: join(dir, "state.db"),
    homeDir: dir,
    logPath: join(dir, "shepherd.log"),
    pid: 1234,
    pidPath: join(dir, "shepherd.pid"),
    socketPath: "/tmp/shepherd.sock",
    startedAt: "2026-06-29T00:00:00.000Z",
    version: 1,
  };
}
