import type { EventRecord } from "@/db/event-store.js";
import type { PlatformDeliveryAdapter } from "@/delivery/router.js";

export type SlackPostMessageClient = {
  chat: {
    postMessage(params: {
      channel: string;
      icon_url?: string;
      text: string;
      thread_ts?: string;
      username?: string;
    }): Promise<{ ts?: string }>;
    update?(params: { channel: string; text: string; ts: string }): Promise<unknown>;
  };
};

export type SlackDeliveryAdapterOptions = {
  allowCustomize?: boolean;
  client: SlackPostMessageClient;
};

type SlackTarget = {
  channelId: string;
  threadTs?: string;
};

type EventPayload = {
  deliveredByStream?: unknown;
  presentation?: unknown;
  text?: unknown;
};

export type SlackStreamDeliveryConfig = {
  bufferThresholdChars: number;
  cursor: string;
  editIntervalMs: number;
};

export type SlackStreamState = {
  accumulatedText: string;
  bufferSinceLastEdit: string;
  channelId: string;
  cursor: string;
  disabled: boolean;
  editIntervalMs: number;
  failureCount: number;
  lastEditAt: number;
  remoteMessageId?: string;
  targetId: string;
  threadTs?: string;
};

type PresentationPayload = {
  avatarUrl?: string;
  displayName?: string;
};

export class SlackStreamDelivery {
  readonly #client: SlackPostMessageClient;
  readonly #config: SlackStreamDeliveryConfig;
  readonly #now: () => number;
  readonly #states = new Map<string, SlackStreamState>();

  constructor(options: {
    client: SlackPostMessageClient;
    config: SlackStreamDeliveryConfig;
    now?: () => number;
  }) {
    this.#client = options.client;
    this.#config = options.config;
    this.#now = options.now ?? Date.now;
  }

  hasFinished(gatewayRunId: string): boolean {
    return !this.#states.has(gatewayRunId) && this.#finishedRunIds.has(gatewayRunId);
  }

  readonly #finishedRunIds = new Set<string>();

  async delta(input: { delta: string; gatewayRunId: string; targetId: string }): Promise<void> {
    const state = this.#ensureState(input.gatewayRunId, input.targetId);
    state.accumulatedText += input.delta;
    state.bufferSinceLastEdit += input.delta;

    if (!state.remoteMessageId) {
      const response = await this.#client.chat.postMessage({
        channel: state.channelId,
        text: `${state.accumulatedText}${state.cursor}`,
        ...(state.threadTs !== undefined ? { thread_ts: state.threadTs } : {}),
      });
      if (typeof response.ts === "string") {
        state.remoteMessageId = response.ts;
      }
      state.bufferSinceLastEdit = "";
      state.lastEditAt = this.#now();
      return;
    }

    if (state.disabled || !this.#client.chat.update) {
      return;
    }

    if (
      this.#now() - state.lastEditAt < state.editIntervalMs &&
      state.bufferSinceLastEdit.length < this.#config.bufferThresholdChars
    ) {
      return;
    }

    await this.#update(state, `${state.accumulatedText}${state.cursor}`);
    state.bufferSinceLastEdit = "";
    state.lastEditAt = this.#now();
  }

  async finish(input: { finalText?: string; gatewayRunId: string }): Promise<void> {
    const state = this.#states.get(input.gatewayRunId);
    if (!state) {
      return;
    }

    if (input.finalText !== undefined) {
      state.accumulatedText = input.finalText;
    }

    if (state.remoteMessageId && this.#client.chat.update) {
      await this.#update(state, state.accumulatedText);
    }
    this.#states.delete(input.gatewayRunId);
    this.#finishedRunIds.add(input.gatewayRunId);
  }

  #ensureState(gatewayRunId: string, targetId: string): SlackStreamState {
    const existing = this.#states.get(gatewayRunId);
    if (existing) {
      return existing;
    }

    const target = parseSlackTargetId(targetId);
    const state: SlackStreamState = {
      accumulatedText: "",
      bufferSinceLastEdit: "",
      channelId: target.channelId,
      cursor: this.#config.cursor,
      disabled: false,
      editIntervalMs: this.#config.editIntervalMs,
      failureCount: 0,
      lastEditAt: 0,
      targetId,
      ...(target.threadTs !== undefined ? { threadTs: target.threadTs } : {}),
    };
    this.#states.set(gatewayRunId, state);
    return state;
  }

  async #update(state: SlackStreamState, text: string): Promise<void> {
    if (!state.remoteMessageId || !this.#client.chat.update) {
      return;
    }

    try {
      await this.#client.chat.update({
        channel: state.channelId,
        text,
        ts: state.remoteMessageId,
      });
    } catch (error) {
      state.failureCount += 1;
      if (state.failureCount >= 3) {
        state.disabled = true;
      }
      throw error;
    }
  }
}

export class SlackDeliveryAdapter implements PlatformDeliveryAdapter {
  readonly #allowCustomize: boolean;
  readonly #client: SlackPostMessageClient;

  constructor(options: SlackDeliveryAdapterOptions) {
    this.#allowCustomize = options.allowCustomize ?? false;
    this.#client = options.client;
  }

  async deliver(input: {
    event: EventRecord;
    targetId: string;
  }): Promise<{ remoteMessageId?: string }> {
    const target = parseSlackTargetId(input.targetId);
    const payload = input.event.payload as EventPayload;
    if (payload.deliveredByStream === true) {
      return {};
    }
    const presentation = parsePresentation(payload.presentation);
    const response = await this.#client.chat.postMessage({
      channel: target.channelId,
      text: eventText(input.event),
      ...(target.threadTs !== undefined ? { thread_ts: target.threadTs } : {}),
      ...(this.#allowCustomize && presentation.displayName
        ? { username: presentation.displayName }
        : {}),
      ...(this.#allowCustomize && presentation.avatarUrl
        ? { icon_url: presentation.avatarUrl }
        : {}),
    });

    return typeof response.ts === "string" ? { remoteMessageId: response.ts } : {};
  }
}

export function slackTargetId(target: SlackTarget): string {
  return target.threadTs === undefined
    ? target.channelId
    : `${target.channelId}:${target.threadTs}`;
}

export function parseSlackTargetId(targetId: string): SlackTarget {
  const [channelId, threadTs] = targetId.split(":", 2);
  if (!channelId) {
    throw new Error("Slack target id must include a channel id");
  }

  return threadTs ? { channelId, threadTs } : { channelId };
}

function eventText(event: EventRecord): string {
  const payload = event.payload as EventPayload;
  if (typeof payload.text === "string" && payload.text.length > 0) {
    return payload.text;
  }

  return `[${event.type}]`;
}

function parsePresentation(value: unknown): PresentationPayload {
  if (typeof value !== "object" || value === null) {
    return {};
  }

  const record = value as Record<string, unknown>;
  return {
    ...(typeof record.avatarUrl === "string" ? { avatarUrl: record.avatarUrl } : {}),
    ...(typeof record.displayName === "string" ? { displayName: record.displayName } : {}),
  };
}
