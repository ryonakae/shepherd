import type { AgentStore } from "@/db/agents.js";
import type { HerdrSessionStore } from "@/db/herdr-sessions.js";
import type { HerdrSessionListEntry, HerdrSessionListRunner } from "@/herdr/session-list.js";
import { HerdrSocketClient } from "@/herdr/socket-client.js";
import type { AgentIndexService } from "@/observability/agent-index-service.js";
import type { AgentEventRecord } from "@/observability/contracts.js";

type Watcher = {
  abort: AbortController;
  client: Pick<HerdrSocketClient, "close" | "subscribeEvents">;
  entry: HerdrSessionListEntry;
  loop: Promise<void>;
};

export class HerdrSessionWatchManager {
  readonly #agents: AgentStore;
  readonly #clientFactory: (input: {
    socketPath: string;
  }) => Pick<HerdrSocketClient, "close" | "subscribeEvents">;
  readonly #herdrSessions: HerdrSessionStore;
  readonly #index: AgentIndexService;
  readonly #intervalMs: number;
  readonly #onAgentEvent: (event: AgentEventRecord) => void;
  readonly #reconnectDelayMs: number;
  readonly #sessionList: HerdrSessionListRunner;
  readonly #watchers = new Map<string, Watcher>();
  #interval: NodeJS.Timeout | undefined;

  constructor(options: {
    agents: AgentStore;
    clientFactory?: (input: {
      socketPath: string;
    }) => Pick<HerdrSocketClient, "close" | "subscribeEvents">;
    herdrSessions: HerdrSessionStore;
    index: AgentIndexService;
    intervalMs?: number;
    onAgentEvent(event: AgentEventRecord): void;
    reconnectDelayMs?: number;
    sessionList: HerdrSessionListRunner;
  }) {
    this.#agents = options.agents;
    this.#clientFactory = options.clientFactory ?? ((input) => new HerdrSocketClient(input));
    this.#herdrSessions = options.herdrSessions;
    this.#index = options.index;
    this.#intervalMs = options.intervalMs ?? 60_000;
    this.#onAgentEvent = options.onAgentEvent;
    this.#reconnectDelayMs = options.reconnectDelayMs ?? 1_000;
    this.#sessionList = options.sessionList;
  }

  async start(): Promise<void> {
    await this.rescanNow();
    this.#interval = setInterval(() => {
      void this.rescanNow().catch(() => undefined);
    }, this.#intervalMs);
  }

  async stop(): Promise<void> {
    if (this.#interval) clearInterval(this.#interval);
    this.#interval = undefined;
    for (const watcher of this.#watchers.values()) {
      watcher.abort.abort();
      watcher.client.close();
    }
    await Promise.all(
      [...this.#watchers.values()].map((watcher) => watcher.loop.catch(() => undefined)),
    );
    this.#watchers.clear();
  }

  async rescanNow(): Promise<void> {
    const sessions = await this.#sessionList();
    const running = sessions.filter((session) => session.running);
    this.#herdrSessions.markStoppedMissingFrom(running.map((session) => session.name));
    const runningNames = new Set(running.map((session) => session.name));

    for (const [name, watcher] of this.#watchers) {
      if (!runningNames.has(name)) {
        watcher.abort.abort();
        watcher.client.close();
        this.#watchers.delete(name);
      }
    }

    for (const entry of running) {
      const existing = this.#watchers.get(entry.name);
      if (existing && existing.entry.socketPath === entry.socketPath) continue;
      if (existing) {
        existing.abort.abort();
        existing.client.close();
        this.#watchers.delete(entry.name);
      }
      await this.#startWatcher(entry);
    }
  }

  async #startWatcher(entry: HerdrSessionListEntry): Promise<void> {
    this.#herdrSessions.upsertRunning({
      name: entry.name,
      sessionDir: entry.sessionDir,
      socketPath: entry.socketPath,
    });
    const abort = new AbortController();
    const client = this.#clientFactory({ socketPath: entry.socketPath });
    const loop = this.#watch(entry, client, abort.signal).catch(() => undefined);
    this.#watchers.set(entry.name, { abort, client, entry, loop });
  }

  async #watch(
    entry: HerdrSessionListEntry,
    client: Pick<HerdrSocketClient, "close" | "subscribeEvents">,
    signal: AbortSignal,
  ): Promise<void> {
    while (!signal.aborted) {
      await this.#index.refreshHerdrSession({
        herdrSessionName: entry.name,
        sessionDir: entry.sessionDir,
        socketPath: entry.socketPath,
      });
      const paneIds = this.#agents.listForHerdrSession(entry.name).map((agent) => agent.paneId);
      let restart = false;
      for await (const event of client.subscribeEvents({ paneIds }, { signal })) {
        if (signal.aborted) return;
        const eventRecord = record(event);
        if (eventRecord.type === "pane.agent_status_changed") {
          const agentEvent = await this.#index.handleHerdrEvent({
            event,
            herdrSessionName: entry.name,
            refresh: async () => {
              await this.#index.refreshHerdrSession({
                herdrSessionName: entry.name,
                sessionDir: entry.sessionDir,
                socketPath: entry.socketPath,
              });
            },
          });
          if (agentEvent) this.#onAgentEvent(agentEvent);
          continue;
        }
        if (shouldRestartSubscription(eventRecord.type)) {
          restart = true;
          break;
        }
      }
      if (!restart) {
        await delay(this.#reconnectDelayMs, signal);
      }
    }
  }
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}

function shouldRestartSubscription(type: unknown): boolean {
  return (
    type === "pane.agent_detected" ||
    type === "pane.closed" ||
    type === "pane.created" ||
    type === "pane.moved" ||
    type === "workspace.closed"
  );
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}
