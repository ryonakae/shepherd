import type { PiOwnerKind, PiTurnRecord, PiTurnSource, PiTurnStore } from "@/db/pi-turns.js";
import type { EventRecord, EventStore } from "@/db/event-store.js";
import type { PiSessionMetadataStore } from "./pi-sessions.js";

export type PiQueuedTurn = {
  event: EventRecord;
  turn: PiTurnRecord;
};

export type PiClaimedTurn = {
  actorId: string | null;
  id: string;
  piSessionFile?: string;
  piSessionId?: string;
  piTurnId: string;
  presentation: unknown;
  triggeringEventId: number | null;
  userText: string;
};

export type PiClaimResult = {
  event: EventRecord;
  turn: PiClaimedTurn;
};

export type PiTurnTransitionResult = {
  events: EventRecord[];
  turn: PiTurnRecord;
};

export class PiTurnQueue {
  readonly #events: EventStore;
  readonly #piSessions: PiSessionMetadataStore | undefined;
  readonly #turnStore: PiTurnStore;

  constructor(options: {
    events: EventStore;
    piSessions?: PiSessionMetadataStore;
    turnStore: PiTurnStore;
  }) {
    this.#events = options.events;
    this.#piSessions = options.piSessions;
    this.#turnStore = options.turnStore;
  }

  getTurn(piTurnId: string): PiTurnRecord {
    return this.#turnStore.getTurn(piTurnId);
  }

