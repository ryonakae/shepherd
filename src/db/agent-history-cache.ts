import type { DatabaseSync } from "node:sqlite";
import type { AgentHistoryRef, CompactAgentHistory } from "@/observability/contracts.js";

export type AgentHistoryCacheRecord = {
  compactHistory: CompactAgentHistory;
  formatterVersion: string;
  historyRef: AgentHistoryRef;
  id: number;
  sourceMtimeMs: number;
  sourcePath: string;
  sourceSize: number;
  updatedAt: Date;
};

type AgentHistoryCacheRow = {
  compact_history_json: string;
  formatter_version: string;
  history_ref_json: string;
  id: number;
  source_mtime_ms: number;
  source_path: string;
  source_size: number;
  updated_at: number;
};

export class AgentHistoryCacheStore {
  readonly #sqlite: DatabaseSync;

  constructor(sqlite: DatabaseSync) {
    this.#sqlite = sqlite;
  }

  getFresh(input: {
    formatterVersion: string;
    sourceMtimeMs: number;
    sourcePath: string;
    sourceSize: number;
  }): AgentHistoryCacheRecord | undefined {
    const row = this.#sqlite
      .prepare(
        `select * from agent_history_cache
         where source_path = ? and formatter_version = ? and source_mtime_ms = ? and source_size = ?`,
      )
      .get(input.sourcePath, input.formatterVersion, input.sourceMtimeMs, input.sourceSize) as
      | AgentHistoryCacheRow
      | undefined;
    return row ? mapCache(row) : undefined;
  }

  put(input: {
    compactHistory: CompactAgentHistory;
    formatterVersion: string;
    historyRef: AgentHistoryRef;
    sourceMtimeMs: number;
    sourcePath: string;
    sourceSize: number;
  }): AgentHistoryCacheRecord {
    const now = Date.now();
    this.#sqlite
      .prepare(
        `insert into agent_history_cache
         (source_path, formatter_version, history_ref_json, compact_history_json, source_mtime_ms, source_size, updated_at)
         values (?, ?, ?, ?, ?, ?, ?)
         on conflict(source_path, formatter_version) do update set
           history_ref_json = excluded.history_ref_json,
           compact_history_json = excluded.compact_history_json,
           source_mtime_ms = excluded.source_mtime_ms,
           source_size = excluded.source_size,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.sourcePath,
        input.formatterVersion,
        JSON.stringify(input.historyRef),
        JSON.stringify(input.compactHistory),
        input.sourceMtimeMs,
        input.sourceSize,
        now,
      );
    const row = this.#sqlite
      .prepare("select * from agent_history_cache where source_path = ? and formatter_version = ?")
      .get(input.sourcePath, input.formatterVersion) as AgentHistoryCacheRow | undefined;
    if (!row) throw new Error("Agent history cache write failed");
    return mapCache(row);
  }
}

function mapCache(row: AgentHistoryCacheRow): AgentHistoryCacheRecord {
  return {
    compactHistory: JSON.parse(row.compact_history_json) as CompactAgentHistory,
    formatterVersion: row.formatter_version,
    historyRef: JSON.parse(row.history_ref_json) as AgentHistoryRef,
    id: row.id,
    sourceMtimeMs: row.source_mtime_ms,
    sourcePath: row.source_path,
    sourceSize: row.source_size,
    updatedAt: new Date(row.updated_at),
  };
}
