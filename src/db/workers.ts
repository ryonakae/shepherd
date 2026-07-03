import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  AgentSessionRef,
  ObservedWorkspaceRecord,
  WorkerStatus,
} from "@/observability/contracts.js";
import { workerIdentityKey } from "@/observability/contracts.js";

export type WorkerRecord = {
  agentName: string | null;
  agentSession: AgentSessionRef | null;
  currentPaneId: string | null;
  currentTabId: string | null;
  currentWorkspaceId: string | null;
  firstSeenAt: Date;
  id: string;
  identityKind: "agent_session" | "live_pane";
  lastSeenAt: Date;
  metadata: unknown;
  observedWorkspaceId: string;
  runtime: string | null;
  status: WorkerStatus;
  updatedAt: Date;
  workerKey: string;
};

export type HerdrAgentLike = {
  agent?: string | null;
  agent_session?: AgentSessionRef | null;
  agent_status?: string | null;
  custom_status?: string | null;
  foreground_cwd?: string | null;
  pane_id?: string | null;
  tab_id?: string | null;
  workspace_id?: string | null;
};

export type UpsertWorkerFromHerdrAgentInput = {
  agent: HerdrAgentLike;
  metadata?: unknown;
  observedWorkspace: ObservedWorkspaceRecord;
};

type WorkerRow = {
  agent_name: string | null;
  agent_session_json: string | null;
  current_pane_id: string | null;
  current_tab_id: string | null;
  current_workspace_id: string | null;
  first_seen_at: number;
  id: string;
  identity_kind: "agent_session" | "live_pane";
  last_seen_at: number;
  metadata_json: string;
  observed_workspace_id: string;
  runtime: string | null;
  status: WorkerStatus;
  updated_at: number;
  worker_key: string;
};

const workerStatuses = new Set<WorkerStatus>(["blocked", "done", "idle", "unknown", "working"]);

export class WorkerStore {
  readonly #sqlite: DatabaseSync;

  constructor(sqlite: DatabaseSync) {
    this.#sqlite = sqlite;
  }