  queueTurn(input: { sessionId: string; triggeringEventId: number }): PiQueuedTurn {
    const turn = this.#turnStore.createQueuedTurn({
      sessionId: input.sessionId,
      triggeringEventId: input.triggeringEventId,
    });
    const pi = this.#piSessions?.ensureForSession(input.sessionId);
    const event = this.#events.appendEvent({
      idempotencyKey: `pi:turn:${turn.id}:queued`,
      payload: {
        piTurnId: turn.id,
        ...(pi !== undefined
          ? {
              piSessionFile: pi.sessionFile,
              piSessionId: pi.sessionId,
            }
          : {}),
        triggeringEventId: input.triggeringEventId,
      },
      sessionId: input.sessionId,
      type: "pi.turn.queued",
    });

    return { event, turn };
  }

  claimNextTurn(input: { ownerId: string; sessionId: string }): PiClaimResult | undefined {
    const turn = this.#turnStore.claimNextQueuedTurn(input.sessionId);
    if (!turn) {
      return undefined;
    }

    const event = this.#events.getEventByIdempotencyKey(turn.sessionId, `pi:turn:${turn.id}:queued`);

    return { event, turn: this.#toClaimedTurn(turn) };
  }

  startTurn(input: {
    inputEventIds: number[];
    ownerId: string;
    ownerKind: PiOwnerKind;
    piSessionFile: string;
    piSessionId: string;
    piTurnId: string;
    sessionId: string;
    source: PiTurnSource;
    triggeringEventId?: number;
  }): PiTurnTransitionResult {
    const existing = this.#getTurnIfPresent(input.piTurnId);
    const turn = existing
      ? this.#turnStore.markRunning({
          id: input.piTurnId,
          inputEventIds: input.inputEventIds,
          ownerId: input.ownerId,
          ownerKind: input.ownerKind,
          piSessionFile: input.piSessionFile,
          piSessionId: input.piSessionId,
          source: input.source,
        })
      : this.#turnStore.createRunningTurn({
          id: input.piTurnId,
          inputEventIds: input.inputEventIds,
          ownerId: input.ownerId,
          ownerKind: input.ownerKind,
          piSessionFile: input.piSessionFile,
          piSessionId: input.piSessionId,
          sessionId: input.sessionId,
          source: input.source,
          ...(input.triggeringEventId !== undefined
            ? { triggeringEventId: input.triggeringEventId }
            : {}),
        });
    const started = this.#events.appendEvent({
      idempotencyKey: `pi:turn:${input.piTurnId}:started`,
      payload: {
        inputEventIds: input.inputEventIds,
        ownerId: input.ownerId,
        ownerKind: input.ownerKind,
        piSessionFile: input.piSessionFile,
        piSessionId: input.piSessionId,
        piTurnId: input.piTurnId,
        source: input.source,
        ...(input.triggeringEventId !== undefined
          ? { triggeringEventId: input.triggeringEventId }
          : {}),
      },
      sessionId: input.sessionId,
      type: "pi.turn.started",
    });

    return { events: [started], turn };
  }

  completeTurnFromPi(input: { ownerId: string; piTurnId: string }): PiTurnTransitionResult {
    const result = this.#turnStore.markCompletedIfRunning(input.piTurnId);
    const completed = this.#events.appendEvent({
      idempotencyKey: `pi:turn:${input.piTurnId}:completed`,
      payload: {
        ownerId: input.ownerId,
        piTurnId: input.piTurnId,
      },
      sessionId: result.turn.sessionId,
      type: "pi.turn.completed",
    });

    return { events: [completed], turn: result.turn };
  }

  failTurnFromPi(input: {
    message: string;
    ownerId: string;
    piTurnId: string;
  }): PiTurnTransitionResult {
    const result = this.#turnStore.markFailedIfRunning(input.piTurnId, new Error(input.message));
    const failed = this.#events.appendEvent({
      idempotencyKey: `pi:turn:${input.piTurnId}:failed`,
      payload: {
        message: input.message,
        ownerId: input.ownerId,
        piTurnId: input.piTurnId,
      },
      sessionId: result.turn.sessionId,
      type: "pi.turn.failed",
    });

    return { events: [failed], turn: result.turn };
  }

  markRunningTurnRecoveryRequired(input: {
    message: string;
    ownerId: string;
    sessionId: string;
  }): PiTurnTransitionResult | undefined {
    const turn = this.#turnStore.markRecoveryRequiredForRunning(input);
    if (!turn) {
      return undefined;
    }

    const recovery = {
      message: input.message,
      ownerId: input.ownerId,
      piTurnId: turn.id,
      previousStatus: "running" as const,
      recoveredAt: new Date().toISOString(),
    };
    const lifecycle = this.#events.appendEvent({
      idempotencyKey: `pi:turn:${turn.id}:recovery_required:${input.ownerId}`,
      payload: recovery,
      sessionId: turn.sessionId,
      type: "pi.turn.recovery_required",
    });
    const note = this.#events.appendEvent({
      idempotencyKey: `recovery:pi_turn:${turn.id}:owner:${input.ownerId}`,
      payload: recovery,
      sessionId: turn.sessionId,
      type: "recovery.note",
    });

    return { events: [lifecycle, note], turn };
  }

  #toClaimedTurn(turn: PiTurnRecord): PiClaimedTurn {
    if (turn.triggeringEventId === null) {
      return {
        actorId: null,
        id: turn.id,
        ...this.#claimPiMetadata(turn.sessionId),
        piTurnId: turn.id,
        presentation: {},
        triggeringEventId: null,
        userText: "",
      };
    }

    const event = this.#events.getEvent(turn.triggeringEventId);
    const payload = parseUserMessagePayload(event.payload);

    return {
      actorId: event.actorId,
      id: turn.id,
      ...this.#claimPiMetadata(turn.sessionId),
      piTurnId: turn.id,
      presentation: payload.presentation,
      triggeringEventId: event.id,
      userText: payload.text,
    };
  }

  #claimPiMetadata(sessionId: string): Pick<PiClaimedTurn, "piSessionFile" | "piSessionId"> {
    const pi = this.#events.getSession(sessionId).metadata.pi;
    return pi
      ? {
          piSessionFile: pi.sessionFile,
          piSessionId: pi.sessionId,
        }
      : {};
  }

  #getTurnIfPresent(piTurnId: string): PiTurnRecord | undefined {
    try {
      return this.#turnStore.getTurn(piTurnId);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Pi turn not found:")) {
        return undefined;
      }
      throw error;
    }
  }
}

function parseUserMessagePayload(payload: unknown): { presentation: unknown; text: string } {
  if (typeof payload !== "object" || payload === null) {
    return { presentation: {}, text: "" };
  }

  const record = payload as Record<string, unknown>;
  return {
    presentation: record.presentation ?? {},
    text: typeof record.text === "string" ? record.text : "",
  };
}
