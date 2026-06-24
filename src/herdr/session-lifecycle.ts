import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { herdrSocketPathForNamedSession } from "./session.js";

export type HerdrSessionLifecycleResult = {
  socketPath: string;
  started: boolean;
};

export type HerdrSessionLifecycleOptions = {
  command?: string;
  configDir?: string;
  exists?: (path: string) => boolean;
  pollIntervalMs?: number;
  spawnProcess?: (command: string, args: string[]) => ChildProcess;
  timeoutMs?: number;
};

export class HerdrSessionLifecycle {
  readonly #command: string;
  readonly #configDir: string | undefined;
  readonly #exists: (path: string) => boolean;
  readonly #pollIntervalMs: number;
  readonly #spawnProcess: (command: string, args: string[]) => ChildProcess;
  readonly #timeoutMs: number;

  constructor(options: HerdrSessionLifecycleOptions = {}) {
    this.#command = options.command ?? "herdr";
    this.#configDir = options.configDir;
    this.#exists = options.exists ?? existsSync;
    this.#pollIntervalMs = options.pollIntervalMs ?? 100;
    this.#spawnProcess =
      options.spawnProcess ??
      ((command, args) => {
        const child = spawn(command, args, {
          detached: true,
          stdio: "ignore",
        });
        child.unref();
        return child;
      });
    this.#timeoutMs = options.timeoutMs ?? 5_000;
  }

  async ensureNamedSession(name: string): Promise<HerdrSessionLifecycleResult> {
    const socketPath = herdrSocketPathForNamedSession(name, this.#configDir);
    if (this.#exists(socketPath)) {
      return { socketPath, started: false };
    }

    let startFailure: Error | undefined;
    try {
      const child = this.#spawnProcess(this.#command, ["--session", name]);
      if (typeof child.once === "function") {
        child.once("error", (error) => {
          startFailure = error;
        });
        child.once("exit", (code, signal) => {
          if (!this.#exists(socketPath)) {
            startFailure = new Error(
              `Herdr exited before creating the session socket (code ${code ?? "null"}, signal ${
                signal ?? "null"
              })`,
            );
          }
        });
      }
    } catch (error) {
      throw this.#startError(name, socketPath, error);
    }
    await this.#waitForSocket(name, socketPath, () => startFailure);

    return { socketPath, started: true };
  }

  async #waitForSocket(
    name: string,
    socketPath: string,
    startFailure: () => Error | undefined,
  ): Promise<void> {
    const startedAt = Date.now();
    while (!this.#exists(socketPath)) {
      const failure = startFailure();
      if (failure) {
        throw this.#startError(name, socketPath, failure);
      }

      if (Date.now() - startedAt > this.#timeoutMs) {
        throw this.#startError(
          name,
          socketPath,
          new Error(`Timed out after ${this.#timeoutMs}ms waiting for the session socket`),
        );
      }

      await new Promise((resolve) => setTimeout(resolve, this.#pollIntervalMs));
    }
  }

  #startError(name: string, socketPath: string, cause: unknown): Error {
    const message = cause instanceof Error ? cause.message : String(cause);
    return new Error(
      `Failed to start Herdr named session "${name}" with "${this.#command} --session ${name}" for socket ${socketPath}: ${message}`,
    );
  }
}
