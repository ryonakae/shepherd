import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { applyMigrations } from "@/db/apply-migrations.js";
import { openSqlite } from "@/db/client.js";
import { EventStore } from "@/db/event-store.js";
import type { GatewayTurnInput } from "@/gateway/runner.js";
import { GatewayRunStore, GatewayTurnQueue } from "@/gateway/turn-queue.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("GatewayTurnQueue", () => {
  test("serializes gateway turns for the same session and records run states", async () => {
    const { queue, runStore, runner } = openHarness();
    const first = queue.runTurn({
      messages: [{ content: "first", role: "user" }],
      sessionId: "session-1",
    });
    const second = queue.runTurn({
      messages: [{ content: "second", role: "user" }],
      sessionId: "session-1",
    });

    await runner.waitForStarted("first");
    expect(runner.started).toEqual(["first"]);
    expect(runStore.listRuns("session-1").map((run) => run.status)).toEqual(["running", "queued"]);

    runner.resolve("first", "first done");
    await expect(first).resolves.toEqual({ text: "first done" });
    await runner.waitForStarted("second");
    expect(runner.started).toEqual(["first", "second"]);

    runner.resolve("second", "second done");
    await expect(second).resolves.toEqual({ text: "second done" });
    expect(runStore.listRuns("session-1").map((run) => run.status)).toEqual([
      "completed",
      "completed",
    ]);
  });

  test("allows different sessions to run concurrently", async () => {
    const { queue, runner } = openHarness();
    const first = queue.runTurn({
      messages: [{ content: "first", role: "user" }],
      sessionId: "session-1",
    });
    const other = queue.runTurn({
      messages: [{ content: "other", role: "user" }],
      sessionId: "session-2",
    });

    await runner.waitForStarted("first");
    await runner.waitForStarted("other");
    expect(runner.started).toEqual(["first", "other"]);

    runner.resolve("first", "first done");
    runner.resolve("other", "other done");
    await expect(first).resolves.toEqual({ text: "first done" });
    await expect(other).resolves.toEqual({ text: "other done" });
  });

  test("claims one queued external run per session", () => {
    const { events, runStore } = openHarness();
    const firstEvent = events.appendEvent({
      payload: { text: "first" },
      sessionId: "session-1",
      type: "user.message",
    });
    const secondEvent = events.appendEvent({
      payload: { text: "second" },
      sessionId: "session-1",
      type: "user.message",
    });
    const first = runStore.createQueuedRun({
      sessionId: "session-1",
      triggeringEventId: firstEvent.id,
    });
    const second = runStore.createQueuedRun({
      sessionId: "session-1",
      triggeringEventId: secondEvent.id,
    });

    expect(runStore.claimNextQueuedRun("session-1")).toMatchObject({
      id: first.id,
      status: "running",
    });
    expect(runStore.claimNextQueuedRun("session-1")).toBeUndefined();
    runStore.markCompleted(first.id);
    expect(runStore.claimNextQueuedRun("session-1")).toMatchObject({
      id: second.id,
      status: "running",
    });
  });

  test("marks failed runs and continues queued work", async () => {
    const { queue, runStore, runner } = openHarness();
    const first = queue.runTurn({
      messages: [{ content: "first", role: "user" }],
      sessionId: "session-1",
    });
    const second = queue.runTurn({
      messages: [{ content: "second", role: "user" }],
      sessionId: "session-1",
    });

    await runner.waitForStarted("first");
    runner.reject("first", new Error("provider failed"));
    await expect(first).rejects.toThrow("provider failed");
    await runner.waitForStarted("second");
    runner.resolve("second", "recovered");

    await expect(second).resolves.toEqual({ text: "recovered" });
    expect(runStore.listRuns("session-1").map((run) => run.status)).toEqual([
      "failed",
      "completed",
    ]);
  });
});

function openHarness(): {
  events: EventStore;
  queue: GatewayTurnQueue;
  runStore: GatewayRunStore;
  runner: ControllableRunner;
} {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-gateway-queue-"));
  tempDirs.push(dir);

  const { sqlite } = openSqlite(join(dir, "test.sqlite"));
  applyMigrations(sqlite, { migrationsFolder: "drizzle" });
  const events = new EventStore(sqlite);
  events.createSession({ id: "session-1" });
  events.createSession({ id: "session-2" });
  const runStore = new GatewayRunStore(sqlite);
  const runner = new ControllableRunner();

  return {
    events,
    queue: new GatewayTurnQueue({ runStore, runner }),
    runStore,
    runner,
  };
}

class ControllableRunner {
  readonly started: string[] = [];
  readonly #pending = new Map<
    string,
    {
      reject: (error: Error) => void;
      resolve: (value: { text: string }) => void;
    }
  >();
  readonly #waiters = new Map<string, Array<() => void>>();

  runTurn(input: GatewayTurnInput): Promise<{ text: string }> {
    const label = input.messages[0]?.content ?? "";
    this.started.push(label);
    for (const waiter of this.#waiters.get(label) ?? []) {
      waiter();
    }
    this.#waiters.delete(label);

    return new Promise((resolve, reject) => {
      this.#pending.set(label, { reject, resolve });
    });
  }

  resolve(label: string, text: string): void {
    this.#pending.get(label)?.resolve({ text });
    this.#pending.delete(label);
  }

  reject(label: string, error: Error): void {
    this.#pending.get(label)?.reject(error);
    this.#pending.delete(label);
  }

  waitForStarted(label: string): Promise<void> {
    if (this.started.includes(label)) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const waiters = this.#waiters.get(label) ?? [];
      waiters.push(resolve);
      this.#waiters.set(label, waiters);
    });
  }
}
