import type { DatabaseSync } from "node:sqlite";
import type {
  AgentContextSnapshotRecord,
  AgentHistoryRef,
  CompactAgentHistory,
} from "@/observability/contracts.js";

type AgentContextSnapshotRow = {
  agent_id: string;
  compact_history_json: string;
  history_ref_json: string | null;
  pane_revision: number | null;
  source_mtime_ms: number | null;
  source_path: string | null;
  source_size: number | null;
  updated_at: number;
};

export class AgentContextSnapshotStore {
  readonly #sqlite: DatabaseSync;

  constructor(sqlite: DatabaseSync) {
    this.#sqlite = sqlite;
  }

  get(agentId: string): AgentContextSnapshotRecord | undefined {
    const row = this.#sqlite
      .prepare("select * from agent_context_snapshots where agent_id = ?")
      .get(agentId) as AgentContextSnapshotRow | undefined;
    return row ? mapSnapshot(row) : undefined;
  }

  listByAgentIds(agentIds: string[]): AgentContextSnapshotRecord[] {
    if (agentIds.length === 0) return [];
    const placeholders = agentIds.map(() => "?").join(", ");
    const rows = this.#sqlite
      .prepare(`select * from agent_context_snapshots where agent_id in (${placeholders})`)
      .all(...agentIds) as AgentContextSnapshotRow[];
    return rows.map(mapSnapshot);
  }

  put(input: Omit<AgentContextSnapshotRecord, "updatedAt">): AgentContextSnapshotRecord {
    if ((input.historyRef === null) !== (input.sourceFingerprint === null)) {
      throw new Error(
        "Agent context history ref and source fingerprint must both be null or non-null",
      );
    }
    const previous = this.get(input.agentId);
    const now = Math.max(Date.now(), (previous?.updatedAt.getTime() ?? -Infinity) + 1);
    this.#sqlite
      .prepare(
        `insert into agent_context_snapshots
         (agent_id, compact_history_json, history_ref_json, pane_revision, source_path, source_mtime_ms, source_size, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?)
         on conflict(agent_id) do update set
           compact_history_json = excluded.compact_history_json,
           history_ref_json = excluded.history_ref_json,
           pane_revision = excluded.pane_revision,
           source_path = excluded.source_path,
           source_mtime_ms = excluded.source_mtime_ms,
           source_size = excluded.source_size,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.agentId,
        JSON.stringify(input.compactHistory),
        input.historyRef === null ? null : JSON.stringify(input.historyRef),
        input.paneRevision,
        input.sourceFingerprint?.path ?? null,
        input.sourceFingerprint?.mtimeMs ?? null,
        input.sourceFingerprint?.size ?? null,
        now,
      );
    const snapshot = this.get(input.agentId);
    if (!snapshot) throw new Error("Agent context snapshot write failed");
    return snapshot;
  }

  delete(agentId: string): void {
    this.#sqlite.prepare("delete from agent_context_snapshots where agent_id = ?").run(agentId);
  }
}

function mapSnapshot(row: AgentContextSnapshotRow): AgentContextSnapshotRecord {
  const sourceFingerprint = mapSourceFingerprint(row);
  const historyRef = row.history_ref_json === null ? null : parseHistoryRef(row.history_ref_json);
  if ((historyRef === null) !== (sourceFingerprint === null)) {
    throw new Error("Stored agent context history ref and source fingerprint are inconsistent");
  }
  return {
    agentId: row.agent_id,
    compactHistory: parseCompactHistory(row.compact_history_json),
    historyRef,
    paneRevision: row.pane_revision,
    sourceFingerprint,
    updatedAt: new Date(row.updated_at),
  };
}

function mapSourceFingerprint(
  row: AgentContextSnapshotRow,
): AgentContextSnapshotRecord["sourceFingerprint"] {
  const values = [row.source_path, row.source_mtime_ms, row.source_size];
  if (values.every((value) => value === null)) return null;
  if (
    typeof row.source_path !== "string" ||
    typeof row.source_mtime_ms !== "number" ||
    typeof row.source_size !== "number"
  ) {
    throw new Error("Stored agent context source fingerprint is invalid");
  }
  return { mtimeMs: row.source_mtime_ms, path: row.source_path, size: row.source_size };
}

function parseCompactHistory(value: string): CompactAgentHistory {
  const parsed = parseJson(value, "compact history");
  if (
    !hasNullableHistoryRef(parsed.historyRef) ||
    !hasNullableExcerpt(parsed.lastAssistantMessage) ||
    !hasNullableToolResult(parsed.lastToolResult) ||
    !hasNullableExcerpt(parsed.lastUserMessage) ||
    typeof parsed.messageCount !== "number" ||
    !hasNullableString(parsed.source) ||
    !hasNullableString(parsed.updatedAt)
  ) {
    throw new Error("Stored agent context compact history is invalid");
  }
  return parsed as CompactAgentHistory;
}

function parseHistoryRef(value: string): AgentHistoryRef {
  const parsed = parseJson(value, "history ref");
  if (
    (parsed.kind !== "agent_session" && parsed.kind !== "discovered_file") ||
    typeof parsed.source !== "string" ||
    typeof parsed.value !== "string" ||
    !(parsed.path === undefined || typeof parsed.path === "string")
  ) {
    throw new Error("Stored agent context history ref is invalid");
  }
  return parsed as AgentHistoryRef;
}

function parseJson(value: string, label: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error();
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error(`Stored agent context ${label} is invalid`);
  }
}

function hasNullableHistoryRef(value: unknown): boolean {
  return value === null || (typeof value === "object" && value !== null);
}

function hasNullableExcerpt(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== "object" || value === null) return false;
  const excerpt = value as Record<string, unknown>;
  return (
    typeof excerpt.ref === "string" &&
    typeof excerpt.text === "string" &&
    hasNullableString(excerpt.timestamp)
  );
}

function hasNullableToolResult(value: unknown): boolean {
  return value === null || (typeof value === "object" && value !== null);
}

function hasNullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}
