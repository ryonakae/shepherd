import { spawn } from "node:child_process";
import { encodeJsonLine, JsonLineDecoder } from "@/daemon/json-lines.js";
import type { PiHandshakeRecord } from "@/daemon/server.js";

export type PiReadinessResult = {
  handshake: PiHandshakeRecord;
  modelCount: number;
};

export type PiReadinessProcess = {
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "error", listener: (error: Error) => void): PiReadinessProcess;
  on(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): PiReadinessProcess;
  stderr: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown };
  stdin: { end(): unknown; write(chunk: string): unknown };
  stdout: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown };
};

export type PiReadinessSpawn = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv },
) => PiReadinessProcess;

export type PiReadinessOptions = {
  command?: string;
  environment?: NodeJS.ProcessEnv;
  socketPath: string;
  spawnProcess?: PiReadinessSpawn;
  timeoutMs: number;
  waitForHandshake(timeoutMs: number): Promise<PiHandshakeRecord>;
};

export async function checkPiReadiness(options: PiReadinessOptions): Promise<PiReadinessResult> {
  const command = options.command ?? "pi";
  const child = (options.spawnProcess ?? defaultSpawn)(command, ["--mode", "rpc", "--no-session"], {
    env: {
      ...process.env,
      ...(options.environment ?? {}),
      SHEPHERD_SOCKET_PATH: options.socketPath,
    },
  });

  try {
    const models = waitForAvailableModels(child, options.timeoutMs);
    child.stdin.write(
      encodeJsonLine({
        id: "shepherd-readiness-models",
        type: "get_available_models",
      }),
    );

    const [handshake, modelCount] = await Promise.all([
      options.waitForHandshake(options.timeoutMs).catch((error: unknown) => {
        throw new Error(
          `${missingExtensionMessage()}\n\n${error instanceof Error ? error.message : String(error)}`,
        );
      }),
      models,
    ]);

    if (modelCount < 1) {
      throw new Error(noModelsMessage());
    }

    return { handshake, modelCount };
  } finally {
    child.stdin.end();
    child.kill("SIGTERM");
  }
}

function waitForAvailableModels(child: PiReadinessProcess, timeoutMs: number): Promise<number> {
  const decoder = new JsonLineDecoder();
  let stderr = "";

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for Pi get_available_models after ${timeoutMs}ms`));
    }, timeoutMs);

    const finish = (result: { error?: Error; modelCount?: number }) => {
      clearTimeout(timeout);
      if (result.error) {
        reject(result.error);
        return;
      }
      resolve(result.modelCount ?? 0);
    };

    child.stdout.on("data", (chunk: Buffer | string) => {
      try {
        for (const message of decoder.push(chunk.toString())) {
          const modelCount = parseGetAvailableModelsResponse(message);
          if (modelCount !== undefined) {
            finish({ modelCount });
          }
        }
      } catch (error) {
        finish({ error: error instanceof Error ? error : new Error(String(error)) });
      }
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      if (error.message.includes("ENOENT")) {
        finish({ error: new Error(missingPiMessage()) });
        return;
      }
      finish({ error });
    });
    child.on("exit", (code, signal) => {
      finish({
        error: new Error(
          `Pi readiness process exited before responding: code=${String(code)} signal=${String(signal)}${
            stderr.trim() ? ` stderr=${stderr.trim()}` : ""
          }`,
        ),
      });
    });
  });
}

function parseGetAvailableModelsResponse(message: unknown): number | undefined {
  if (typeof message !== "object" || message === null) {
    return undefined;
  }

  const record = message as Record<string, unknown>;
  if (record.type !== "response" || record.command !== "get_available_models") {
    return undefined;
  }

  if (record.success !== true) {
    const error = record.error as { message?: unknown } | undefined;
    throw new Error(
      typeof error?.message === "string" ? error.message : "Pi get_available_models failed",
    );
  }

  const data = record.data as { models?: unknown } | undefined;
  return Array.isArray(data?.models) ? data.models.length : 0;
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

function missingPiMessage(): string {
  return `Pi command was not found on PATH.\n\nInstall Pi, then restart:\n  npm install -g --ignore-scripts @earendil-works/pi-coding-agent`;
}

function missingExtensionMessage(): string {
  return `Shepherd Pi extension is not installed or did not handshake.\n\nInstall it with:\n  pi install npm:shepherd-pi\n\nThen restart:\n  shepherd daemon`;
}

function noModelsMessage(): string {
  return `Pi has no available authenticated model.\n\nRun:\n  pi\n  /login`;
}
