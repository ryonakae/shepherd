import type { HerdrSessionSnapshot } from "@/herdr/session-snapshot.js";
import type {
  ObservedWorkspaceMetadata,
  ObservedWorkspaceRecord,
  ObservedWorkspaceStatus,
} from "@/observability/contracts.js";

type EventRecord = Record<string, unknown>;
type WorkspaceLike = Record<string, unknown>;
type PaneLike = Record<string, unknown>;
type WorkerLiveIdentityRecord = { currentPaneId: string | null; id: string };
type ObservedWorkspaceResolutionStore = {
  markResolution(input: {
    id: string;
    liveWorkspaceId: string | null;
    metadata?: ObservedWorkspaceMetadata;
    status: ObservedWorkspaceStatus;
  }): unknown;
};
type WorkerLiveIdentityStore = {
  listForWorkspace(observedWorkspaceId: string): WorkerLiveIdentityRecord[];
  updateLiveIdentity(input: {
    id: string;
    paneId: string | null;
    tabId: string | null;
    workspaceId: string | null;
  }): unknown;
};

export function applyHerdrEventToBindings(input: {
  event: unknown;
  observedWorkspace: ObservedWorkspaceRecord;
  observedWorkspaces: ObservedWorkspaceResolutionStore;
  workers: WorkerLiveIdentityStore;
}): void {
  const event = asRecord(input.event);
  const type = stringValue(event.type);

  if (type === "pane.moved") {
    const previousPaneId = stringValue(event.previous_pane_id);
    const pane = asRecord(event.pane);
    const nextPaneId = stringValue(pane.pane_id) ?? stringValue(pane.id);
    if (!previousPaneId || !nextPaneId) {
      return;
    }

    const worker = input.workers
      .listForWorkspace(input.observedWorkspace.id)
      .find((candidate) => candidate.currentPaneId === previousPaneId);
    if (!worker) {
      return;
    }

    input.workers.updateLiveIdentity({
      id: worker.id,
      paneId: nextPaneId,
      tabId: stringValue(pane.tab_id) ?? null,
      workspaceId: stringValue(pane.workspace_id) ?? null,
    });
    return;
  }

  if (type === "workspace.moved") {
    const workspace = asRecord(event.workspace);
    const workspaceId = stringValue(workspace.id) ?? stringValue(workspace.workspace_id);
    if (workspaceId !== input.observedWorkspace.liveWorkspaceId) {
      return;
    }

    input.observedWorkspaces.markResolution({
      id: input.observedWorkspace.id,
      liveWorkspaceId: workspaceId,
      metadata: metadataFromWorkspace(workspace, input.observedWorkspace.metadata),
      status: "active",
    });
  }
}

export function resolveObservedWorkspaceFromSnapshot(input: {
  observedWorkspace: ObservedWorkspaceRecord;
  snapshot: HerdrSessionSnapshot;
}): {
  liveWorkspaceId: string | null;
  metadata?: ObservedWorkspaceMetadata;
  status: ObservedWorkspaceStatus;
} {
  const workspaces = input.snapshot.workspaces.map(asRecord);

  const byCurrentId = workspaces.find(
    (workspace) => workspaceId(workspace) === input.observedWorkspace.liveWorkspaceId,
  );
  if (byCurrentId) {
    return activeResult(byCurrentId, input.observedWorkspace.metadata);
  }

  const checkoutPath = input.observedWorkspace.metadata.worktree?.checkoutPath;
  if (checkoutPath) {
    const byCheckout = workspaces.find(
      (workspace) => workspaceCheckoutPath(workspace) === checkoutPath,
    );
    if (byCheckout) {
      return activeResult(byCheckout, input.observedWorkspace.metadata);
    }
  }

  const workspaceCwd = input.observedWorkspace.metadata.workspaceCwd;
  if (workspaceCwd) {
    const byCwd = workspaces.find(
      (workspace) =>
        workspaceCheckoutPath(workspace) === workspaceCwd ||
        workspacePaneCwds(workspace).includes(workspaceCwd),
    );
    if (byCwd) {
      return activeResult(byCwd, input.observedWorkspace.metadata);
    }
  }

  const label = input.observedWorkspace.metadata.label;
  if (label) {
    const matches = workspaces.filter((workspace) => workspaceLabel(workspace) === label);
    if (matches.length === 1) {
      return activeResult(matches[0] as WorkspaceLike, input.observedWorkspace.metadata);
    }
    if (matches.length > 1) {
      return { liveWorkspaceId: null, status: "ambiguous" };
    }
  }

  return { liveWorkspaceId: null, status: "missing" };
}

function activeResult(
  workspace: WorkspaceLike,
  previousMetadata: ObservedWorkspaceMetadata,
): { liveWorkspaceId: string | null; metadata: ObservedWorkspaceMetadata; status: "active" } {
  return {
    liveWorkspaceId: workspaceId(workspace),
    metadata: metadataFromWorkspace(workspace, previousMetadata),
    status: "active",
  };
}

function metadataFromWorkspace(
  workspace: WorkspaceLike,
  previousMetadata: ObservedWorkspaceMetadata,
): ObservedWorkspaceMetadata {
  const checkoutPath = workspaceCheckoutPath(workspace);
  const label = workspaceLabel(workspace) ?? previousMetadata.label;
  return {
    ...previousMetadata,
    ...(label ? { label } : {}),
    ...(checkoutPath ? { workspaceCwd: checkoutPath } : {}),
  };
}

function workspaceId(workspace: WorkspaceLike): string | null {
  return stringValue(workspace.id) ?? stringValue(workspace.workspace_id) ?? null;
}

function workspaceLabel(workspace: WorkspaceLike): string | null {
  return stringValue(workspace.label) ?? stringValue(workspace.name) ?? null;
}

function workspaceCheckoutPath(workspace: WorkspaceLike): string | null {
  const worktree = asRecord(workspace.worktree);
  return stringValue(worktree.checkout_path) ?? stringValue(worktree.checkoutPath) ?? null;
}

function workspacePaneCwds(workspace: WorkspaceLike): string[] {
  const panes = Array.isArray(workspace.panes) ? (workspace.panes as unknown[]).map(asRecord) : [];
  return panes
    .map((pane: PaneLike) => stringValue(pane.foreground_cwd) ?? stringValue(pane.cwd))
    .filter((value): value is string => typeof value === "string");
}

function asRecord(value: unknown): EventRecord {
  return typeof value === "object" && value !== null ? (value as EventRecord) : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
