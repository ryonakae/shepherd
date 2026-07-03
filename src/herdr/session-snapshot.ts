export type HerdrSessionSnapshot = {
  agents: unknown[];
  focusedPaneId?: string;
  focusedWorkspaceId?: string;
  panes: unknown[];
  tabs: unknown[];
  workspaces: unknown[];
};

export function normalizeHerdrSessionSnapshot(value: unknown): HerdrSessionSnapshot {
  const record =
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const snapshot =
    typeof record.snapshot === "object" && record.snapshot !== null
      ? (record.snapshot as Record<string, unknown>)
      : record;

  return {
    agents: Array.isArray(snapshot.agents) ? snapshot.agents : [],
    ...(typeof snapshot.focused_pane_id === "string"
      ? { focusedPaneId: snapshot.focused_pane_id }
      : {}),
    ...(typeof snapshot.focused_workspace_id === "string"
      ? { focusedWorkspaceId: snapshot.focused_workspace_id }
      : {}),
    panes: Array.isArray(snapshot.panes) ? snapshot.panes : [],
    tabs: Array.isArray(snapshot.tabs) ? snapshot.tabs : [],
    workspaces: Array.isArray(snapshot.workspaces) ? snapshot.workspaces : [],
  };
}
