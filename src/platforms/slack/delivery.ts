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
  presentation?: unknown;
  text?: unknown;
};

type PresentationPayload = {
  avatarUrl?: string;
  displayName?: string;
};

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
