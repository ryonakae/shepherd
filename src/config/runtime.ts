import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { type ConfigLoadError, loadShepherdConfig } from "@/config/load.js";
import type { ShepherdConfig } from "@/config/schema.js";
import { readGatewayRuntimeRecord } from "@/gateway/process-manager.js";

export type RuntimePaths = {
  configPath: string;
  dbPath: string;
  envPath: string;
  homeDir: string;
  logPath: string;
  pidPath: string;
  piSessionDir: string;
  runtimeRecordPath: string;
  socketPath: string;
};

export type RuntimeResolution = {
  config?: ShepherdConfig;
  configErrors?: ConfigLoadError[];
  configPath: string;
  environment: NodeJS.ProcessEnv;
  homeDir: string;
  paths: RuntimePaths;
};

export function getShepherdHome(environment: NodeJS.ProcessEnv = process.env): string {
  const explicit = environment.SHEPHERD_HOME?.trim();
  return resolve(explicit && explicit.length > 0 ? explicit : resolve(homedir(), ".shepherd"));
}

export function resolveRuntimePath(homeDir: string, value: string): string {
  return isAbsolute(value) ? value : resolve(homeDir, value);
}

export function resolveRuntimePaths(
  input: { config?: ShepherdConfig | undefined; environment?: NodeJS.ProcessEnv | undefined } = {},
): RuntimePaths {
  const homeDir = getShepherdHome(input.environment);
  const runtime = input.config?.runtime;

  return {
    configPath: resolve(homeDir, "config.yaml"),
    dbPath: resolveRuntimePath(homeDir, runtime?.db_path ?? "state.db"),
    envPath: resolve(homeDir, ".env"),
    homeDir,
    logPath: resolveRuntimePath(homeDir, runtime?.log_path ?? "logs/shepherd.log"),
    pidPath: resolveRuntimePath(homeDir, runtime?.pid_path ?? "shepherd.pid"),
    piSessionDir: resolve(homeDir, "pi-sessions"),
    runtimeRecordPath: resolve(homeDir, "runtime.json"),
    socketPath: resolveRuntimePath(homeDir, runtime?.socket_path ?? "shepherd.sock"),
  };
}

export function loadShepherdDotEnv(input: {
  baseEnvironment?: NodeJS.ProcessEnv | undefined;
  envPath: string;
}): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...(input.baseEnvironment ?? process.env) };
  if (!existsSync(input.envPath)) {
    return next;
  }

  for (const rawLine of readFileSync(input.envPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const equalsIndex = line.indexOf("=");
    if (equalsIndex <= 0) {
      continue;
    }

    const key = line.slice(0, equalsIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }
    if (key.startsWith("SHEPHERD_")) {
      continue;
    }

    next[key] = unquoteEnvValue(line.slice(equalsIndex + 1).trim());
  }

  return next;
}

export function runtimePathsFromRecordOrDefault(input: {
  environment?: NodeJS.ProcessEnv | undefined;
  recordPath?: string | undefined;
}): RuntimePaths {
  const defaultPaths = resolveRuntimePaths({ environment: input.environment });
  const record = readGatewayRuntimeRecord(input.recordPath ?? defaultPaths.runtimeRecordPath);
  if (!record) {
    return defaultPaths;
  }

  return {
    ...defaultPaths,
    dbPath: record.dbPath,
    logPath: record.logPath,
    pidPath: record.pidPath,
    socketPath: record.socketPath,
  };
}

export function resolveRuntime(
  input: {
    allowInvalidConfig?: boolean | undefined;
    environment?: NodeJS.ProcessEnv | undefined;
  } = {},
): RuntimeResolution {
  const initialPaths = resolveRuntimePaths({ environment: input.environment });
  const environment = loadShepherdDotEnv({
    baseEnvironment: input.environment,
    envPath: initialPaths.envPath,
  });
  const basePaths = resolveRuntimePaths({ environment });

  if (!existsSync(basePaths.configPath)) {
    return {
      configPath: basePaths.configPath,
      environment,
      homeDir: basePaths.homeDir,
      paths: basePaths,
    };
  }

  const loaded = loadShepherdConfig(basePaths.configPath);
  if (!loaded.ok) {
    if (input.allowInvalidConfig) {
      return {
        configErrors: loaded.errors,
        configPath: basePaths.configPath,
        environment,
        homeDir: basePaths.homeDir,
        paths: basePaths,
      };
    }
    throw new Error(
      `Invalid Shepherd config: ${loaded.errors.map((error) => error.message).join("; ")}`,
    );
  }

  const paths = resolveRuntimePaths({ config: loaded.value, environment });
  return {
    config: loaded.value,
    configPath: basePaths.configPath,
    environment,
    homeDir: paths.homeDir,
    paths,
  };
}

function unquoteEnvValue(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
