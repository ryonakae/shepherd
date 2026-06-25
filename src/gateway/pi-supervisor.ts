import { spawn } from "node:child_process";
import type { PiReadinessProcess, PiReadinessSpawn } from "./pi-readiness.js";

export type HeadlessPiSupervisorOptions = {
  command?: string;
  environment?: NodeJS.ProcessEnv;
  idleTimeoutMs: number;
  socketPath: string;
  spawnProcess?: PiReadinessSpawn;
};

export type HeadlessPiRuntime = {
  piSessionFile: string;
  process: PiReadinessProcess;
  sessionId: string;
  startedAt: Date;
};

export class HeadlessPiSupervisor {
  readonly #command: string;
  readonly #environment: NodeJS.ProcessEnv | undefined;
  readonly #idleTimeoutMs: number;
  readonly #runtimes = new Map<string, HeadlessPiRuntimeState>();
  readonly #socketPath: string;
  readonly #spawnProcess: PiReadinessSpawn;

  constructor(options: HeadlessPiSupervisorOptions) {
    this.#command = options.command ?? "pi";
    this.#environment = options.environment;
    this.#idleTimeoutMs = options.idleTimeoutMs;
    this.#socketPath = options.socketPath;
    this.#spawnProcess = options.spawnProcess ?? defaultSpawn;
  }

  ensureStarted(input: { piSessionFile: string; sessionId: string }): HeadlessPiRuntime {
    const existing = this.#runtimes.get(input.sessionId);
    if (existing) {
      this.#scheduleIdleStop(input.sessionId, existing);
      return toRuntime(input.sessionId, existing);
    }

    const child = this.#spawnProcess(
      this.#command,
      ["--mode", "rpc", "--session", input.piSessionFile],
      {
        env: {
          ...process.env,
          ...(this.#environment ?? {}),
          SHEPHERD_SOCKET_PATH: this.#socketPath,
        },
      },
    );
    const state: HeadlessPiRuntimeState = {
      piSessionFile: input.piSessionFile,
      process: child,
      startedAt: new Date(),
    };
    this.#runtimes.set(input.sessionId, state);
    this.#scheduleIdleStop(input.sessionId, state);

    child.on("exit", () => this.#clearRuntime(input.sessionId, state));
    child.on("error", () => this.#clearRuntime(input.sessionId, state));

    return toRuntime(input.sessionId, state);
  }

  stopSession(sessionId: string): void {
    const runtime = this.#runtimes.get(sessionId);
    if (!runtime) {
      return;
    }

    this.#clearRuntime(sessionId, runtime);
    runtime.process.stdin.end();
    runtime.process.kill("SIGTERM");
  }

  stopAll(): void {
    for (const sessionId of [...this.#runtimes.keys()]) {
      this.stopSession(sessionId);
    }
  }

  #scheduleIdleStop(sessionId: string, state: HeadlessPiRuntimeState): void {
    if (state.idleTimer) {
      clearTimeout(state.idleTimer);
    }

    state.idleTimer = setTimeout(() => {
      this.stopSession(sessionId);
    }, this.#idleTimeoutMs);
  }

  #clearRuntime(sessionId: string, state: HeadlessPiRuntimeState): void {
    if (this.#runtimes.get(sessionId) !== state) {
      return;
    }

    if (state.idleTimer) {
      clearTimeout(state.idleTimer);
    }
    this.#runtimes.delete(sessionId);
  }
}

type HeadlessPiRuntimeState = {
  idleTimer?: ReturnType<typeof setTimeout>;
  piSessionFile: string;
  process: PiReadinessProcess;
  startedAt: Date;
};

function toRuntime(sessionId: string, state: HeadlessPiRuntimeState): HeadlessPiRuntime {
  return {
    piSessionFile: state.piSessionFile,
    process: state.process,
    sessionId,
    startedAt: state.startedAt,
  };
}

function defaultSpawn(
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv },
): PiReadinessProcess {
  return spawn(command, args, {
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
  }) as PiReadinessProcess;
}
