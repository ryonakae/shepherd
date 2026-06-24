import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { GatewayProviderOutput, GatewayRunner, GatewayTurnInput } from "./runner.js";

export type GatewayRunStatus = "completed" | "failed" | "queued" | "recovery_required" | "running";

export type GatewayRunRecord = {
  completedAt: Date | null;
  createdAt: Date;
  id: string;
  recovery: unknown;
  sessionId: string;
  startedAt: Date | null;
  status: GatewayRunStatus;
  triggeringEventId: number | null;
  updatedAt: Date;
};

type GatewayRunRow = {
  completed_at: number | null;
  created_at: number;
  id: string;
  recovery_json: string | null;
  session_id: string;
  started_at: number | null;
  status: GatewayRunStatus;
  triggering_event_id: number | null;
  updated_at: number;
};

export type GatewayTurnRunner = Pick<GatewayRunner, "runTurn">;

export class GatewayRunStore {
  readonly #sqlite: DatabaseSync;

  constructor(sqlite: DatabaseSync) {
    this.#sqlite = sqlite;
  }

  createQueuedRun(input: { sessionId: string; triggeringEventId?: number }): GatewayRunRecord {
    const id = randomUUID();
    const now = Date.now();
    this.#sqlite
      .prepare(
        "insert into gateway_runs (id, session_id, status, triggering_event_id, recovery_json, started_at, completed_at, created_at, updated_at) values (?, ?, 'queued', ?, null, null, null, ?, ?)",
      )
      .run(id, input.sessionId, input.triggeringEventId ?? null, now, now);

    return this.getRun(id);
  }

  markRunning(id: string): GatewayRunRecord {
    const now = Date.now();
    this.#sqlite
      .prepare(
        "update gateway_runs set status = 'running', started_at = ?, updated_at = ? where id = ?",
      )
      .run(now, now, id);

    return this.getRun(id);
  }

  markCompleted(id: string): GatewayRunRecord {
    return this.#markTerminal(id, "completed");
  }

  markFailed(id: string, error: unknown): GatewayRunRecord {
    return this.#markTerminal(id, "failed", {
      message: error instanceof Error ? error.message : String(error),
    });
  }

  markRecoveryRequired(id: string, recovery: unknown): GatewayRunRecord {
    const now = Date.now();
    this.#sqlite
      .prepare(
        "update gateway_runs set status = 'recovery_required', recovery_json = ?, updated_at = ? where id = ?",
      )
      .run(JSON.stringify(recovery), now, id);

    return this.getRun(id);
  }

  getRun(id: string): GatewayRunRecord {
    const row = this.#sqlite.prepare("select * from gateway_runs where id = ?").get(id) as
      | GatewayRunRow
      | undefined;
    if (!row) {
      throw new Error(`Gateway run not found: ${id}`);
    }

    return mapGatewayRun(row);
  }

  listRuns(sessionId: string): GatewayRunRecord[] {
    const rows = this.#sqlite
      .prepare("select * from gateway_runs where session_id = ? order by created_at asc, id asc")
      .all(sessionId) as GatewayRunRow[];

    return rows.map(mapGatewayRun);
  }

  listRecoverableRuns(): GatewayRunRecord[] {
    const rows = this.#sqlite
      .prepare(
        "select * from gateway_runs where status in ('queued', 'running') order by created_at asc, id asc",
      )
      .all() as GatewayRunRow[];

    return rows.map(mapGatewayRun);
  }

  #markTerminal(
    id: string,
    status: Extract<GatewayRunStatus, "completed" | "failed">,
    recovery?: unknown,
  ): GatewayRunRecord {
    const now = Date.now();
    this.#sqlite
      .prepare(
        "update gateway_runs set status = ?, completed_at = ?, recovery_json = ?, updated_at = ? where id = ?",
      )
      .run(status, now, recovery === undefined ? null : JSON.stringify(recovery), now, id);

    return this.getRun(id);
  }
}

export class GatewayTurnQueue {
  readonly #chains = new Map<string, Promise<void>>();
  readonly #runStore: GatewayRunStore;
  readonly #runner: GatewayTurnRunner;

  constructor(options: {
    runner: GatewayTurnRunner;
    runStore: GatewayRunStore;
  }) {
    this.#runner = options.runner;
    this.#runStore = options.runStore;
  }

  runTurn(
    input: GatewayTurnInput & { triggeringEventId?: number },
  ): Promise<GatewayProviderOutput> {
    const run = this.#runStore.createQueuedRun({
      sessionId: input.sessionId,
      ...(input.triggeringEventId !== undefined
        ? { triggeringEventId: input.triggeringEventId }
        : {}),
    });
    const previous = this.#chains.get(input.sessionId) ?? Promise.resolve();
    const task = previous
      .catch(() => undefined)
      .then(async () => {
        this.#runStore.markRunning(run.id);
        try {
          const output = await this.#runner.runTurn(input);
          this.#runStore.markCompleted(run.id);
          return output;
        } catch (error) {
          this.#runStore.markFailed(run.id, error);
          throw error;
        }
      });

    const chain = task.then(
      () => undefined,
      () => undefined,
    );
    this.#chains.set(input.sessionId, chain);
    void chain.then(() => {
      if (this.#chains.get(input.sessionId) === chain) {
        this.#chains.delete(input.sessionId);
      }
    });

    return task;
  }
}

function mapGatewayRun(row: GatewayRunRow): GatewayRunRecord {
  return {
    completedAt: row.completed_at === null ? null : new Date(row.completed_at),
    createdAt: new Date(row.created_at),
    id: row.id,
    recovery: row.recovery_json === null ? null : JSON.parse(row.recovery_json),
    sessionId: row.session_id,
    startedAt: row.started_at === null ? null : new Date(row.started_at),
    status: row.status,
    triggeringEventId: row.triggering_event_id,
    updatedAt: new Date(row.updated_at),
  };
}
