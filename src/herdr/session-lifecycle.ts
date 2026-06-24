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

    this.#spawnProcess(this.#command, ["--session", name]);
    await this.#waitForSocket(socketPath);

    return { socketPath, started: true };
  }

  async #waitForSocket(socketPath: string): Promise<void> {
    const startedAt = Date.now();
    while (!this.#exists(socketPath)) {
      if (Date.now() - startedAt > this.#timeoutMs) {
        throw new Error(`Timed out waiting for Herdr session socket: ${socketPath}`);
      }

      await new Promise((resolve) => setTimeout(resolve, this.#pollIntervalMs));
    }
  }
}
