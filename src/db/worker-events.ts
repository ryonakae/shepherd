import type { DatabaseSync } from "node:sqlite";
import type { WorkerEventType, WorkerEventWireRecord } from "@/observability/contracts.js";

export type WorkerEventRecord = WorkerEventWireRecord;

export type AppendWorkerEventInput = {
  idempotencyKey?: string | null;
  observedWorkspaceId: string;
  payload: unknown;
  type: WorkerEventType;
  workerId: string | null;
};

type WorkerEventRow = {
  created_at: number;
  id: number;
  idempotency_key: string | null;
  observed_workspace_id: string;
  payload_json: string;
  type: WorkerEventType;
  worker_id: string | null;
};

export class WorkerEventStore {
  readonly #sqlite: DatabaseSync;

  constructor(sqlite: DatabaseSync) {
    this.#sqlite = sqlite;
  }

  append(input: AppendWorkerEventInput): WorkerEventRecord {
    const payloadJson = JSON.stringify(input.payload);
    if (payloadJson === undefined) {
      throw new TypeError("Worker event payload must be JSON-serializable");
    }

    const now = Date.now();
    if (input.idempotencyKey) {
      this.#sqlite
        .prepare(
          `insert or ignore into worker_events
            (observed_workspace_id, worker_id, type, idempotency_key, payload_json, created_at)
           values (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.observedWorkspaceId,
          input.workerId,
          input.type,
          input.idempotencyKey,
          payloadJson,
          now,
        );

      const existing = this.#sqlite
        .prepare(
          "select * from worker_events where observed_workspace_id = ? and idempotency_key = ?",
        )
        .get(input.observedWorkspaceId, input.idempotencyKey) as WorkerEventRow | undefined;
      if (!existing) {
        throw new Error("Worker event insert failed");
      }

      return mapWorkerEvent(existing);
    }

    const result = this.#sqlite
      .prepare(
        `insert into worker_events
          (observed_workspace_id, worker_id, type, idempotency_key, payload_json, created_at)
         values (?, ?, ?, null, ?, ?)`,
      )
      .run(input.observedWorkspaceId, input.workerId, input.type, payloadJson, now);

    return this.#get(Number(result.lastInsertRowid));
  }

  listAfter(input: {
    afterEventId?: number;
    limit?: number;
    observedWorkspaceId: string;
  }): WorkerEventRecord[] {
    const rows = this.#sqlite
      .prepare(
        `select * from worker_events
         where observed_workspace_id = ? and id > ?
         order by id asc
         limit ?`,
      )
      .all(
        input.observedWorkspaceId,
        input.afterEventId ?? 0,
        input.limit ?? 100,
      ) as WorkerEventRow[];

    return rows.map(mapWorkerEvent);
  }

  latestEventId(observedWorkspaceId: string): number {
    const row = this.#sqlite
      .prepare(
        "select coalesce(max(id), 0) as id from worker_events where observed_workspace_id = ?",
      )
      .get(observedWorkspaceId) as { id: number };

    return row.id;
  }

  #get(id: number): WorkerEventRecord {
    const row = this.#sqlite.prepare("select * from worker_events where id = ?").get(id) as
      | WorkerEventRow
      | undefined;
    if (!row) {
      throw new Error(`Worker event not found: ${id}`);
    }

    return mapWorkerEvent(row);
  }
}

export function mapWorkerEvent(row: WorkerEventRow): WorkerEventRecord {
  return {
    createdAt: new Date(row.created_at).toISOString(),
    id: row.id,
    observedWorkspaceId: row.observed_workspace_id,
    payload: JSON.parse(row.payload_json),
    type: row.type,
    workerId: row.worker_id,
  };
}
