import { EventEmitter } from "node:events";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { PiReadinessProcess, PiReadinessSpawn } from "@/gateway/pi-readiness.js";
import { HeadlessPiSupervisor } from "@/gateway/pi-supervisor.js";

type SpawnRecord = {
  args: string[];
  command: string;
  sessionId?: string;
  socketPath?: string;
};

afterEach(() => {
  vi.useRealTimers();
});

describe("HeadlessPiSupervisor", () => {
  test("starts one Pi RPC process per Shepherd session", () => {
    const spawned: SpawnRecord[] = [];
    const supervisor = new HeadlessPiSupervisor({
      idleTimeoutMs: 60_000,
      socketPath: "/tmp/shepherd.sock",
      spawnProcess: fakeSpawn(spawned),
    });

    const runtime = supervisor.ensureStarted({
      piSessionFile: "/tmp/pi-session.jsonl",
      sessionId: "session-1",
    });

    expect(runtime).toMatchObject({
      piSessionFile: "/tmp/pi-session.jsonl",
      sessionId: "session-1",
    });
    expect(spawned).toEqual([
      {
        args: ["--mode", "rpc", "--session", "/tmp/pi-session.jsonl"],
        command: "pi",
        sessionId: "session-1",
        socketPath: "/tmp/shepherd.sock",
      },
    ]);
  });

  test("reuses a running process for the same session", () => {
    const spawned: SpawnRecord[] = [];
    const supervisor = new HeadlessPiSupervisor({
      idleTimeoutMs: 60_000,
      socketPath: "/tmp/shepherd.sock",
      spawnProcess: fakeSpawn(spawned),
    });

    const first = supervisor.ensureStarted({
      piSessionFile: "/tmp/pi-session.jsonl",
      sessionId: "session-1",
    });
    const second = supervisor.ensureStarted({
      piSessionFile: "/tmp/pi-session.jsonl",
      sessionId: "session-1",
    });

    expect(second.process).toBe(first.process);
    expect(spawned).toHaveLength(1);
  });

  test("stops idle processes after the configured timeout", () => {
    vi.useFakeTimers();
    const processes: FakePiProcess[] = [];
    const supervisor = new HeadlessPiSupervisor({
      idleTimeoutMs: 1_000,
      socketPath: "/tmp/shepherd.sock",
      spawnProcess: (command, args, options) => {
        const process = new FakePiProcess();
        process.spawned = toSpawnRecord(command, args, options.env);
        processes.push(process);
        return process;
      },
    });

    supervisor.ensureStarted({
      piSessionFile: "/tmp/pi-session.jsonl",
      sessionId: "session-1",
    });
    vi.advanceTimersByTime(999);
    expect(processes[0]?.killed).toBe(false);

    vi.advanceTimersByTime(1);

    expect(processes[0]?.ended).toBe(true);
    expect(processes[0]?.killed).toBe(true);
  });
});

function fakeSpawn(spawned: SpawnRecord[]): PiReadinessSpawn {
  return (command, args, options) => {
    spawned.push(toSpawnRecord(command, args, options.env));
    return new FakePiProcess();
  };
}

function toSpawnRecord(command: string, args: string[], env: NodeJS.ProcessEnv): SpawnRecord {
  return {
    args,
    command,
    ...(env.SHEPHERD_SESSION_ID !== undefined ? { sessionId: env.SHEPHERD_SESSION_ID } : {}),
    ...(env.SHEPHERD_SOCKET_PATH !== undefined ? { socketPath: env.SHEPHERD_SOCKET_PATH } : {}),
  };
}

class FakePiProcess implements PiReadinessProcess {
  readonly stderr = new EventEmitter();
  readonly stdout = new EventEmitter();
  ended = false;
  killed = false;
  spawned: SpawnRecord | undefined;

  readonly #events = new EventEmitter();

  readonly stdin = {
    end: () => {
      this.ended = true;
    },
    write: () => true,
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
