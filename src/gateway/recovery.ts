import type { DatabaseSync } from "node:sqlite";
import type { EventStore } from "@/db/event-store.js";
import { type GatewayRunStatus, GatewayRunStore } from "@/gateway/turn-queue.js";

export type GatewayRunRecoveryNote = {
  gatewayRunId: string;
  previousStatus: Extract<GatewayRunStatus, "queued" | "running">;
  sessionId: string;
};

export type GatewayRecoveryResult = {
  gatewayRuns: GatewayRunRecoveryNote[];
};

export function recoverGatewayState(options: {
  events: EventStore;
  sqlite: DatabaseSync;
}): GatewayRecoveryResult {
  const runStore = new GatewayRunStore(options.sqlite);
  const gatewayRuns: GatewayRunRecoveryNote[] = [];

  for (const run of runStore.listRecoverableRuns()) {
    const previousStatus = run.status as Extract<GatewayRunStatus, "queued" | "running">;
    const recovery = {
      message:
        "Gateway run was in flight during gateway startup. Shepherd did not replay it automatically.",
      previousStatus,
      recoveredAt: new Date().toISOString(),
    };
    runStore.markRecoveryRequired(run.id, recovery);
    options.events.appendEvent({
      idempotencyKey: `recovery:gateway_run:${run.id}`,
      payload: {
        gatewayRunId: run.id,
        ...recovery,
      },
      sessionId: run.sessionId,
      type: "recovery.note",
    });
    gatewayRuns.push({
      gatewayRunId: run.id,
      previousStatus,
      sessionId: run.sessionId,
    });
  }

  return { gatewayRuns };
}
