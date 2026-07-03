import type { DatabaseSync } from "node:sqlite";
import type { WorkerSnapshot } from "@/observability/contracts.js";

export type WorkerSnapshotRecord = {
  createdAt: Date;
  id: number;
  observedWorkspaceId: string;
  snapshot: WorkerSnapshot;
  workerId: string;
};

type WorkerSnapshotRow = {
  created_at: number;
  id: number;
  observed_workspace_id: string;
  snapshot_json: string;
  worker_id: string;
};

export class WorkerSnapshotStore {
  readonly #sqlite: DatabaseSync;

  constructor(sqlite: DatabaseSync) {
    this.#sqlite = sqlite;
  }

  putCurrent(input: {
    observedWorkspaceId: string;
    snapshot: WorkerSnapshot;
    workerId: string;
  }): WorkerSnapshotRecord {
    const now = Date.now();
    const result = this.#sqlite
      .prepare(
        `insert into worker_snapshots (observed_workspace_id, worker_id, snapshot_json, created_at)
         values (?, ?, ?, ?)`,
      )
      .run(input.observedWorkspaceId, input.workerId, JSON.stringify(input.snapshot), now);

    return this.#get(Number(result.lastInsertRowid));
  }

  listCurrent(observedWorkspaceId: string): WorkerSnapshot[] {
    const rows = this.#sqlite
      .prepare(
        `select ws.*
         from worker_snapshots ws
         join (
           select worker_id, max(id) as id
           from worker_snapshots
           where observed_workspace_id = ?
           group by worker_id
         ) latest on latest.id = ws.id
         order by ws.created_at desc, ws.id desc`,
      )
      .all(observedWorkspaceId) as WorkerSnapshotRow[];

    return rows.map((row) => mapWorkerSnapshot(row).snapshot);
  }

  #get(id: number): WorkerSnapshotRecord {
    const row = this.#sqlite.prepare("select * from worker_snapshots where id = ?").get(id) as
      | WorkerSnapshotRow
      | undefined;
    if (!row) {
      throw new Error(`Worker snapshot not found: ${id}`);
    }

    return mapWorkerSnapshot(row);
  }
}

function mapWorkerSnapshot(row: WorkerSnapshotRow): WorkerSnapshotRecord {
  return {
    createdAt: new Date(row.created_at),
    id: row.id,
    observedWorkspaceId: row.observed_workspace_id,
    snapshot: JSON.parse(row.snapshot_json) as WorkerSnapshot,
    workerId: row.worker_id,
  };
}
