import type { DatabaseSync } from "node:sqlite";
import type { AgentOrchestratorState, AgentScope } from "@/observability/contracts.js";

export type AgentOrchestratorScopeKey = AgentScope;

export type ClaimOrchestratorInput = AgentOrchestratorScopeKey & {
  initialAckedEventId: number;
  paneId: string;
  terminalId: string;
};

type ScopeRow = {
  acked_event_id: number;
  created_at: number;
  herdr_session_name: string;
  owner_pane_id: string | null;
  owner_terminal_id: string | null;
  updated_at: number;
  workspace_id: string;
};

type ScopeChange = {
  current: AgentOrchestratorState;
  previous: AgentOrchestratorState;
};

export class AgentOrchestratorScopeStore {
  readonly #sqlite: DatabaseSync;

  constructor(sqlite: DatabaseSync) {
    this.#sqlite = sqlite;
  }

  get(scope: AgentOrchestratorScopeKey): AgentOrchestratorState | undefined {
    const row = this.#getRow(scope);
    return row ? mapScope(row) : undefined;
  }

  listOwned(): AgentOrchestratorState[] {
    const rows = this.#sqlite
      .prepare(
        `select * from agent_orchestrator_scopes
         where owner_terminal_id is not null
         order by herdr_session_name, workspace_id`,
      )
      .all() as ScopeRow[];
    return rows.map(mapScope);
  }

  listOwnedForSession(herdrSessionName: string): AgentOrchestratorState[] {
    const rows = this.#sqlite
      .prepare(
        `select * from agent_orchestrator_scopes
         where herdr_session_name = ? and owner_terminal_id is not null`,
      )
      .all(herdrSessionName) as ScopeRow[];
    return rows.map(mapScope);
  }

  claim(input: ClaimOrchestratorInput): ScopeChange {
    return this.#transaction(() => this.#claim(input));
  }

  releaseIfOwner(input: AgentOrchestratorScopeKey & { terminalId: string }): {
    changed: boolean;
    current: AgentOrchestratorState | undefined;
    previous: AgentOrchestratorState | undefined;
  } {
    return this.#transaction(() => {
      const row = this.#getRow(input);
      if (!row || row.owner_terminal_id !== input.terminalId) {
        return { changed: false, current: row ? mapScope(row) : undefined, previous: undefined };
      }
      const previous = mapScope(row);
      const now = Date.now();
      this.#sqlite
        .prepare(
          `update agent_orchestrator_scopes
           set owner_pane_id = null, owner_terminal_id = null, updated_at = ?
           where herdr_session_name = ? and workspace_id = ?`,
        )
        .run(now, input.herdrSessionName, input.workspaceId);
      const current = this.get(input);
      if (!current) throw new Error("Orchestrator scope disappeared during release");
      return { changed: true, current, previous };
    });
  }

  moveOwner(input: {
    from: AgentOrchestratorScopeKey;
    initialTargetAckedEventId: number;
    paneId: string;
    terminalId: string;
    to: AgentOrchestratorScopeKey;
  }): ScopeChange[] {
    return this.#transaction(() => {
      const sourceRow = this.#getRow(input.from);
      if (!sourceRow || sourceRow.owner_terminal_id !== input.terminalId) {
        throw new Error("Only the current orchestrator can move ownership");
      }
      const sourcePrevious = mapScope(sourceRow);
      const now = Date.now();
      this.#sqlite
        .prepare(
          `update agent_orchestrator_scopes
           set owner_pane_id = null, owner_terminal_id = null, updated_at = ?
           where herdr_session_name = ? and workspace_id = ?`,
        )
        .run(now, input.from.herdrSessionName, input.from.workspaceId);
      const sourceCurrent = this.get(input.from);
      if (!sourceCurrent) throw new Error("Orchestrator source disappeared during move");
      const target = this.#claim({
        ...input.to,
        initialAckedEventId: input.initialTargetAckedEventId,
        paneId: input.paneId,
        terminalId: input.terminalId,
      });
      return [{ current: sourceCurrent, previous: sourcePrevious }, target];
    });
  }

  ack(
    input: AgentOrchestratorScopeKey & { eventId: number; terminalId: string },
  ): AgentOrchestratorState {
    return this.#transaction(() => {
      const row = this.#getRow(input);
      if (!row || row.owner_terminal_id !== input.terminalId) {
        throw new Error("Only the current orchestrator can acknowledge notifications");
      }
      const now = Date.now();
      this.#sqlite
        .prepare(
          `update agent_orchestrator_scopes
           set acked_event_id = max(acked_event_id, ?), updated_at = ?
           where herdr_session_name = ? and workspace_id = ?`,
        )
        .run(input.eventId, now, input.herdrSessionName, input.workspaceId);
      const current = this.get(input);
      if (!current) throw new Error("Orchestrator scope disappeared during acknowledgement");
      return current;
    });
  }

  #claim(input: ClaimOrchestratorInput): ScopeChange {
    const row = this.#getRow(input);
    const now = Date.now();
    if (!row) {
      this.#sqlite
        .prepare(
          `insert into agent_orchestrator_scopes
           (herdr_session_name, workspace_id, acked_event_id, owner_pane_id, owner_terminal_id, created_at, updated_at)
           values (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.herdrSessionName,
          input.workspaceId,
          input.initialAckedEventId,
          input.paneId,
          input.terminalId,
          now,
          now,
        );
      const current = this.get(input);
      if (!current) throw new Error("Failed to create orchestrator scope");
      return { current, previous: { ...current, owner: null } };
    }
    const previous = mapScope(row);
    this.#sqlite
      .prepare(
        `update agent_orchestrator_scopes
         set owner_pane_id = ?, owner_terminal_id = ?, updated_at = ?
         where herdr_session_name = ? and workspace_id = ?`,
      )
      .run(input.paneId, input.terminalId, now, input.herdrSessionName, input.workspaceId);
    const current = this.get(input);
    if (!current) throw new Error("Orchestrator scope disappeared during claim");
    return { current, previous };
  }

  #getRow(scope: AgentOrchestratorScopeKey): ScopeRow | undefined {
    return this.#sqlite
      .prepare(
        `select * from agent_orchestrator_scopes
         where herdr_session_name = ? and workspace_id = ?`,
      )
      .get(scope.herdrSessionName, scope.workspaceId) as ScopeRow | undefined;
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

function mapScope(row: ScopeRow): AgentOrchestratorState {
  if ((row.owner_pane_id === null) !== (row.owner_terminal_id === null)) {
    throw new Error("Corrupt orchestrator scope owner identity");
  }
  return {
    ackedEventId: row.acked_event_id,
    herdrSessionName: row.herdr_session_name,
    owner:
      row.owner_pane_id === null || row.owner_terminal_id === null
        ? null
        : { paneId: row.owner_pane_id, terminalId: row.owner_terminal_id },
    updatedAt: new Date(row.updated_at),
    workspaceId: row.workspace_id,
  };
}
