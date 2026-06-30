import type { DatabaseSync } from "node:sqlite";
import type { EventStore } from "@/db/event-store.js";
import { type PiTurnStatus, PiTurnStore } from "@/db/pi-turns.js";

export type PiTurnRecoveryNote = {
  piTurnId: string;
  previousStatus: Extract<PiTurnStatus, "running">;
  sessionId: string;
};

export type GatewayRecoveryResult = {
  piTurns: PiTurnRecoveryNote[];
};

export function recoverGatewayState(options: {
  events: EventStore;
  sqlite: DatabaseSync;
}): GatewayRecoveryResult {
  const turnStore = new PiTurnStore(options.sqlite);
  const piTurns: PiTurnRecoveryNote[] = [];

  for (const turn of turnStore.listRecoverableTurns()) {
    if (turn.status !== "running" || !turn.ownerId) {
      continue;
    }

    const recovery = {
      message:
        "Pi turn was in flight during gateway startup. Shepherd did not replay it automatically.",
      ownerId: turn.ownerId,
      piTurnId: turn.id,
      previousStatus: "running" as const,
      recoveredAt: new Date().toISOString(),
    };
    turnStore.markRecoveryRequiredForRunning({
      message: recovery.message,
      ownerId: turn.ownerId,
      sessionId: turn.sessionId,
    });
    options.events.appendEvent({
      idempotencyKey: `recovery:pi_turn:${turn.id}`,
      payload: recovery,
      sessionId: turn.sessionId,
      type: "recovery.note",
    });
    piTurns.push({
      piTurnId: turn.id,
      previousStatus: "running",
      sessionId: turn.sessionId,
    });
  }

  return { piTurns };
}
