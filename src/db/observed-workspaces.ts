import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  ObservedWorkspaceMetadata,
  ObservedWorkspaceRecord,
  ObservedWorkspaceStatus,
} from "@/observability/contracts.js";

export type ObserveWorkspaceStoreInput = {
  herdrSessionName?: string | null;
  metadata?: ObservedWorkspaceMetadata;
  socketPath?: string | null;
  workspaceId: string;
};

type ObservedWorkspaceRow = {
  created_at: number;
  herdr_session_name: string | null;
  id: string;
  last_resolved_at: number | null;
  live_workspace_id: string | null;
  metadata_json: string;
  socket_path: string | null;
  status: ObservedWorkspaceStatus;
  updated_at: number;
};

export class ObservedWorkspaceStore {
  readonly #sqlite: DatabaseSync;

  constructor(sqlite: DatabaseSync) {
    this.#sqlite = sqlite;
  }

  observe(input: ObserveWorkspaceStoreInput): ObservedWorkspaceRecord {
    const existing = this.#findObserved(input);
    if (existing) {
      return mapObservedWorkspace(existing);
    }

    const now = Date.now();
    const id = `ow_${randomUUID()}`;
    this.#sqlite
      .prepare(
        `insert into observed_workspaces
          (id, herdr_session_name, socket_path, live_workspace_id, status, metadata_json, created_at, updated_at, last_resolved_at)
         values (?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.herdrSessionName ?? null,
        input.socketPath ?? null,
        input.workspaceId,
        JSON.stringify(input.metadata ?? {}),
        now,
        now,
        now,
      );

    return this.get(id);
  }

  get(id: string): ObservedWorkspaceRecord {
    const row = this.#sqlite.prepare("select * from observed_workspaces where id = ?").get(id) as
      | ObservedWorkspaceRow
      | undefined;
    if (!row) {
      throw new Error(`Observed workspace not found: ${id}`);
    }

    return mapObservedWorkspace(row);
  }

  listActive(): ObservedWorkspaceRecord[] {
    const rows = this.#sqlite
      .prepare(
        "select * from observed_workspaces where status = 'active' order by updated_at desc, id desc",
      )
      .all() as ObservedWorkspaceRow[];

    return rows.map(mapObservedWorkspace);
  }

  markResolution(input: {
    id: string;
    liveWorkspaceId: string | null;
    metadata?: ObservedWorkspaceMetadata;
    status: ObservedWorkspaceStatus;
  }): ObservedWorkspaceRecord {
    const current = this.get(input.id);
    const now = Date.now();
    this.#sqlite
      .prepare(
        `update observed_workspaces
         set live_workspace_id = ?, status = ?, metadata_json = ?, updated_at = ?, last_resolved_at = ?
         where id = ?`,
      )
      .run(
        input.liveWorkspaceId,
        input.status,
        JSON.stringify(input.metadata ?? current.metadata),
        now,
        now,
        input.id,
      );

    return this.get(input.id);
  }

  #findObserved(input: ObserveWorkspaceStoreInput): ObservedWorkspaceRow | undefined {
    if (input.herdrSessionName) {
      const row = this.#sqlite
        .prepare(
          "select * from observed_workspaces where herdr_session_name = ? and live_workspace_id = ? order by created_at asc limit 1",
        )
        .get(input.herdrSessionName, input.workspaceId) as ObservedWorkspaceRow | undefined;
      if (row) {
        return row;
      }
    }

    if (input.socketPath) {
      return this.#sqlite
        .prepare(
          "select * from observed_workspaces where socket_path = ? and live_workspace_id = ? order by created_at asc limit 1",
        )
        .get(input.socketPath, input.workspaceId) as ObservedWorkspaceRow | undefined;
    }

    return undefined;
  }
}

function mapObservedWorkspace(row: ObservedWorkspaceRow): ObservedWorkspaceRecord {
  return {
    createdAt: new Date(row.created_at),
    herdrSessionName: row.herdr_session_name,
    id: row.id,
    lastResolvedAt: row.last_resolved_at === null ? null : new Date(row.last_resolved_at),
    liveWorkspaceId: row.live_workspace_id,
    metadata: JSON.parse(row.metadata_json) as ObservedWorkspaceMetadata,
    socketPath: row.socket_path,
    status: row.status,
    updatedAt: new Date(row.updated_at),
  };
}
