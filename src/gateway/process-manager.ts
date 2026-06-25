import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { dirname, resolve } from "node:path";

export type GatewayControlPaths = {
  logPath: string;
  pidPath: string;
};

export type GatewayStatus =
  | { pidPath: string; socketPath: string; state: "stopped"; stalePid?: number }
  | {
      pid: number;
      pidPath: string;
      socketPath: string;
      socketReachable: boolean;
      state: "running";
    };

type GatewaySpawnProcess = (
  command: string,
  args: string[],
  options: {
    detached: boolean;
    env: NodeJS.ProcessEnv;
    stdio: ["ignore", number, number];
  },
) => { pid: number | undefined; unref(): void };

export type GatewayProcessDependencies = {
  connectSocket?: (socketPath: string) => Promise<boolean>;
  isProcessRunning?: (pid: number) => boolean;
  killProcess?: (pid: number, signal: NodeJS.Signals) => void;
  spawnProcess?: GatewaySpawnProcess;
  waitMs?: (ms: number) => Promise<void>;
};

export function resolveGatewayControlPaths(input: {
  dbPath: string;
  logPath?: string;
  pidPath?: string;
}): GatewayControlPaths {
  const stateDir = dirname(resolve(input.dbPath));
  return {
    logPath: input.logPath ?? resolve(stateDir, "shepherd.gateway.log"),
    pidPath: input.pidPath ?? resolve(stateDir, "shepherd.gateway.pid"),
  };
}

export async function getGatewayStatus(input: {
  deps?: GatewayProcessDependencies;
  pidPath: string;
  socketPath: string;
}): Promise<GatewayStatus> {
  const isProcessRunning = input.deps?.isProcessRunning ?? defaultIsProcessRunning;
  const connectSocket = input.deps?.connectSocket ?? defaultConnectSocket;

  if (!existsSync(input.pidPath)) {
    return { pidPath: input.pidPath, socketPath: input.socketPath, state: "stopped" };
  }

  const pid = Number(readFileSync(input.pidPath, "utf8").trim());
  if (!Number.isInteger(pid) || pid <= 0 || !isProcessRunning(pid)) {
    return {
      pidPath: input.pidPath,
      socketPath: input.socketPath,
      stalePid: pid,
      state: "stopped",
    };
  }

  return {
    pid,
    pidPath: input.pidPath,
    socketPath: input.socketPath,
    socketReachable: await connectSocket(input.socketPath),
    state: "running",
  };
}

export async function startGatewayProcess(input: {
  cliPath: string;
  configPath?: string;
  dbPath: string;
  deps?: GatewayProcessDependencies;
  env: NodeJS.ProcessEnv;
  logPath: string;
  nodePath: string;
  pidPath: string;
  socketPath: string;
}): Promise<{ pid: number }> {
  const status = await getGatewayStatus({
    ...(input.deps !== undefined ? { deps: input.deps } : {}),
    pidPath: input.pidPath,
    socketPath: input.socketPath,
  });
  if (status.state === "running") {
    throw new Error(`Shepherd Gateway is already running with pid ${status.pid}`);
  }

  mkdirSync(dirname(input.pidPath), { recursive: true });
  mkdirSync(dirname(input.logPath), { recursive: true });
  if (status.state === "stopped" && status.stalePid !== undefined) {
    rmSync(input.pidPath, { force: true });
  }

  const logFd = openSync(input.logPath, "a");
  let child: { pid: number | undefined; unref(): void };
  try {
    const args = [
      input.cliPath,
      "gateway",
      "run",
      "--db",
      input.dbPath,
      "--socket",
      input.socketPath,
      ...(input.configPath ? ["--config", input.configPath] : []),
    ];
    child = (input.deps?.spawnProcess ?? spawnGatewayProcess)(input.nodePath, args, {
      detached: true,
      env: input.env,
      stdio: ["ignore", logFd, logFd],
    });
  } finally {
    closeSync(logFd);
  }

  if (!child.pid) {
    throw new Error("Failed to start Shepherd Gateway: child pid was not assigned");
  }

  child.unref();
  writeFileSync(input.pidPath, `${child.pid}\n`, { mode: 0o600 });
  return { pid: child.pid };
}

export async function stopGatewayProcess(input: {
  deps?: GatewayProcessDependencies;
  pidPath: string;
  socketPath: string;
  timeoutMs: number;
}): Promise<{ alreadyStopped: boolean; pid?: number }> {
  const deps = input.deps ?? {};
  const status = await getGatewayStatus({
    deps,
    pidPath: input.pidPath,
    socketPath: input.socketPath,
  });
  if (status.state === "stopped") {
    rmSync(input.pidPath, { force: true });
    return { alreadyStopped: true };
  }

  const killProcess = deps.killProcess ?? ((pid, signal) => process.kill(pid, signal));
  const isProcessRunning = deps.isProcessRunning ?? defaultIsProcessRunning;
  const waitMs = deps.waitMs ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  killProcess(status.pid, "SIGTERM");
  const deadline = Date.now() + input.timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessRunning(status.pid)) {
      rmSync(input.pidPath, { force: true });
      return { alreadyStopped: false, pid: status.pid };
    }
    await waitMs(50);
  }

  throw new Error(`Timed out waiting for Shepherd Gateway pid ${status.pid} to stop`);
}

function spawnGatewayProcess(
  command: string,
  args: string[],
  options: Parameters<GatewaySpawnProcess>[2],
): { pid: number | undefined; unref(): void } {
  const child = spawn(command, args, options);
  return { pid: child.pid, unref: () => child.unref() };
}

function defaultIsProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function defaultConnectSocket(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    const done = (value: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(200, () => done(false));
  });
}
