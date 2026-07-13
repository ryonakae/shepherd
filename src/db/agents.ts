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
    const snapshots = input.agents.flatMap((agent) => {
      const paneId = stringValue(agent.pane_id) ?? stringValue(agent.paneId);
      const workspaceId = stringValue(agent.workspace_id) ?? stringValue(agent.workspaceId);
      if (!paneId || !workspaceId) return [];
      return [
        {
          agent,
          paneId,
          terminalId: stringValue(agent.terminal_id) ?? stringValue(agent.terminalId),
          workspaceId,
        },
      ];
    });

    return this.#transaction(() => {
      const existing = this.listForHerdrSession(input.herdrSessionName);
      const byPane = new Map(existing.map((agent) => [agent.paneId, agent]));
      const byTerminal = new Map(
        existing.flatMap((agent) => (agent.terminalId ? [[agent.terminalId, agent] as const] : [])),
      );
      const matched = snapshots.map((snapshot) => ({
        existing:
          (snapshot.terminalId ? byTerminal.get(snapshot.terminalId) : undefined) ??
          byPane.get(snapshot.paneId),
        snapshot,
      }));
      const temporaryPaneIds = new Set<string>();
      for (const { existing: current, snapshot } of matched) {
        if (current && current.paneId !== snapshot.paneId) temporaryPaneIds.add(current.id);
        const occupant = byPane.get(snapshot.paneId);
        if (occupant && occupant.id !== current?.id) temporaryPaneIds.add(occupant.id);
      }
      for (const id of temporaryPaneIds) {
        this.#sqlite
          .prepare("update agents set pane_id = ? where id = ?")
          .run(`__shepherd_moving__:${id}`, id);
      }

      const retainedIds: string[] = [];
      for (const { existing: current, snapshot } of matched) {
        const id = current?.id ?? `ag_${randomUUID()}`;
        retainedIds.push(id);
        const values = [
          snapshot.paneId,
          snapshot.terminalId,
          stringValue(snapshot.agent.tab_id) ?? stringValue(snapshot.agent.tabId),
          snapshot.workspaceId,
          stringValue(snapshot.agent.agent),
          parseAgentStatus(snapshot.agent.agent_status),
          agentSessionJson(snapshot.agent.agent_session),
          stringValue(snapshot.agent.cwd),
          stringValue(snapshot.agent.foreground_cwd) ?? stringValue(snapshot.agent.foregroundCwd),
          snapshot.agent.focused === true ? 1 : 0,
          now,
        ];
        if (current) {
          this.#sqlite
            .prepare(
              `update agents
               set pane_id = ?, terminal_id = ?, tab_id = ?, workspace_id = ?, agent = ?,
                   agent_status = ?, agent_session_json = ?, cwd = ?, foreground_cwd = ?,
                   focused = ?, last_seen_at = ?
               where id = ?`,
            )
            .run(...values, id);
        } else {
          this.#sqlite
            .prepare(
              `insert into agents
               (id, herdr_session_name, pane_id, terminal_id, tab_id, workspace_id, agent, agent_status, agent_session_json, cwd, foreground_cwd, focused, first_seen_at, last_seen_at)
               values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(id, input.herdrSessionName, ...values, now);
        }
      }

      if (retainedIds.length === 0) {
        this.#sqlite
          .prepare("delete from agents where herdr_session_name = ?")
          .run(input.herdrSessionName);
      } else {
        const placeholders = retainedIds.map(() => "?").join(", ");
        this.#sqlite
          .prepare(
            `delete from agents where herdr_session_name = ? and id not in (${placeholders})`,
          )
          .run(input.herdrSessionName, ...retainedIds);
      }
      return this.listForHerdrSession(input.herdrSessionName);
    });
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
    const clauses = ["sessions.running = 1"];
    const params: Array<number | string | null> = [];
    if (!scope.all && scope.herdrSessionName) {
      clauses.push("agents.herdr_session_name = ?");
      params.push(scope.herdrSessionName);
    }
    if (!scope.all && scope.workspaceId) {
      clauses.push("agents.workspace_id = ?");
      params.push(scope.workspaceId);
    }
    if (scope.all && scope.herdrSessionName) {
      clauses.push("agents.herdr_session_name = ?");
      params.push(scope.herdrSessionName);
    }
    const where = ` where ${clauses.join(" and ")}`;
    const rows = this.#sqlite
      .prepare(
        `select agents.*
         from agents
         inner join herdr_sessions as sessions
           on sessions.name = agents.herdr_session_name
         ${where}
         order by agents.herdr_session_name, agents.workspace_id, agents.pane_id`,
      )
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

  findByTerminal(input: {
    herdrSessionName: string;
    terminalId: string;
  }): AgentIndexRecord | undefined {
    const row = this.#sqlite
      .prepare("select * from agents where herdr_session_name = ? and terminal_id = ?")
      .get(input.herdrSessionName, input.terminalId) as AgentRow | undefined;
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

  #transaction<T>(operation: () => T): T {
    this.#sqlite.exec("begin immediate");
    try {
      const result = operation();
      this.#sqlite.exec("commit");
      return result;
    } catch (error) {
      this.#sqlite.exec("rollback");
      throw error;
    }
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
