import type { EventRecord, EventStore, SessionRecord } from "@/db/event-store.js";
import type { SessionBindingRecord, SessionBindingStore } from "@/db/session-bindings.js";

export type SlackUserMessageAppender = (input: {
  actorId: string;
  idempotencyKey: string;
  presentation: NormalizedSlackMessage["actor"]["presentation"];
  sessionId: string;
  text: string;
}) => EventRecord | Promise<EventRecord>;

export type SlackInboundPolicy = {
  allowedChannels?: readonly string[];
  allowedTeams?: readonly string[];
  allowedUsers?: readonly string[];
};

export type SlackInboundLogger = {
  debug?: (message: string, metadata: SlackPolicyLogMetadata) => void;
};

export type SlackPolicyLogMetadata = {
  channelId: string;
  teamId: string;
  userId: string;
};

export type NormalizedSlackMessage = {
  actor: {
    displayName: string;
    id: string;
    presentation: {
      displayName: string;
      sourcePlatform: "slack";
      sourceUserId: string;
    };
    sourceUserId: string;
  };
  channelId: string;
  idempotencyKey: string;
  messageTs: string;
  teamId: string;
  text: string;
  threadTs: string;
};

export type SlackInboundResult = {
  binding: SessionBindingRecord;
  createdSession: boolean;
  event: EventRecord;
  session: SessionRecord;
};

type SlackMessageEvent = {
  bot_id?: unknown;
  channel?: unknown;
  subtype?: unknown;
  team?: unknown;
  text?: unknown;
  thread_ts?: unknown;
  ts?: unknown;
  type?: unknown;
  user?: unknown;
};

export class SlackInboundHandler {
  readonly #appendUserMessage: SlackUserMessageAppender;
  readonly #bindings: SessionBindingStore;
  readonly #events: EventStore;
  readonly #logger: SlackInboundLogger | undefined;

  constructor(
    stores: { bindings: SessionBindingStore; events: EventStore },
    options: {
      appendUserMessage?: SlackUserMessageAppender;
      logger?: SlackInboundLogger;
      policy?: SlackInboundPolicy;
    } = {},
  ) {
    this.#appendUserMessage =
      options.appendUserMessage ??
      ((input) => {
        this.#events.upsertActor({
          displayName: input.presentation.displayName,
          id: input.actorId,
          kind: "user",
          presentation: input.presentation,
          sourcePlatform: "slack",
          sourceUserId: input.presentation.sourceUserId,
        });

        return this.#events.appendEvent({
          actorId: input.actorId,
          idempotencyKey: input.idempotencyKey,
          payload: {
            presentation: input.presentation,
            text: input.text,
          },
          sessionId: input.sessionId,
          type: "user.message",
        });
      });
    this.#bindings = stores.bindings;
    this.#events = stores.events;
    this.#logger = options.logger;
    this.#policy = options.policy ?? {};
  }

  readonly #policy: SlackInboundPolicy;

  async handleMessageEvent(event: unknown): Promise<SlackInboundResult | undefined> {
    const message = normalizeSlackMessageEvent(event);
    if (!message) {
      return undefined;
    }

    const denialReason = getSlackPolicyDenialReason(message, this.#policy);
    if (denialReason) {
      this.#logger?.debug?.(`slack policy denied: ${denialReason}`, {
        channelId: message.channelId,
        teamId: message.teamId,
        userId: message.actor.sourceUserId,
      });
      return undefined;
    }

    const existing = this.#bindings.findByPlatformThread(
      "slack",
      message.channelId,
      message.threadTs,
    );
    const session =
      existing === undefined
        ? this.#events.createSession({ title: slackSessionTitle(message.text) })
        : this.#events.getSession(existing.sessionId);
    const binding =
      existing ??
      this.#bindings.ensureBinding({
        messageId: message.messageTs,
        metadata: { teamId: message.teamId },
        platform: "slack",
        sessionId: session.id,
        spaceId: message.channelId,
        threadId: message.threadTs,
      });

    const storedEvent = await this.#appendUserMessage({
      actorId: message.actor.id,
      idempotencyKey: message.idempotencyKey,
      presentation: message.actor.presentation,
      sessionId: session.id,
      text: message.text,
    });

    return {
      binding,
      createdSession: existing === undefined,
      event: storedEvent,
      session,
    };
  }
}

function getSlackPolicyDenialReason(
  message: NormalizedSlackMessage,
  policy: SlackInboundPolicy,
): "channel" | "team" | "user" | undefined {
  if (!isAllowed(policy.allowedTeams, message.teamId)) {
    return "team";
  }

  if (!isAllowed(policy.allowedChannels, message.channelId)) {
    return "channel";
  }

  if (!isAllowed(policy.allowedUsers, message.actor.sourceUserId)) {
    return "user";
  }

  return undefined;
}

function isAllowed(allowedValues: readonly string[] | undefined, value: string): boolean {
  return allowedValues === undefined || allowedValues.includes(value);
}

export function normalizeSlackMessageEvent(event: unknown): NormalizedSlackMessage | undefined {
  if (typeof event !== "object" || event === null) {
    return undefined;
  }

  const record = event as SlackMessageEvent;
  if (record.type !== "message" || record.bot_id || record.subtype) {
    return undefined;
  }

  if (
    typeof record.channel !== "string" ||
    typeof record.text !== "string" ||
    typeof record.ts !== "string" ||
    typeof record.user !== "string"
  ) {
    return undefined;
  }

  const teamId = typeof record.team === "string" ? record.team : "unknown";
  const threadTs = typeof record.thread_ts === "string" ? record.thread_ts : record.ts;
  const displayName = record.user;

  return {
    actor: {
      displayName,
      id: `slack:${teamId}:${record.user}`,
      presentation: {
        displayName,
        sourcePlatform: "slack",
        sourceUserId: record.user,
      },
      sourceUserId: record.user,
    },
    channelId: record.channel,
    idempotencyKey: `slack:${teamId}:${record.channel}:${record.ts}`,
    messageTs: record.ts,
    teamId,
    text: record.text,
    threadTs,
  };
}

function slackSessionTitle(text: string): string {
  const trimmed = text.trim().replaceAll(/\s+/g, " ");
  if (!trimmed) {
    return "Slack thread";
  }

  return trimmed.length > 80 ? `${trimmed.slice(0, 77)}...` : trimmed;
}
