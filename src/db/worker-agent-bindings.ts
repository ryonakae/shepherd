import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type WorkerAgentRole = "general" | "implementation" | "research" | "review" | "test";
export type WorkerAgentStatus = "blocked" | "done" | "idle" | "unknown" | "working";
export type WorkerBindingHealth = "error" | "missing" | "present" | "starting";

export type WorkerAgentBindingRecord = {
  agentName: string;
  agentProfile: string;
  agentStatus: WorkerAgentStatus;
  bindingHealth: WorkerBindingHealth;
  createdAt: Date;
  description: string | null;
  herdrSessionName: string;
  id: string;
  lastSeenAt: Date | null;
  lastTask: string | null;
  metadata: unknown;
  paneId: string;
  role: WorkerAgentRole;
  sessionId: string;
  tabId: string | null;
  updatedAt: Date;
  workspaceId: string;
};

export type UpsertWorkerAgentBindingInput = {
  agentName: string;
  agentProfile: string;
  agentStatus?: WorkerAgentStatus;
  bindingHealth?: WorkerBindingHealth;
  description?: string | null;
  herdrSessionName: string;
  lastTask?: string | null;
  metadata?: unknown;
  paneId: string;
  role: WorkerAgentRole;
  sessionId: string;
  tabId?: string | null;
  workspaceId: string;
};

type WorkerAgentBindingRow = {
  agent_name: string;
  agent_profile: string;
  agent_status: WorkerAgentStatus;
  binding_health: WorkerBindingHealth;
  created_at: number;
  description: string | null;
  herdr_session_name: string;
  id: string;
  last_seen_at: number | null;
  last_task: string | null;
  metadata_json: string | null;
  pane_id: string;
  role: WorkerAgentRole;
  session_id: string;
  tab_id: string | null;
  updated_at: number;
  workspace_id: string;
};

const roles = new Set<WorkerAgentRole>(["general", "implementation", "research", "review", "test"]);
const statuses = new Set<WorkerAgentStatus>(["blocked", "done", "idle", "unknown", "working"]);
const healthValues = new Set<WorkerBindingHealth>(["error", "missing", "present", "starting"]);

export class WorkerAgentBindingStore {
  readonly #sqlite: DatabaseSync;

  constructor(sqlite: DatabaseSync) {
    this.#sqlite = sqlite;
  }

