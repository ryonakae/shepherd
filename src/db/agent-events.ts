import type { DatabaseSync } from "node:sqlite";
import type {
  AgentEventRecord,
  AgentEventType,
  AgentQueryScope,
  CompactAgentHistory,
} from "@/observability/contracts.js";

type AgentEventRow = {
  agent_id: string | null;
  compact_history_json: string | null;
  created_at: number;
  herdr_session_name: string;
  id: number;
  idempotency_key: string | null;
  pane_id: string | null;
  payload_json: string;
  terminal_id: string | null;
  type: AgentEventType;
  workspace_id: string | null;
};

export class AgentEventStore {
  readonly #sqlite: DatabaseSync;

  constructor(sqlite: DatabaseSync) {
    this.#sqlite = sqlite;
  }

  append(input: {
    agentId?: string | null;
    compactHistory?: CompactAgentHistory | null;
    herdrSessionName: string;
    idempotencyKey?: string | null;
    paneId?: string | null;
    payload: unknown;
    terminalId?: string | null;
    type: AgentEventType;
    workspaceId?: string | null;
  }): AgentEventRecord {
    const existing = input.idempotencyKey
      ? (this.#sqlite
          .prepare(
            "select * from agent_events where herdr_session_name = ? and idempotency_key = ?",
          )
          .get(input.herdrSessionName, input.idempotencyKey) as AgentEventRow | undefined)
      : undefined;
    if (existing) return mapAgentEvent(existing);

    const result = this.#sqlite
      .prepare(
        `insert into agent_events
         (herdr_session_name, agent_id, pane_id, workspace_id, terminal_id, type, payload_json, compact_history_json, idempotency_key, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.herdrSessionName,
        input.agentId ?? null,
        input.paneId ?? null,
        input.workspaceId ?? null,
        input.terminalId ?? null,
        input.type,
        JSON.stringify(input.payload),
        input.compactHistory ? JSON.stringify(input.compactHistory) : null,
        input.idempotencyKey ?? null,
        Date.now(),
      );
    return this.get(Number(result.lastInsertRowid));
  }

  listAfter(
    input: AgentQueryScope & { afterEventId?: number; limit?: number },
  ): AgentEventRecord[] {
    const clauses = ["id > ?"];
    const params: Array<number | string | null> = [input.afterEventId ?? 0];
    if (input.herdrSessionName) {
      clauses.push("herdr_session_name = ?");
      params.push(input.herdrSessionName);
    }
    if (input.workspaceId) {
      clauses.push("workspace_id = ?");
      params.push(input.workspaceId);
    }
    const limit = input.limit ?? 100;
    const rows = this.#sqlite
      .prepare(`select * from agent_events where ${clauses.join(" and ")} order by id asc limit ?`)
      .all(...params, limit) as AgentEventRow[];
    return rows.map(mapAgentEvent);
  }

  nextDeliverableAfter(input: {
    afterEventId: number;
    herdrSessionName: string;
    ownerTerminalId: string;
    workspaceId: string;
  }): AgentEventRecord | undefined {
    const row = this.#sqlite
      .prepare(
        `select * from agent_events
         where id > ?
           and herdr_session_name = ?
           and workspace_id = ?
           and terminal_id is not null
           and terminal_id != ?
         order by id asc
         limit 1`,
      )
      .get(input.afterEventId, input.herdrSessionName, input.workspaceId, input.ownerTerminalId) as
      | AgentEventRow
      | undefined;
    return row ? mapAgentEvent(row) : undefined;
  }

  latestEventId(scope: AgentQueryScope = {}): number {
    const clauses: string[] = [];
    const params: Array<number | string | null> = [];
    if (scope.herdrSessionName) {
      clauses.push("herdr_session_name = ?");
      params.push(scope.herdrSessionName);
    }
    if (scope.workspaceId) {
      clauses.push("workspace_id = ?");
      params.push(scope.workspaceId);
    }
    const where = clauses.length > 0 ? ` where ${clauses.join(" and ")}` : "";
    const row = this.#sqlite
      .prepare(`select max(id) as id from agent_events${where}`)
      .get(...params) as { id: number | null } | undefined;
    return row?.id ?? 0;
  }

  get(id: number): AgentEventRecord {
    const row = this.#sqlite.prepare("select * from agent_events where id = ?").get(id) as
      | AgentEventRow
      | undefined;
    if (!row) throw new Error(`Agent event not found: ${id}`);
    return mapAgentEvent(row);
  }
}

export function mapAgentEvent(row: AgentEventRow): AgentEventRecord {
  return {
    agentId: row.agent_id,
    compactHistory: parseJson<CompactAgentHistory>(row.compact_history_json),
    createdAt: new Date(row.created_at),
    herdrSessionName: row.herdr_session_name,
    id: row.id,
    paneId: row.pane_id,
    payload: parseJson<unknown>(row.payload_json) ?? {},
    terminalId: row.terminal_id,
    type: row.type,
    workspaceId: row.workspace_id,
  };
}

function parseJson<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}
