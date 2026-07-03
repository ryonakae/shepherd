import type { ObservedWorkspaceStore } from "@/db/observed-workspaces.js";
import type { WorkerEventStore } from "@/db/worker-events.js";
import type { WorkerSnapshotStore } from "@/db/worker-snapshots.js";
import type { WorkerRecord, WorkerStore } from "@/db/workers.js";
import { normalizeHerdrSessionSnapshot } from "@/herdr/session-snapshot.js";
import { resolveObservedWorkspaceFromSnapshot } from "@/herdr/workspace-resolver.js";
import type {
  HerdrControlClientWithSnapshot,
  ObservedWorkspaceRecord,
  WorkerSnapshot,
  WorkerTelemetryEvent,
} from "@/observability/contracts.js";
import { workerIdentityKey } from "@/observability/contracts.js";
import { evaluateWorkerState } from "@/observability/rules.js";
import type { TranscriptAdapter, TranscriptBackfill } from "@/observability/runtime-adapter.js";

export class WorkerStatePipeline {
  readonly #herdrClientForWorkspace: (
    input: ObservedWorkspaceRecord,
  ) => HerdrControlClientWithSnapshot;
  readonly #observedWorkspaces: ObservedWorkspaceStore;
  readonly #snapshots: WorkerSnapshotStore;
  readonly #transcriptAdapters: TranscriptAdapter[];
  readonly #workerEvents: WorkerEventStore;
  readonly #workers: WorkerStore;

  constructor(options: {
    herdrClientForWorkspace(input: ObservedWorkspaceRecord): HerdrControlClientWithSnapshot;
    observedWorkspaces: ObservedWorkspaceStore;
    snapshots: WorkerSnapshotStore;
    transcriptAdapters: TranscriptAdapter[];
    workerEvents: WorkerEventStore;
    workers: WorkerStore;
  }) {
    this.#herdrClientForWorkspace = options.herdrClientForWorkspace;
    this.#observedWorkspaces = options.observedWorkspaces;
    this.#snapshots = options.snapshots;
    this.#transcriptAdapters = options.transcriptAdapters;
    this.#workerEvents = options.workerEvents;
    this.#workers = options.workers;
  }

  async refreshWorkspace(observedWorkspaceId: string): Promise<WorkerSnapshot[]> {
    const observedWorkspace = this.#observedWorkspaces.get(observedWorkspaceId);
    const client = this.#herdrClientForWorkspace(observedWorkspace);
    const snapshot = normalizeHerdrSessionSnapshot(await client.sessionSnapshot());
    const resolution = resolveObservedWorkspaceFromSnapshot({ observedWorkspace, snapshot });
    const resolvedWorkspace = this.#observedWorkspaces.markResolution({
      id: observedWorkspace.id,
      liveWorkspaceId: resolution.liveWorkspaceId,
      ...(resolution.metadata ? { metadata: resolution.metadata } : {}),
      status: resolution.status,
    });
    if (resolution.status !== "active" || !resolution.liveWorkspaceId) {
      return [];
    }

    const agentInfos = snapshot.agents.filter(
      (agent) => agentWorkspaceId(agent) === resolution.liveWorkspaceId,
    );
    const results: WorkerSnapshot[] = [];
    for (const agentInfo of agentInfos) {
      const worker = this.#workers.upsertFromHerdrAgent({
        agent: agentInfoRecord(agentInfo),
        observedWorkspace: resolvedWorkspace,
      });
      results.push(await this.#evaluateAndPersist(worker, { agentInfo }));
    }
    return results;
  }

  async handleHerdrEvent(input: { event: unknown; observedWorkspaceId: string }): Promise<void> {
    const event = record(input.event);
    if (event.type !== "pane.agent_status_changed") {
      return;
    }

    const paneId = stringValue(event.pane_id);
    const observedWorkspace = this.#observedWorkspaces.get(input.observedWorkspaceId);
    const worker = this.#workers
      .listForWorkspace(observedWorkspace.id)
      .find((candidate) => candidate.currentPaneId === paneId);
    if (!worker) {
      return;
    }

    const status = stringValue(event.agent_status);
    if (status) {
      this.#workers.updateStatus({ id: worker.id, status: status as WorkerRecord["status"] });
    }
    await this.#evaluateAndPersist(worker, {
      agentInfo: {
        agent: event.agent,
        agent_status: event.agent_status,
        custom_status: event.custom_status,
        pane_id: event.pane_id,
        workspace_id: event.workspace_id,
      },
    });
  }

  async handleTelemetry(input: {
    event: WorkerTelemetryEvent;
    observedWorkspaceId?: string;
  }): Promise<void> {
    const workspaces = input.observedWorkspaceId
      ? [this.#observedWorkspaces.get(input.observedWorkspaceId)]
      : this.#observedWorkspaces.listActive();
    for (const workspace of workspaces) {
      const worker = this.#resolveTelemetryWorker(workspace.id, input.event);
      if (!worker) {
        continue;
      }
      await this.#evaluateAndPersist(worker, { telemetry: input.event });
      return;
    }
  }

  async #evaluateAndPersist(
    worker: WorkerRecord,
    input: { agentInfo?: unknown; telemetry?: WorkerTelemetryEvent },
  ): Promise<WorkerSnapshot> {
    const previousSnapshot =
      this.#snapshots
        .listCurrent(worker.observedWorkspaceId)
        .find((snapshot) => snapshot.id === worker.id) ??
      ({ id: worker.id, status: worker.status } as WorkerSnapshot);
    const transcript = await this.#readTranscript(worker);
    const result = evaluateWorkerState({
      ...input,
      previousSnapshot,
      ...(transcript ? { transcript } : {}),
      worker: {
        agentName: worker.agentName,
        id: worker.id,
        observedWorkspaceId: worker.observedWorkspaceId,
        sessionRef: worker.agentSession,
      },
    });
    this.#snapshots.putCurrent({
      observedWorkspaceId: worker.observedWorkspaceId,
      snapshot: {
        ...result.snapshot,
        pane: {
          paneId: worker.currentPaneId ?? "",
          tabId: worker.currentTabId,
          workspaceId: worker.currentWorkspaceId,
        },
      },
      workerId: worker.id,
    });
    for (const event of result.events) {
      this.#workerEvents.append({
        idempotencyKey: event.idempotencyKey,
        observedWorkspaceId: worker.observedWorkspaceId,
        payload: event.payload,
        type: event.type,
        workerId: worker.id,
      });
    }
    return result.snapshot;
  }

  async #readTranscript(worker: WorkerRecord): Promise<TranscriptBackfill | undefined> {
    if (!worker.agentSession) {
      return undefined;
    }
    const adapter = this.#transcriptAdapters.find((candidate) =>
      candidate.canRead(worker.agentSession as NonNullable<typeof worker.agentSession>),
    );
    return adapter?.read(worker.agentSession);
  }

  #resolveTelemetryWorker(
    observedWorkspaceId: string,
    event: WorkerTelemetryEvent,
  ): WorkerRecord | undefined {
    if (event.workerKey) {
      const byKey = this.#workers.findByWorkerKey({
        observedWorkspaceId,
        workerKey: event.workerKey,
      });
      if (byKey) {
        return byKey;
      }
    }
    if (event.sessionRef) {
      return this.#workers.findByWorkerKey({
        observedWorkspaceId,
        workerKey: workerIdentityKey({ kind: "agent_session", session: event.sessionRef }),
      });
    }
    return undefined;
  }
}

function agentInfoRecord(
  value: unknown,
): Parameters<WorkerStore["upsertFromHerdrAgent"]>[0]["agent"] {
  return record(value) as Parameters<WorkerStore["upsertFromHerdrAgent"]>[0]["agent"];
}

function agentWorkspaceId(value: unknown): string | null {
  const item = record(value);
  return stringValue(item.workspace_id) ?? stringValue(item.workspaceId);
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
