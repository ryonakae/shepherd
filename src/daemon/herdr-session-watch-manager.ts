import type { AgentStore } from "@/db/agents.js";
import type { HerdrSessionStore } from "@/db/herdr-sessions.js";
import type { HerdrSessionListEntry, HerdrSessionListRunner } from "@/herdr/session-list.js";
import { HerdrSocketClient } from "@/herdr/socket-client.js";
import type {
  AgentIndexRefreshResult,
  AgentIndexService,
} from "@/observability/agent-index-service.js";
import type { AgentEventRecord, AgentIndexRecord, AgentScope } from "@/observability/contracts.js";

export const ACTIVE_REVISION_POLL_MS = 10_000;
export const FULL_RESCAN_MS = 60_000;

type Watcher = {
  abort: AbortController;
  client: Pick<HerdrSocketClient, "close" | "subscribeEvents">;
  entry: HerdrSessionListEntry;
  loop: Promise<void>;
};

export class HerdrSessionWatchManager {
  readonly #agents: AgentStore;
  readonly #activeRevisionPollMs: number;
  readonly #clientFactory: (input: {
    socketPath: string;
  }) => Pick<HerdrSocketClient, "close" | "subscribeEvents">;
  readonly #fullRescanMs: number;
  readonly #herdrSessions: HerdrSessionStore;
  readonly #index: AgentIndexService;
  readonly #onAgentContextChanged: (scope: AgentScope) => void;
  readonly #onAgentEvent: (event: AgentEventRecord) => void;
  readonly #onAgentIndexRefreshed: (input: {
    agents: AgentIndexRecord[];
    herdrSessionName: string;
  }) => void;
  readonly #reconnectDelayMs: number;
  readonly #refreshPublications = new WeakMap<
    Promise<AgentIndexRefreshResult>,
    Promise<AgentIndexRecord[]>
  >();
  readonly #retiringWatcherLoops = new Set<Promise<void>>();
  readonly #sessionList: HerdrSessionListRunner;
  readonly #watchers = new Map<string, Watcher>();
  #lastFullRescanAt = 0;
  #lifecycleGeneration = 0;
  #scheduler: NodeJS.Timeout | undefined;
  #stopping = false;
  #tickInFlight: Promise<void> | undefined;

  constructor(options: {
    activeRevisionPollMs?: number;
    agents: AgentStore;
    clientFactory?: (input: {
      socketPath: string;
    }) => Pick<HerdrSocketClient, "close" | "subscribeEvents">;
    fullRescanMs?: number;
    herdrSessions: HerdrSessionStore;
    index: AgentIndexService;
    onAgentContextChanged?(scope: AgentScope): void;
    onAgentEvent(event: AgentEventRecord): void;
    onAgentIndexRefreshed?(input: { agents: AgentIndexRecord[]; herdrSessionName: string }): void;
    reconnectDelayMs?: number;
    sessionList: HerdrSessionListRunner;
  }) {
    this.#activeRevisionPollMs = options.activeRevisionPollMs ?? ACTIVE_REVISION_POLL_MS;
    this.#agents = options.agents;
    this.#clientFactory = options.clientFactory ?? ((input) => new HerdrSocketClient(input));
    this.#fullRescanMs = options.fullRescanMs ?? FULL_RESCAN_MS;
    this.#herdrSessions = options.herdrSessions;
    this.#index = options.index;
    this.#onAgentContextChanged = options.onAgentContextChanged ?? (() => undefined);
    this.#onAgentEvent = options.onAgentEvent;
    this.#onAgentIndexRefreshed = options.onAgentIndexRefreshed ?? (() => undefined);
    this.#reconnectDelayMs = options.reconnectDelayMs ?? 1_000;
    this.#sessionList = options.sessionList;
  }

  async start(): Promise<void> {
    this.#stopping = false;
    this.#lifecycleGeneration += 1;
    const generation = this.#lifecycleGeneration;
    await this.rescanNow();
    if (this.#stopping || generation !== this.#lifecycleGeneration) return;
    this.#scheduler = setInterval(() => {
      if (!this.#tickInFlight) {
        this.#tickInFlight = this.#tick().finally(() => {
          this.#tickInFlight = undefined;
        });
      }
    }, this.#activeRevisionPollMs);
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    this.#lifecycleGeneration += 1;
    if (this.#scheduler) clearInterval(this.#scheduler);
    this.#scheduler = undefined;
    await this.#abortWatchers();
    await this.#tickInFlight?.catch(() => undefined);
    await Promise.all([...this.#retiringWatcherLoops]);
    await this.#abortWatchers();
  }

  async rescanNow(): Promise<void> {
    const generation = this.#lifecycleGeneration;
    const sessions = await this.#sessionList();
    if (this.#stopping || generation !== this.#lifecycleGeneration) return;
    const running = sessions.filter((session) => session.running);
    const runningNames = new Set(running.map((session) => session.name));
    const removed: Promise<void>[] = [];

    for (const [name, watcher] of this.#watchers) {
      if (!runningNames.has(name)) removed.push(this.#retireWatcher(name, watcher));
    }
    await Promise.all(removed);
    if (this.#stopping || generation !== this.#lifecycleGeneration) return;
    this.#herdrSessions.markStoppedMissingFrom([...runningNames]);

    for (const entry of running) {
      if (this.#stopping || generation !== this.#lifecycleGeneration) return;
      const existing = this.#watchers.get(entry.name);
      if (existing) await this.#retireWatcher(entry.name, existing);
      await this.#startWatcher(entry, generation);
    }
    if (!this.#stopping && generation === this.#lifecycleGeneration) {
      this.#lastFullRescanAt = Date.now();
    }
  }

  async #tick(): Promise<void> {
    if (Date.now() - this.#lastFullRescanAt >= this.#fullRescanMs) {
      await this.rescanNow();
      return;
    }
    const workingSessions = [...this.#watchers.values()].filter(({ entry }) =>
      this.#agents.listForHerdrSession(entry.name).some((agent) => agent.agentStatus === "working"),
    );
    await Promise.all(workingSessions.map(({ entry }) => this.#refresh(entry)));
  }

  async #startWatcher(entry: HerdrSessionListEntry, generation: number): Promise<void> {
    if (this.#stopping || generation !== this.#lifecycleGeneration) return;
    this.#herdrSessions.upsertRunning({
      name: entry.name,
      sessionDir: entry.sessionDir,
      socketPath: entry.socketPath,
    });
    const abort = new AbortController();
    const client = this.#clientFactory({ socketPath: entry.socketPath });
    const loop = this.#watch(entry, client, abort.signal).catch(() => undefined);
    this.#watchers.set(entry.name, { abort, client, entry, loop });
    if (this.#stopping || generation !== this.#lifecycleGeneration) {
      abort.abort();
      client.close();
      this.#watchers.delete(entry.name);
      await loop;
    }
  }

  #retireWatcher(name: string, watcher: Watcher): Promise<void> {
    if (this.#watchers.get(name) === watcher) this.#watchers.delete(name);
    watcher.abort.abort();
    watcher.client.close();
    this.#retiringWatcherLoops.add(watcher.loop);
    const clear = () => this.#retiringWatcherLoops.delete(watcher.loop);
    void watcher.loop.then(clear, clear);
    return watcher.loop;
  }

  async #abortWatchers(): Promise<void> {
    const retiring = [...this.#watchers].map(([name, watcher]) =>
      this.#retireWatcher(name, watcher),
    );
    await Promise.all([...retiring, ...this.#retiringWatcherLoops]);
  }

  async #watch(
    entry: HerdrSessionListEntry,
    client: Pick<HerdrSocketClient, "close" | "subscribeEvents">,
    signal: AbortSignal,
  ): Promise<void> {
    while (!signal.aborted) {
      let restart = false;
      try {
        const agents = await this.#refresh(entry);
        if (signal.aborted) return;
        const paneIds = agents.map((agent) => agent.paneId);
        for await (const event of client.subscribeEvents({ paneIds }, { signal })) {
          if (signal.aborted) return;
          const eventRecord = record(event);
          if (eventRecord.type === "pane.agent_status_changed") {
            const result = await this.#index.handleHerdrEvent({
              event,
              herdrSessionName: entry.name,
              sessionDir: entry.sessionDir,
              socketPath: entry.socketPath,
            });
            this.#publishResult({
              agents: this.#agents.listForHerdrSession(entry.name),
              herdrSessionName: entry.name,
              ...result,
            });
            continue;
          }
          if (shouldRestartSubscription(eventRecord.type)) {
            restart = true;
            break;
          }
        }
      } catch {
        if (signal.aborted) return;
      }
      if (!restart) await delay(this.#reconnectDelayMs, signal);
    }
  }

  #refresh(entry: HerdrSessionListEntry): Promise<AgentIndexRecord[]> {
    const source = this.#index.refreshHerdrSession({
      herdrSessionName: entry.name,
      sessionDir: entry.sessionDir,
      socketPath: entry.socketPath,
    });
    const existing = this.#refreshPublications.get(source);
    if (existing) return existing;
    const publication = source.then((result) => {
      this.#publishResult({ herdrSessionName: entry.name, ...result });
      return result.agents;
    });
    this.#refreshPublications.set(source, publication);
    return publication;
  }

  #publishResult(input: {
    agents: AgentIndexRecord[];
    contextChangedScopes: AgentScope[];
    events: AgentEventRecord[];
    herdrSessionName: string;
  }): void {
    this.#onAgentIndexRefreshed({ agents: input.agents, herdrSessionName: input.herdrSessionName });
    for (const scope of input.contextChangedScopes) this.#onAgentContextChanged(scope);
    for (const event of input.events) this.#onAgentEvent(event);
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
