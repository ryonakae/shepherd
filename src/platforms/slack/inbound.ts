import type { EventRecord, EventStore, SessionRecord } from "@/db/event-store.js";
import type { SessionBindingRecord, SessionBindingStore } from "@/db/session-bindings.js";

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
  readonly #bindings: SessionBindingStore;
  readonly #events: EventStore;

  constructor(stores: { bindings: SessionBindingStore; events: EventStore }) {
    this.#bindings = stores.bindings;
    this.#events = stores.events;
  }

  handleMessageEvent(event: unknown): SlackInboundResult | undefined {
    const message = normalizeSlackMessageEvent(event);
    if (!message) {
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

    this.#events.upsertActor({
      displayName: message.actor.displayName,
      id: message.actor.id,
      kind: "user",
      presentation: message.actor.presentation,
      sourcePlatform: "slack",
      sourceUserId: message.actor.sourceUserId,
    });

    const storedEvent = this.#events.appendEvent({
      actorId: message.actor.id,
      idempotencyKey: message.idempotencyKey,
      payload: {
        presentation: message.actor.presentation,
        text: message.text,
      },
      sessionId: session.id,
      type: "user.message",
    });

    return {
      binding,
      createdSession: existing === undefined,
      event: storedEvent,
      session,
    };
  }
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
