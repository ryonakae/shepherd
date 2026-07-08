import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  type AgentIndexRecord,
  type AgentQueryScope,
  type AgentSessionRef,
  type AgentStatus,
  parseAgentStatus,
} from "@/observability/contracts.js";

export type HerdrAgentLike = Record<string, unknown>;

type AgentRow = {
  agent: string | null;
  agent_session_json: string | null;
  agent_status: AgentStatus;
  cwd: string | null;
  first_seen_at: number;
  focused: 0 | 1;
  foreground_cwd: string | null;
  herdr_session_name: string;
  id: string;
  last_seen_at: number;
  pane_id: string;
  tab_id: string | null;
  terminal_id: string | null;
  workspace_id: string;
};

export class AgentStore {
  readonly #sqlite: DatabaseSync;

  constructor(sqlite: DatabaseSync) {
    this.#sqlite = sqlite;
  }

  replaceForSession(input: {
    agents: HerdrAgentLike[];
    herdrSessionName: string;
  }): AgentIndexRecord[] {
    const now = Date.now();
    const seenPaneIds: string[] = [];
    for (const agent of input.agents) {
      const paneId = stringValue(agent.pane_id) ?? stringValue(agent.paneId);
      const workspaceId = stringValue(agent.workspace_id) ?? stringValue(agent.workspaceId);
      if (!paneId || !workspaceId) continue;
      seenPaneIds.push(paneId);
      const existing = this.findByPane({ herdrSessionName: input.herdrSessionName, paneId });
      const id = existing?.id ?? `ag_${randomUUID()}`;
      const firstSeenAt = existing?.firstSeenAt.getTime() ?? now;
      this.#sqlite
        .prepare(
          `insert into agents
           (id, herdr_session_name, pane_id, terminal_id, tab_id, workspace_id, agent, agent_status, agent_session_json, cwd, foreground_cwd, focused, first_seen_at, last_seen_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           on conflict(herdr_session_name, pane_id) do update set
             terminal_id = excluded.terminal_id,
             tab_id = excluded.tab_id,
             workspace_id = excluded.workspace_id,
             agent = excluded.agent,
             agent_status = excluded.agent_status,
             agent_session_json = excluded.agent_session_json,
             cwd = excluded.cwd,
             foreground_cwd = excluded.foreground_cwd,
             focused = excluded.focused,
             last_seen_at = excluded.last_seen_at`,
        )
        .run(
          id,
          input.herdrSessionName,
          paneId,
          stringValue(agent.terminal_id) ?? stringValue(agent.terminalId),
          stringValue(agent.tab_id) ?? stringValue(agent.tabId),
          workspaceId,
          stringValue(agent.agent),
          parseAgentStatus(agent.agent_status),
          agentSessionJson(agent.agent_session),
          stringValue(agent.cwd),
          stringValue(agent.foreground_cwd) ?? stringValue(agent.foregroundCwd),
          agent.focused === true ? 1 : 0,
          firstSeenAt,
          now,
        );
    }

    if (seenPaneIds.length === 0) {
      this.#sqlite
        .prepare("delete from agents where herdr_session_name = ?")
        .run(input.herdrSessionName);
    } else {
      const placeholders = seenPaneIds.map(() => "?").join(", ");
      this.#sqlite
        .prepare(
          `delete from agents where herdr_session_name = ? and pane_id not in (${placeholders})`,
        )
        .run(input.herdrSessionName, ...seenPaneIds);
    }

    return this.list({ herdrSessionName: input.herdrSessionName });
  }

  updateStatus(input: {
    agentStatus: AgentStatus;
    herdrSessionName: string;
    paneId: string;
  }): AgentIndexRecord | undefined {
    const now = Date.now();
    this.#sqlite
      .prepare(
        "update agents set agent_status = ?, last_seen_at = ? where herdr_session_name = ? and pane_id = ?",
      )
      .run(input.agentStatus, now, input.herdrSessionName, input.paneId);
    return this.findByPane(input);
  }