  upsertFromHerdrAgent(input: UpsertWorkerFromHerdrAgentInput): WorkerRecord {
    const agent = input.agent;
    const sessionRef = agent.agent_session ?? null;
    const identityKind = sessionRef ? "agent_session" : "live_pane";
    const paneId = agent.pane_id ?? null;
    const workspaceId = agent.workspace_id ?? input.observedWorkspace.liveWorkspaceId;
    if (!sessionRef && (!paneId || !workspaceId)) {
      throw new Error("Cannot create live pane worker identity without pane and workspace ids");
    }

    const fallbackIdentity = {
      paneId: paneId as string,
      workspaceId: workspaceId as string,
      ...(input.observedWorkspace.herdrSessionName
        ? { herdrSessionName: input.observedWorkspace.herdrSessionName }
        : {}),
      ...(input.observedWorkspace.socketPath
        ? { socketPath: input.observedWorkspace.socketPath }
        : {}),
    };
    const workerKey = sessionRef
      ? workerIdentityKey({ kind: "agent_session", session: sessionRef })
      : workerIdentityKey({ fallback: fallbackIdentity, kind: "live_pane" });
    const status = parseWorkerStatus(agent.agent_status);
    const now = Date.now();
    const existing = this.findByWorkerKey({
      observedWorkspaceId: input.observedWorkspace.id,
      workerKey,
    });

    if (existing) {
      this.#sqlite
        .prepare(
          `update workers
           set agent_session_json = ?, current_pane_id = ?, current_tab_id = ?, current_workspace_id = ?, agent_name = ?, runtime = ?, status = ?, metadata_json = ?, last_seen_at = ?, updated_at = ?
           where id = ?`,
        )
        .run(
          sessionRef ? JSON.stringify(sessionRef) : null,
          paneId,
          agent.tab_id ?? null,
          workspaceId,
          agent.agent ?? null,
          sessionRef?.agent ?? agent.agent ?? null,
          status,
          JSON.stringify(input.metadata ?? { herdr: agent }),
          now,
          now,
          existing.id,
        );

      return this.get(existing.id);
    }

    const id = `wk_${randomUUID()}`;
    this.#sqlite
      .prepare(
        `insert into workers
          (id, observed_workspace_id, worker_key, identity_kind, agent_session_json, current_pane_id, current_tab_id, current_workspace_id, agent_name, runtime, status, metadata_json, first_seen_at, last_seen_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.observedWorkspace.id,
        workerKey,
        identityKind,
        sessionRef ? JSON.stringify(sessionRef) : null,
        paneId,
        agent.tab_id ?? null,
        workspaceId,
        agent.agent ?? null,
        sessionRef?.agent ?? agent.agent ?? null,
        status,
        JSON.stringify(input.metadata ?? { herdr: agent }),
        now,
        now,
        now,
      );

    return this.get(id);
  }

  updateLiveIdentity(input: {
    id: string;
    paneId: string | null;
    tabId: string | null;
    workspaceId: string | null;
  }): WorkerRecord {
    const now = Date.now();
    this.#sqlite
      .prepare(
        "update workers set current_pane_id = ?, current_tab_id = ?, current_workspace_id = ?, updated_at = ?, last_seen_at = ? where id = ?",
      )
      .run(input.paneId, input.tabId, input.workspaceId, now, now, input.id);

    return this.get(input.id);
  }

  updateStatus(input: { id: string; status: WorkerStatus }): WorkerRecord {
    validateWorkerStatus(input.status);
    const now = Date.now();
    this.#sqlite
      .prepare("update workers set status = ?, updated_at = ?, last_seen_at = ? where id = ?")
      .run(input.status, now, now, input.id);

    return this.get(input.id);
  }

  listForWorkspace(observedWorkspaceId: string): WorkerRecord[] {
    const rows = this.#sqlite
      .prepare(
        "select * from workers where observed_workspace_id = ? order by updated_at desc, id desc",
      )
      .all(observedWorkspaceId) as WorkerRow[];

    return rows.map(mapWorker);
  }

  get(id: string): WorkerRecord {
    const row = this.#sqlite.prepare("select * from workers where id = ?").get(id) as
      | WorkerRow
      | undefined;
    if (!row) {
      throw new Error(`Worker not found: ${id}`);
    }

    return mapWorker(row);
  }

  findByWorkerKey(input: {
    observedWorkspaceId: string;
    workerKey: string;
  }): WorkerRecord | undefined {
    const row = this.#sqlite
      .prepare("select * from workers where observed_workspace_id = ? and worker_key = ?")
      .get(input.observedWorkspaceId, input.workerKey) as WorkerRow | undefined;

    return row ? mapWorker(row) : undefined;
  }
}

function parseWorkerStatus(value: string | null | undefined): WorkerStatus {
  return workerStatuses.has(value as WorkerStatus) ? (value as WorkerStatus) : "unknown";
}

function validateWorkerStatus(value: string): asserts value is WorkerStatus {
  if (!workerStatuses.has(value as WorkerStatus)) {
    throw new Error(`Invalid worker status: ${value}`);
  }
}

function mapWorker(row: WorkerRow): WorkerRecord {
  return {
    agentName: row.agent_name,
    agentSession: row.agent_session_json
      ? (JSON.parse(row.agent_session_json) as AgentSessionRef)
      : null,
    currentPaneId: row.current_pane_id,
    currentTabId: row.current_tab_id,
    currentWorkspaceId: row.current_workspace_id,
    firstSeenAt: new Date(row.first_seen_at),
    id: row.id,
    identityKind: row.identity_kind,
    lastSeenAt: new Date(row.last_seen_at),
    metadata: JSON.parse(row.metadata_json),
    observedWorkspaceId: row.observed_workspace_id,
    runtime: row.runtime,
    status: row.status,
    updatedAt: new Date(row.updated_at),
    workerKey: row.worker_key,
  };
}
