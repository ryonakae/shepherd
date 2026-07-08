import type { DatabaseSync } from "node:sqlite";
import {
  type AgentStatus,
  type HerdrWorkspaceRecord,
  parseAgentStatus,
} from "@/observability/contracts.js";

export type HerdrWorkspaceLike = Record<string, unknown>;

type HerdrWorkspaceRow = {
  agent_status: AgentStatus;
  focused: 0 | 1;
  herdr_session_name: string;
  label: string | null;
  last_seen_at: number;
  workspace_id: string;
};

export class HerdrWorkspaceStore {
  readonly #sqlite: DatabaseSync;

  constructor(sqlite: DatabaseSync) {
    this.#sqlite = sqlite;
  }

  replaceForSession(input: {
    herdrSessionName: string;
    workspaces: HerdrWorkspaceLike[];
  }): HerdrWorkspaceRecord[] {
    const now = Date.now();
    this.#sqlite
      .prepare("delete from herdr_workspaces where herdr_session_name = ?")
      .run(input.herdrSessionName);
    for (const workspace of input.workspaces) {
      const workspaceId = stringValue(workspace.workspace_id) ?? stringValue(workspace.id);
      if (!workspaceId) continue;
      this.#sqlite
        .prepare(
          `insert into herdr_workspaces
           (herdr_session_name, workspace_id, label, focused, agent_status, last_seen_at)
           values (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.herdrSessionName,
          workspaceId,
          stringValue(workspace.label) ?? stringValue(workspace.name),
          booleanValue(workspace.focused) ? 1 : 0,
          parseAgentStatus(workspace.agent_status),
          now,
        );
    }
    return this.listForSession(input.herdrSessionName);
  }

  listForSession(herdrSessionName: string): HerdrWorkspaceRecord[] {
    const rows = this.#sqlite
      .prepare("select * from herdr_workspaces where herdr_session_name = ? order by workspace_id")
      .all(herdrSessionName) as HerdrWorkspaceRow[];
    return rows.map(mapWorkspace);
  }

  list(): HerdrWorkspaceRecord[] {
    const rows = this.#sqlite
      .prepare("select * from herdr_workspaces order by herdr_session_name, workspace_id")
      .all() as HerdrWorkspaceRow[];
    return rows.map(mapWorkspace);
  }
}

function mapWorkspace(row: HerdrWorkspaceRow): HerdrWorkspaceRecord {
  return {
    agentStatus: row.agent_status,
    focused: row.focused === 1,
    herdrSessionName: row.herdr_session_name,
    label: row.label,
    lastSeenAt: new Date(row.last_seen_at),
    workspaceId: row.workspace_id,
  };
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function booleanValue(value: unknown): boolean {
  return value === true;
}