  list(scope: AgentQueryScope = {}): AgentIndexRecord[] {
    const clauses: string[] = [];
    const params: Array<number | string | null> = [];
    if (!scope.all && scope.herdrSessionName) {
      clauses.push("herdr_session_name = ?");
      params.push(scope.herdrSessionName);
    }
    if (!scope.all && scope.workspaceId) {
      clauses.push("workspace_id = ?");
      params.push(scope.workspaceId);
    }
    if (scope.all && scope.herdrSessionName) {
      clauses.push("herdr_session_name = ?");
      params.push(scope.herdrSessionName);
    }
    const where = clauses.length > 0 ? ` where ${clauses.join(" and ")}` : "";
    const rows = this.#sqlite
      .prepare(`select * from agents${where} order by herdr_session_name, workspace_id, pane_id`)
      .all(...params) as AgentRow[];
    return rows.map(mapAgent);
  }

  listForHerdrSession(herdrSessionName: string): AgentIndexRecord[] {
    return this.list({ herdrSessionName });
  }

  findByPane(input: { herdrSessionName: string; paneId: string }): AgentIndexRecord | undefined {
    const row = this.#sqlite
      .prepare("select * from agents where herdr_session_name = ? and pane_id = ?")
      .get(input.herdrSessionName, input.paneId) as AgentRow | undefined;
    return row ? mapAgent(row) : undefined;
  }

  get(id: string): AgentIndexRecord {
    const row = this.#sqlite.prepare("select * from agents where id = ?").get(id) as
      | AgentRow
      | undefined;
    if (!row) throw new Error(`Agent not found: ${id}`);
    return mapAgent(row);
  }

  resolveTarget(scope: AgentQueryScope, target: string): AgentIndexRecord {
    const candidates = this.list(scope).filter(
      (agent) =>
        agent.paneId === target ||
        agent.terminalId === target ||
        agent.agent === target ||
        agent.id === target,
    );
    if (candidates.length === 1) return candidates[0] as AgentIndexRecord;
    if (candidates.length === 0) throw new Error(`agent target not found: ${target}`);
    throw new Error(
      `agent target ${target} is ambiguous; candidates: ${candidates
        .map(
          (agent) =>
            `session=${agent.herdrSessionName} workspace=${agent.workspaceId} pane=${agent.paneId} terminal=${agent.terminalId ?? "unknown"} agent=${agent.agent ?? "unknown"}`,
        )
        .join("; ")}`,
    );
  }
}

function mapAgent(row: AgentRow): AgentIndexRecord {
  return {
    agent: row.agent,
    agentSession: parseAgentSession(row.agent_session_json),
    agentStatus: row.agent_status,
    cwd: row.cwd,
    firstSeenAt: new Date(row.first_seen_at),
    focused: row.focused === 1,
    foregroundCwd: row.foreground_cwd,
    herdrSessionName: row.herdr_session_name,
    id: row.id,
    lastSeenAt: new Date(row.last_seen_at),
    paneId: row.pane_id,
    tabId: row.tab_id,
    terminalId: row.terminal_id,
    workspaceId: row.workspace_id,
  };
}

function agentSessionJson(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.agent === "string" &&
    (record.kind === "id" || record.kind === "path") &&
    typeof record.source === "string" &&
    typeof record.value === "string"
  ) {
    return JSON.stringify({
      agent: record.agent,
      kind: record.kind,
      source: record.source,
      value: record.value,
    } satisfies AgentSessionRef);
  }
  return null;
}

function parseAgentSession(value: string | null): AgentSessionRef | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (
      typeof record.agent === "string" &&
      (record.kind === "id" || record.kind === "path") &&
      typeof record.source === "string" &&
      typeof record.value === "string"
    ) {
      return {
        agent: record.agent,
        kind: record.kind,
        source: record.source,
        value: record.value,
      };
    }
  } catch {
    return null;
  }
  return null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
