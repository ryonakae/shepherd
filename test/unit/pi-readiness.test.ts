import { EventEmitter } from "node:events";
import { describe, expect, test } from "vitest";
import { encodeJsonLine } from "@/gateway/json-lines.js";
import {
  checkPiReadiness,
  type PiReadinessProcess,
  type PiReadinessSpawn,
} from "@/gateway/pi-readiness.js";
import type { PiHandshakeRecord } from "@/gateway/server.js";

describe("checkPiReadiness", () => {
  test("waits for extension handshake and available models", async () => {
    const process = new FakePiProcess({ modelCount: 2 });
    const result = await checkPiReadiness({
      socketPath: "/tmp/shepherd.sock",
      spawnProcess: fakeSpawn(process),
      timeoutMs: 100,
      waitForHandshake: async () => handshake(),
    });

    expect(result).toMatchObject({ modelCount: 2 });
    expect(process.spawned).toEqual({
      args: ["--mode", "rpc", "--no-session"],
      command: "pi",
      socketPath: "/tmp/shepherd.sock",
    });
    expect(process.killed).toBe(true);
  });

  test("fails when Pi reports no authenticated models", async () => {
    await expect(
      checkPiReadiness({
        socketPath: "/tmp/shepherd.sock",
        spawnProcess: fakeSpawn(new FakePiProcess({ modelCount: 0 })),
        timeoutMs: 100,
        waitForHandshake: async () => handshake(),
      }),
    ).rejects.toThrow("Pi has no available authenticated model");
  });

  test("fails with setup guidance when the extension does not handshake", async () => {
    await expect(
      checkPiReadiness({
        socketPath: "/tmp/shepherd.sock",
        spawnProcess: fakeSpawn(new FakePiProcess({ modelCount: 1 })),
        timeoutMs: 100,
        waitForHandshake: async () => {
          throw new Error("Timed out waiting for pi.handshake after 100ms");
        },
      }),
    ).rejects.toThrow("pi install npm:shepherd-pi");
  });
});

function fakeSpawn(process: FakePiProcess): PiReadinessSpawn {
  return (command, args, options) => {
    process.spawned = {
      args,
      command,
      ...(options.env.SHEPHERD_GATEWAY_SOCKET_PATH !== undefined
        ? { socketPath: options.env.SHEPHERD_GATEWAY_SOCKET_PATH }
        : {}),
    };
    return process;
  };
}

function handshake(): PiHandshakeRecord {
  return {
    attached: false,
    gatewayId: "default",
    extensionVersion: "0.1.0",
    mode: "rpc",
    ownerId: "owner-1",
    ownerKind: "headless_pi",
  };
}

class FakePiProcess implements PiReadinessProcess {
  readonly stderr = new EventEmitter();
  readonly stdout = new EventEmitter();
  killed = false;
  spawned: { args: string[]; command: string; socketPath?: string } | undefined;

  readonly #events = new EventEmitter();
  readonly #modelCount: number;

  constructor(options: { modelCount: number }) {
    this.#modelCount = options.modelCount;
  }

  readonly stdin = {
    end: () => {},
    write: (chunk: string) => {
      const text = chunk.toString();
      if (text.includes("get_available_models")) {
        queueMicrotask(() => {
          this.stdout.emit(
            "data",
            encodeJsonLine({
              command: "get_available_models",
              data: {
                models: Array.from({ length: this.#modelCount }, (_, index) => ({ id: index })),
              },
              id: "shepherd-readiness-models",
              success: true,
              type: "response",
            }),
          );
        });
      }
      return true;
    },
  };

  kill(): boolean {
    this.killed = true;
    return true;
  }

  on(
    event: "error" | "exit",
    listener:
      | ((error: Error) => void)
      | ((code: number | null, signal: NodeJS.Signals | null) => void),
  ): PiReadinessProcess {
    this.#events.on(event, listener);
    return this;
  }
}
