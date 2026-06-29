import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  getShepherdHome,
  loadShepherdDotEnv,
  resolveRuntime,
  resolveRuntimePath,
  resolveRuntimePaths,
  runtimePathsFromRecordOrDefault,
} from "@/config/runtime.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("Shepherd runtime resolver", () => {
  test("uses ~/.shepherd when SHEPHERD_HOME is absent", () => {
    expect(getShepherdHome({})).toBe(resolve(homedir(), ".shepherd"));
  });

  test("uses explicit SHEPHERD_HOME", () => {
    expect(getShepherdHome({ SHEPHERD_HOME: "/tmp/shepherd-dev" })).toBe("/tmp/shepherd-dev");
  });

  test("resolves default runtime paths under Shepherd home", () => {
    const homeDir = tempHome();

    const runtime = resolveRuntime({ environment: { SHEPHERD_HOME: homeDir } });

    expect(runtime.paths).toMatchObject({
      configPath: join(homeDir, "config.yaml"),
      dbPath: join(homeDir, "state.db"),
      envPath: join(homeDir, ".env"),
      homeDir,
      logPath: join(homeDir, "logs/gateway.log"),
      pidPath: join(homeDir, "gateway.pid"),
      piSessionDir: join(homeDir, "pi-sessions"),
      runtimeRecordPath: join(homeDir, "runtime.json"),
      socketPath: join(homeDir, "gateway.sock"),
    });
  });

  test("resolves relative runtime config paths from Shepherd home", () => {
    const homeDir = tempHome();
    writeValidConfig(
      homeDir,
      `runtime:
  db_path: data/state.sqlite
  socket_path: sockets/dev.sock
  pid_path: run/dev.pid
  log_path: logs/dev.log
`,
    );

    const runtime = resolveRuntime({ environment: { SHEPHERD_HOME: homeDir } });

    expect(runtime.paths.dbPath).toBe(join(homeDir, "data/state.sqlite"));
    expect(runtime.paths.socketPath).toBe(join(homeDir, "sockets/dev.sock"));
    expect(runtime.paths.pidPath).toBe(join(homeDir, "run/dev.pid"));
    expect(runtime.paths.logPath).toBe(join(homeDir, "logs/dev.log"));
  });

  test("keeps absolute runtime config paths", () => {
    const homeDir = tempHome();
    writeValidConfig(
      homeDir,
      `runtime:
  db_path: /var/tmp/shepherd/state.sqlite
  socket_path: /var/tmp/shepherd/gateway.sock
  pid_path: /var/tmp/shepherd/gateway.pid
  log_path: /var/tmp/shepherd/gateway.log
`,
    );

    const runtime = resolveRuntime({ environment: { SHEPHERD_HOME: homeDir } });

    expect(runtime.paths.dbPath).toBe("/var/tmp/shepherd/state.sqlite");
    expect(runtime.paths.socketPath).toBe("/var/tmp/shepherd/gateway.sock");
    expect(runtime.paths.pidPath).toBe("/var/tmp/shepherd/gateway.pid");
    expect(runtime.paths.logPath).toBe("/var/tmp/shepherd/gateway.log");
  });

  test("loads .env values over shell values while ignoring SHEPHERD variables", () => {
    const homeDir = tempHome();
    const envPath = join(homeDir, "dotenv-test");
    writeFileSync(
      envPath,
      `SLACK_BOT_TOKEN=file-token
OPENAI_API_KEY="file-key"
SHEPHERD_HOME=/tmp/ignored
SHEPHERD_GATEWAY_SOCKET_PATH=/tmp/ignored.sock
`,
    );

    const environment = loadShepherdDotEnv({
      baseEnvironment: {
        EXISTING: "kept",
        OPENAI_API_KEY: "shell-key",
        SHEPHERD_HOME: homeDir,
      },
      envPath,
    });

    expect(environment.SLACK_BOT_TOKEN).toBe("file-token");
    expect(environment.OPENAI_API_KEY).toBe("file-key");
    expect(environment.EXISTING).toBe("kept");
    expect(environment.SHEPHERD_HOME).toBe(homeDir);
    expect(environment.SHEPHERD_GATEWAY_SOCKET_PATH).toBeUndefined();
  });

  test("throws on invalid config unless invalid config is allowed", () => {
    const homeDir = tempHome();
    writeFileSync(join(homeDir, "config.yaml"), "gateway: [");

    expect(() => resolveRuntime({ environment: { SHEPHERD_HOME: homeDir } })).toThrow(
      "Invalid Shepherd config",
    );

    const runtime = resolveRuntime({
      allowInvalidConfig: true,
      environment: { SHEPHERD_HOME: homeDir },
    });
    expect(runtime.configErrors?.length).toBeGreaterThan(0);
    expect(runtime.paths.dbPath).toBe(join(homeDir, "state.db"));
  });

  test("falls back to runtime record paths for management commands", () => {
    const homeDir = tempHome();
    writeFileSync(join(homeDir, "config.yaml"), "gateway: [");
    writeFileSync(
      join(homeDir, "runtime.json"),
      JSON.stringify({
        dbPath: join(homeDir, "last-state.db"),
        homeDir,
        logPath: join(homeDir, "last.log"),
        pid: 1234,
        pidPath: join(homeDir, "last.pid"),
        socketPath: join(homeDir, "last.sock"),
        startedAt: "2026-06-29T00:00:00.000Z",
        version: 1,
      }),
    );

    const runtime = resolveRuntime({
      allowInvalidConfig: true,
      environment: { SHEPHERD_HOME: homeDir },
    });
    const paths = runtimePathsFromRecordOrDefault({ environment: runtime.environment });

    expect(runtime.configErrors?.length).toBeGreaterThan(0);
    expect(paths.dbPath).toBe(join(homeDir, "last-state.db"));
    expect(paths.socketPath).toBe(join(homeDir, "last.sock"));
    expect(paths.pidPath).toBe(join(homeDir, "last.pid"));
    expect(paths.logPath).toBe(join(homeDir, "last.log"));
  });

  test("falls back to home defaults when runtime record is missing", () => {
    const homeDir = tempHome();
    writeFileSync(join(homeDir, "config.yaml"), "gateway: [");

    const runtime = resolveRuntime({
      allowInvalidConfig: true,
      environment: { SHEPHERD_HOME: homeDir },
    });
    const paths = runtimePathsFromRecordOrDefault({ environment: runtime.environment });

    expect(runtime.configErrors?.length).toBeGreaterThan(0);
    expect(paths.dbPath).toBe(join(homeDir, "state.db"));
    expect(paths.socketPath).toBe(join(homeDir, "gateway.sock"));
    expect(paths.pidPath).toBe(join(homeDir, "gateway.pid"));
    expect(paths.logPath).toBe(join(homeDir, "logs/gateway.log"));
  });

  test("resolves explicit runtime path values", () => {
    expect(resolveRuntimePath("/home/shepherd", "state.db")).toBe("/home/shepherd/state.db");
    expect(resolveRuntimePath("/home/shepherd", "/tmp/state.db")).toBe("/tmp/state.db");
  });

  test("resolves paths from an already loaded config", () => {
    const paths = resolveRuntimePaths({
      config: {
        agents: { implementer: { command: "codex" } },
        default_agent: "implementer",
        gateway: {},
        runtime: { db_path: "data/state.db" },
      },
      environment: { SHEPHERD_HOME: "/tmp/shepherd-home" },
    });

    expect(paths.dbPath).toBe("/tmp/shepherd-home/data/state.db");
  });
});

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-runtime-"));
  tempDirs.push(dir);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeValidConfig(homeDir: string, extraYaml = ""): void {
  writeFileSync(
    join(homeDir, "config.yaml"),
    `${extraYaml}gateway: {}
default_agent: implementer
agents:
  implementer:
    command: codex
`,
  );
}