  upsertBinding(input: UpsertWorkerAgentBindingInput): WorkerAgentBindingRecord {
    validateRole(input.role);
    const agentStatus = input.agentStatus ?? "unknown";
    const bindingHealth = input.bindingHealth ?? "starting";
    validateStatus(agentStatus);
    validateHealth(bindingHealth);

    const now = Date.now();
    const existing = this.#findByAgentName({
      agentName: input.agentName,
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
    });

    if (existing) {
      this.#sqlite
        .prepare(
          `update worker_agent_bindings
           set herdr_session_name = ?, agent_profile = ?, role = ?, description = ?, last_task = ?, pane_id = ?, tab_id = ?, agent_status = ?, binding_health = ?, metadata_json = ?, updated_at = ?, last_seen_at = ?
           where id = ?`,
        )
        .run(
          input.herdrSessionName,
          input.agentProfile,
          input.role,
          input.description ?? null,
          input.lastTask ?? null,
          input.paneId,
          input.tabId ?? null,
          agentStatus,
          bindingHealth,
          stringifyMetadata(input.metadata),
          now,
          now,
          existing.id,
        );

      return this.getById(existing.id);
    }

    const id = randomUUID();
    this.#sqlite
      .prepare(
        `insert into worker_agent_bindings
          (id, session_id, herdr_session_name, workspace_id, agent_name, agent_profile, role, description, last_task, pane_id, tab_id, agent_status, binding_health, metadata_json, created_at, updated_at, last_seen_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.sessionId,
        input.herdrSessionName,
        input.workspaceId,
        input.agentName,
        input.agentProfile,
        input.role,
        input.description ?? null,
        input.lastTask ?? null,
        input.paneId,
        input.tabId ?? null,
        agentStatus,
        bindingHealth,
        stringifyMetadata(input.metadata),
        now,
        now,
        now,
      );

    return this.getById(id);
  }

  getById(id: string): WorkerAgentBindingRecord {
    const row = this.#sqlite
      .prepare("select * from worker_agent_bindings where id = ?")
      .get(id) as WorkerAgentBindingRow | undefined;
    if (!row) {
      throw new Error(`Worker agent binding not found: ${id}`);
    }

    return mapWorkerAgentBinding(row);
  }

  getByAgentName(input: {
    agentName: string;
    sessionId: string;
    workspaceId: string;
  }): WorkerAgentBindingRecord {
    const row = this.#findByAgentName(input);
    if (!row) {
      throw new Error("Worker agent binding not found");
    }

    return mapWorkerAgentBinding(row);
  }

  listForSession(sessionId: string): WorkerAgentBindingRecord[] {
    const rows = this.#sqlite
      .prepare(
        "select * from worker_agent_bindings where session_id = ? order by updated_at desc, id desc",
      )
      .all(sessionId) as WorkerAgentBindingRow[];

    return rows.map(mapWorkerAgentBinding);
  }

  updateObservedState(input: {
    agentName: string;
    agentStatus?: WorkerAgentStatus;
    bindingHealth?: WorkerBindingHealth;
    metadata?: unknown;
    sessionId: string;
    workspaceId: string;
  }): WorkerAgentBindingRecord {
    if (input.agentStatus !== undefined) {
      validateStatus(input.agentStatus);
    }
    if (input.bindingHealth !== undefined) {
      validateHealth(input.bindingHealth);
    }

    const current = this.getByAgentName(input);
    const now = Date.now();
    this.#sqlite
      .prepare(
        `update worker_agent_bindings
         set agent_status = ?, binding_health = ?, metadata_json = ?, updated_at = ?, last_seen_at = ?
         where id = ?`,
      )
      .run(
        input.agentStatus ?? current.agentStatus,
        input.bindingHealth ?? current.bindingHealth,
        input.metadata === undefined ? stringifyMetadata(current.metadata) : stringifyMetadata(input.metadata),
        now,
        now,
        current.id,
      );

    return this.getById(current.id);
  }

  #findByAgentName(input: {
    agentName: string;
    sessionId: string;
    workspaceId: string;
  }): WorkerAgentBindingRow | undefined {
    return this.#sqlite
      .prepare(
        "select * from worker_agent_bindings where session_id = ? and workspace_id = ? and agent_name = ?",
      )
      .get(input.sessionId, input.workspaceId, input.agentName) as
      | WorkerAgentBindingRow
      | undefined;
  }
}

function validateRole(value: string): asserts value is WorkerAgentRole {
  if (!roles.has(value as WorkerAgentRole)) {
    throw new Error(`Invalid worker agent role: ${value}`);
  }
}

function validateStatus(value: string): asserts value is WorkerAgentStatus {
  if (!statuses.has(value as WorkerAgentStatus)) {
    throw new Error(`Invalid worker agent status: ${value}`);
  }
}

function validateHealth(value: string): asserts value is WorkerBindingHealth {
  if (!healthValues.has(value as WorkerBindingHealth)) {
    throw new Error(`Invalid worker binding health: ${value}`);
  }
}

function stringifyMetadata(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

function mapWorkerAgentBinding(row: WorkerAgentBindingRow): WorkerAgentBindingRecord {
  return {
    agentName: row.agent_name,
    agentProfile: row.agent_profile,
    agentStatus: row.agent_status,
    bindingHealth: row.binding_health,
    createdAt: new Date(row.created_at),
    description: row.description,
    herdrSessionName: row.herdr_session_name,
    id: row.id,
    lastSeenAt: row.last_seen_at === null ? null : new Date(row.last_seen_at),
    lastTask: row.last_task,
    metadata: row.metadata_json === null ? null : JSON.parse(row.metadata_json),
    paneId: row.pane_id,
    role: row.role,
    sessionId: row.session_id,
    tabId: row.tab_id,
    updatedAt: new Date(row.updated_at),
    workspaceId: row.workspace_id,
  };
}
