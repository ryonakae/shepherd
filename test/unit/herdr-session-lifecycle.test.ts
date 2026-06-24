import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, test } from "vitest";
import { HerdrSessionLifecycle } from "@/herdr/session-lifecycle.js";

describe("HerdrSessionLifecycle", () => {
  test("does not spawn Herdr when the named session socket already exists", async () => {
    const spawned: unknown[] = [];
    const lifecycle = new HerdrSessionLifecycle({
      configDir: "/config/herdr",
      exists: () => true,
      spawnProcess(command, args) {
        spawned.push({ args, command });
        return {} as ChildProcess;
      },
    });

    await expect(lifecycle.ensureNamedSession("shepherd-api")).resolves.toEqual({
      socketPath: "/config/herdr/sessions/shepherd-api/herdr.sock",
      started: false,
    });
    expect(spawned).toEqual([]);
  });

  test("starts Herdr through the named-session CLI lifecycle and waits for the socket", async () => {
    let exists = false;
    const spawned: unknown[] = [];
    const lifecycle = new HerdrSessionLifecycle({
      configDir: "/config/herdr",
      exists: () => exists,
      pollIntervalMs: 1,
      spawnProcess(command, args) {
        spawned.push({ args, command });
        exists = true;
        return {} as ChildProcess;
      },
      timeoutMs: 100,
    });

    await expect(lifecycle.ensureNamedSession("shepherd-api")).resolves.toEqual({
      socketPath: "/config/herdr/sessions/shepherd-api/herdr.sock",
      started: true,
    });
    expect(spawned).toEqual([{ args: ["--session", "shepherd-api"], command: "herdr" }]);
  });

  test("wraps Herdr spawn failures with session and socket context", async () => {
    const lifecycle = new HerdrSessionLifecycle({
      configDir: "/config/herdr",
      exists: () => false,
      spawnProcess() {
        throw new Error("ENOENT");
      },
    });

    await expect(lifecycle.ensureNamedSession("shepherd-api")).rejects.toThrow(
      'Failed to start Herdr named session "shepherd-api" with "herdr --session shepherd-api" for socket /config/herdr/sessions/shepherd-api/herdr.sock: ENOENT',
    );
  });

  test("reports Herdr exits before the socket appears", async () => {
    const child = new EventEmitter() as ChildProcess;
    const lifecycle = new HerdrSessionLifecycle({
      configDir: "/config/herdr",
      exists: () => false,
      pollIntervalMs: 1,
      spawnProcess() {
        queueMicrotask(() => child.emit("exit", 127, null));
        return child;
      },
      timeoutMs: 100,
    });

    await expect(lifecycle.ensureNamedSession("shepherd-api")).rejects.toThrow(
      "Herdr exited before creating the session socket",
    );
  });
});
