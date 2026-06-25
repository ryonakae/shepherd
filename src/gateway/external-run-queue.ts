import type { EventRecord, EventStore } from "@/db/event-store.js";
import type { PiSessionMetadataStore } from "./pi-sessions.js";
import type { GatewayRunRecord, GatewayRunStore } from "./turn-queue.js";

export type GatewayQueuedRun = {
  event: EventRecord;
  run: GatewayRunRecord;
};

export type GatewayClaimedRun = {
  actorId: string | null;
  id: string;
  piSessionFile?: string;
  piSessionId?: string;
  presentation: unknown;
  triggeringEventId: number | null;
  userText: string;
};

export type GatewayClaimResult = {
  event: EventRecord;
  run: GatewayClaimedRun;
};

export type GatewayRunCompletionResult = {
  events: EventRecord[];
  run: GatewayRunRecord;
};

export class ExternalGatewayRunQueue {
  readonly #events: EventStore;
  readonly #piSessions: PiSessionMetadataStore | undefined;
  readonly #runStore: GatewayRunStore;

  constructor(options: {
    events: EventStore;
    piSessions?: PiSessionMetadataStore;
    runStore: GatewayRunStore;
  }) {
    this.#events = options.events;
    this.#piSessions = options.piSessions;
    this.#runStore = options.runStore;
  }

  getRun(gatewayRunId: string): GatewayRunRecord {
    return this.#runStore.getRun(gatewayRunId);
  }

  queueRun(input: { sessionId: string; triggeringEventId: number }): GatewayQueuedRun {
    const run = this.#runStore.createQueuedRun({
      sessionId: input.sessionId,
      triggeringEventId: input.triggeringEventId,
    });
    const pi = this.#piSessions?.ensureForSession(input.sessionId);
    const event = this.#events.appendEvent({
      payload: {
        gatewayRunId: run.id,
        ...(pi !== undefined
          ? {
              piSessionFile: pi.sessionFile,
              piSessionId: pi.sessionId,
            }
          : {}),
        triggeringEventId: input.triggeringEventId,
      },
      sessionId: input.sessionId,
      type: "gateway.run.queued",
    });

    return { event, run };
  }

  claimNextRun(input: { ownerId: string; sessionId: string }): GatewayClaimResult | undefined {
    const run = this.#runStore.claimNextQueuedRun(input.sessionId);
    if (!run) {
      return undefined;
    }

    const event = this.#events.appendEvent({
      payload: {
        gatewayRunId: run.id,
        ownerId: input.ownerId,
        triggeringEventId: run.triggeringEventId,
      },
      sessionId: run.sessionId,
      type: "gateway.run.started",
    });

    return {
      event,
      run: this.#toClaimedRun(run),
    };
  }

  startRun(input: { gatewayRunId: string; ownerId: string }): GatewayRunCompletionResult {
    const existing = this.#runStore.getRun(input.gatewayRunId);
    if (existing.status === "running") {
      return { events: [], run: existing };
    }

    const run = this.#runStore.markRunning(existing.id);
    const started = this.#events.appendEvent({
      payload: {
        gatewayRunId: run.id,
        ownerId: input.ownerId,
        triggeringEventId: run.triggeringEventId,
      },
      sessionId: run.sessionId,
      type: "gateway.run.started",
    });

    return { events: [started], run };
  }

  completeRun(input: {
    deliveredByStream?: boolean;
    gatewayRunId: string;
    ownerId: string;
    piSessionFile?: string;
    piSessionId?: string;
    text: string;
  }): GatewayRunCompletionResult {
    const existing = this.#runStore.getRun(input.gatewayRunId);
    const message = this.#events.appendEvent({
      payload: {
        gatewayRunId: existing.id,
        ownerId: input.ownerId,
        ...(input.deliveredByStream === true ? { deliveredByStream: true } : {}),
        ...(input.piSessionFile !== undefined ? { piSessionFile: input.piSessionFile } : {}),
        ...(input.piSessionId !== undefined ? { piSessionId: input.piSessionId } : {}),
        text: input.text,
      },
      sessionId: existing.sessionId,
      type: "gateway.message",
    });
    const run = this.#runStore.markCompleted(existing.id);
    const completed = this.#events.appendEvent({
      payload: {
        gatewayRunId: run.id,
        ownerId: input.ownerId,
      },
      sessionId: run.sessionId,
      type: "gateway.run.completed",
    });

    return { events: [message, completed], run };
  }

  markRunningRunRecoveryRequired(input: {
    message: string;
    ownerId: string;
    sessionId: string;
  }): GatewayRunCompletionResult | undefined {
    const running = this.#runStore.findRunningRun(input.sessionId);
    if (!running) {
      return undefined;
    }

    const recovery = {
      message: input.message,
      ownerId: input.ownerId,
      previousStatus: "running",
      recoveredAt: new Date().toISOString(),
    };
    const run = this.#runStore.markRecoveryRequired(running.id, recovery);
    const note = this.#events.appendEvent({
      idempotencyKey: `recovery:gateway_run:${run.id}:owner:${input.ownerId}`,
      payload: {
        gatewayRunId: run.id,
        ...recovery,
      },
      sessionId: run.sessionId,
      type: "recovery.note",
    });

    return { events: [note], run };
  }

  failRun(input: {
    gatewayRunId: string;
    message: string;
    ownerId: string;
  }): GatewayRunCompletionResult {
    const existing = this.#runStore.getRun(input.gatewayRunId);
    const run = this.#runStore.markFailed(existing.id, new Error(input.message));
    const failed = this.#events.appendEvent({
      payload: {
        gatewayRunId: run.id,
        message: input.message,
        ownerId: input.ownerId,
      },
      sessionId: run.sessionId,
      type: "gateway.run.failed",
    });

    return { events: [failed], run };
  }

  #toClaimedRun(run: GatewayRunRecord): GatewayClaimedRun {
    if (run.triggeringEventId === null) {
      return {
        actorId: null,
        id: run.id,
        ...this.#claimPiMetadata(run.sessionId),
        presentation: {},
        triggeringEventId: null,
        userText: "",
      };
    }

    const event = this.#events.getEvent(run.triggeringEventId);
    const payload = parseUserMessagePayload(event.payload);

    return {
      actorId: event.actorId,
      id: run.id,
      ...this.#claimPiMetadata(run.sessionId),
      presentation: payload.presentation,
      triggeringEventId: event.id,
      userText: payload.text,
    };
  }

  #claimPiMetadata(sessionId: string): Pick<GatewayClaimedRun, "piSessionFile" | "piSessionId"> {
    const pi = this.#events.getSession(sessionId).metadata.pi;
    return pi
      ? {
          piSessionFile: pi.sessionFile,
          piSessionId: pi.sessionId,
        }
      : {};
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
