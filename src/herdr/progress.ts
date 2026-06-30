import type { EventRecord, EventStore } from "@/db/event-store.js";

export type HerdrEventSource = {
  subscribeEvents(
    params?: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): AsyncIterable<unknown>;
  waitForEvent?(params?: Record<string, unknown>): Promise<unknown>;
};

export type HerdrProgressAdapterOptions = {
  events: Pick<EventStore, "appendEvent">;
  herdrSessionName: string;
  sessionId: string;
  source: HerdrEventSource;
  waitTimeoutMs?: number;
  workspaceId?: string;
};

export type HerdrProgressSignal = {
  eventId?: string;
  eventType?: string;
  herdrSessionName: string;
  rawEvent: unknown;
  text: string;
  workspaceId?: string;
  tabId?: string;
  paneId?: string;
  agent?: string;
  status?: string;
};

export class HerdrProgressAdapter {
  readonly #events: Pick<EventStore, "appendEvent">;
  readonly #herdrSessionName: string;
  readonly #sessionId: string;
  readonly #source: HerdrEventSource;
  readonly #waitTimeoutMs: number | undefined;
  readonly #workspaceId: string | undefined;

  constructor(options: HerdrProgressAdapterOptions) {
    this.#events = options.events;
    this.#herdrSessionName = options.herdrSessionName;
    this.#sessionId = options.sessionId;
    this.#source = options.source;
    this.#waitTimeoutMs = options.waitTimeoutMs;
    this.#workspaceId = options.workspaceId;
  }

  async pollOnce(params: Record<string, unknown> = {}): Promise<EventRecord> {
    if (!this.#source.waitForEvent) {
      throw new Error("Herdr event source does not support waitForEvent");
    }
    const rawEvent = await this.#source.waitForEvent({
      ...params,
      ...(this.#waitTimeoutMs !== undefined ? { timeout_ms: this.#waitTimeoutMs } : {}),
      ...(this.#workspaceId !== undefined ? { workspace_id: this.#workspaceId } : {}),
    });
    const payload = toHerdrProgressSignal(rawEvent, {
      herdrSessionName: this.#herdrSessionName,
      ...(this.#workspaceId !== undefined ? { workspaceId: this.#workspaceId } : {}),
    });
    const idempotencyKey = payload.eventId
      ? `herdr:${this.#herdrSessionName}:event:${payload.eventId}`
      : undefined;

    return this.#events.appendEvent({
      payload,
      sessionId: this.#sessionId,
      type: "herdr.progress",
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    });
  }

  async pump(options: { maxEvents?: number; signal?: AbortSignal } = {}): Promise<EventRecord[]> {
    const events: EventRecord[] = [];

    while (!options.signal?.aborted) {
      if (options.maxEvents !== undefined && events.length >= options.maxEvents) {
        break;
      }

      events.push(await this.pollOnce());
    }

    return events;
  }
}

export function toHerdrProgressSignal(
  rawEvent: unknown,
  options: { herdrSessionName: string; workspaceId?: string },
): HerdrProgressSignal {
  const event = asRecord(rawEvent);
  const data = asRecord(event?.data);
  const eventId = stringField(event, "id", "event_id") ?? stringField(data, "id", "event_id");
  const eventType =
    stringField(event, "type", "event", "kind", "name") ??
    stringField(data, "type", "event", "kind", "name");
  const workspaceId =
    stringField(event, "workspace_id", "workspaceId") ??
    stringField(data, "workspace_id", "workspaceId") ??
    options.workspaceId;
  const tabId = stringField(event, "tab_id", "tabId") ?? stringField(data, "tab_id", "tabId");
  const paneId = stringField(event, "pane_id", "paneId") ?? stringField(data, "pane_id", "paneId");
  const agent =
    stringField(event, "agent", "agent_id", "agentId", "target") ??
    stringField(data, "agent", "agent_id", "agentId", "target");
  const status = stringField(event, "status", "state") ?? stringField(data, "status", "state");

  const signal = {
    herdrSessionName: options.herdrSessionName,
    rawEvent,
    text: formatProgressText({
      ...(agent !== undefined ? { agent } : {}),
      ...(eventType !== undefined ? { eventType } : {}),
      ...(paneId !== undefined ? { paneId } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(workspaceId !== undefined ? { workspaceId } : {}),
    }),
    ...(eventId !== undefined ? { eventId } : {}),
    ...(eventType !== undefined ? { eventType } : {}),
    ...(workspaceId !== undefined ? { workspaceId } : {}),
    ...(tabId !== undefined ? { tabId } : {}),
    ...(paneId !== undefined ? { paneId } : {}),
    ...(agent !== undefined ? { agent } : {}),
    ...(status !== undefined ? { status } : {}),
  };

  return signal;
}

function formatProgressText(input: {
  agent?: string;
  eventType?: string;
  paneId?: string;
  status?: string;
  workspaceId?: string;
}): string {
  const parts = ["Herdr progress"];
  if (input.eventType) {
    parts.push(input.eventType);
  }
  if (input.status) {
    parts.push(`status=${input.status}`);
  }
  if (input.agent) {
    parts.push(`agent=${input.agent}`);
  } else if (input.paneId) {
    parts.push(`pane=${input.paneId}`);
  } else if (input.workspaceId) {
    parts.push(`workspace=${input.workspaceId}`);
  }

  return parts.join(" ");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(
  record: Record<string, unknown> | undefined,
  ...keys: string[]
): string | undefined {
  if (!record) {
    return undefined;
  }

  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }

  return undefined;
}
