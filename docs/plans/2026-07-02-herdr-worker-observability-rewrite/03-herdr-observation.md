# Herdr Observation and Resolution

Parent: [2026-07-02-herdr-worker-observability-rewrite.md](../2026-07-02-herdr-worker-observability-rewrite.md)

## Status

Not started.

## Progress

- Not started — Task 3 and Task 4.

## Next steps

- Execute the first unchecked step in this child plan after all earlier child plans are complete.

## Objective

Align the Herdr socket client with the current raw API and keep observed workspaces stable across live id changes.

## Scope

Task 3 and Task 4.

### Task 3: Correct Herdr Socket Client and Add Snapshot Support

**Objective:** Make Shepherd's Herdr client match current Herdr raw API and support `session.snapshot`.

**Files:**
- Modify: `src/herdr/socket-client.ts`
- Modify: `src/herdr/managed-socket-client.ts`
- Create: `src/herdr/session-snapshot.ts`
- Test: `test/integration/herdr-socket-client.test.ts`
- Test: `test/integration/managed-herdr-socket-client.test.ts`

**Interfaces:**
- Consumes: Herdr socket API.
- Produces: `sessionSnapshot()`, corrected `subscribeEvents()`, corrected pane methods for downstream resolver and pipeline.

- [ ] **Step 1: Write failing tests**

Update `test/integration/herdr-socket-client.test.ts` to assert raw requests use current Herdr method names:

```text
pane.send_input for command/text input where raw input is needed
pane.wait_for_output for output waits
session.snapshot for snapshots
events.subscribe with params { subscriptions: [...] }
```

Add a test that `sessionSnapshot()` returns the raw `snapshot` result.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test test/integration/herdr-socket-client.test.ts test/integration/managed-herdr-socket-client.test.ts`

Expected: existing client sends stale method names such as `pane.run`, `agent.wait`, or `wait.output`, or lacks `sessionSnapshot()`.

- [ ] **Step 3: Implement current Herdr methods**

Update client methods:

```ts
sessionSnapshot(): Promise<unknown> {
  return this.request("session.snapshot");
}

sendPaneInput(params: { pane_id: string; text: string }): Promise<unknown> {
  return this.request("pane.send_input", { pane_id: params.pane_id, text: params.text });
}

waitForOutput(params: {
  lines?: number;
  match: string;
  pane_id: string;
  regex?: boolean;
  source?: "recent" | "recent-unwrapped" | "visible";
  timeout_ms?: number;
}): Promise<unknown> {
  return this.request("pane.wait_for_output", {
    pane_id: params.pane_id,
    source: params.source ?? "recent",
    ...(params.lines !== undefined ? { lines: params.lines } : {}),
    match: params.regex === true ? { type: "regex", value: params.match } : { type: "substring", value: params.match },
    ...(params.timeout_ms !== undefined ? { timeout_ms: params.timeout_ms } : {}),
  });
}
```

For `events.subscribe`, do not use wildcard pane ids. The MVP subscription contract is pane-specific for agent status and workspace-wide for lifecycle events. `subscribeEvents({ workspaceId, paneIds })` must send:

```ts
await this.request("events.subscribe", {
  subscriptions: [
    { type: "workspace.updated" },
    { type: "workspace.renamed" },
    { type: "workspace.moved" },
    { type: "workspace.closed" },
    { type: "tab.created" },
    { type: "tab.closed" },
    { type: "tab.moved" },
    { type: "pane.created" },
    { type: "pane.closed" },
    { type: "pane.moved" },
    { type: "pane.exited" },
    { type: "pane.agent_detected" },
    ...params.paneIds.map((pane_id) => ({ type: "pane.agent_status_changed" as const, pane_id })),
  ],
});
```

`WorkerStatePipeline.refreshWorkspace()` must call `agent.list`, collect pane ids for the observed workspace, and restart the subscription when the pane id set changes.

- [ ] **Step 4: Add snapshot types**

Create `src/herdr/session-snapshot.ts` with narrow runtime guards:

```ts
export type HerdrSessionSnapshot = {
  agents: unknown[];
  focusedPaneId?: string;
  focusedWorkspaceId?: string;
  panes: unknown[];
  tabs: unknown[];
  workspaces: unknown[];
};

export function normalizeHerdrSessionSnapshot(value: unknown): HerdrSessionSnapshot {
  const record = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const snapshot = typeof record.snapshot === "object" && record.snapshot !== null ? (record.snapshot as Record<string, unknown>) : record;
  return {
    agents: Array.isArray(snapshot.agents) ? snapshot.agents : [],
    focusedPaneId: typeof snapshot.focused_pane_id === "string" ? snapshot.focused_pane_id : undefined,
    focusedWorkspaceId: typeof snapshot.focused_workspace_id === "string" ? snapshot.focused_workspace_id : undefined,
    panes: Array.isArray(snapshot.panes) ? snapshot.panes : [],
    tabs: Array.isArray(snapshot.tabs) ? snapshot.tabs : [],
    workspaces: Array.isArray(snapshot.workspaces) ? snapshot.workspaces : [],
  };
}
```

- [ ] **Step 5: Run tests**

Run: `pnpm test test/integration/herdr-socket-client.test.ts test/integration/managed-herdr-socket-client.test.ts`

Expected: tests pass and captured raw method names match current Herdr API.

- [ ] **Step 6: Commit**

```bash
git add src/herdr/socket-client.ts src/herdr/managed-socket-client.ts src/herdr/session-snapshot.ts test/integration/herdr-socket-client.test.ts test/integration/managed-herdr-socket-client.test.ts
git commit -m "fix(herdr): align socket client with current API"
```

### Task 4: Implement Observed Workspace Resolution

**Objective:** Keep `observedWorkspaceId` stable while tracking Herdr live workspace and pane ids through events and snapshots.

**Files:**
- Create: `src/herdr/workspace-resolver.ts`
- Test: `test/unit/herdr-workspace-resolver.test.ts`

**Interfaces:**
- Consumes: `ObservedWorkspaceStore`, `WorkerStore`, Herdr event envelopes, normalized session snapshots.
- Produces: resolver functions used by `WorkerStatePipeline` and daemon startup.

- [ ] **Step 1: Write failing tests**

Create tests for:

1. `pane.moved` updates worker live pane identity from `previous_pane_id` to `pane.pane_id`.
2. `workspace.moved` keeps the same observed workspace active when `workspace_id` is unchanged and stores the latest workspace list metadata.
3. Startup re-resolution finds a workspace by `worktree.checkout_path`.
4. Startup re-resolution falls back to label only when there is exactly one matching label.
5. Startup re-resolution returns `ambiguous` when multiple labels match.
6. Startup re-resolution returns `missing` when no workspace matches.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test test/unit/herdr-workspace-resolver.test.ts`

Expected: module missing.

- [ ] **Step 3: Implement resolver**

Create functions:

```ts
export function applyHerdrEventToBindings(input: {
  event: unknown;
  observedWorkspace: ObservedWorkspaceRecord;
  observedWorkspaces: ObservedWorkspaceStore;
  workers: WorkerStore;
}): void;

export function resolveObservedWorkspaceFromSnapshot(input: {
  observedWorkspace: ObservedWorkspaceRecord;
  snapshot: HerdrSessionSnapshot;
}): { liveWorkspaceId: string | null; metadata?: ObservedWorkspaceMetadata; status: ObservedWorkspaceStatus };
```

Resolution order must be:

1. exact live workspace id still exists
2. exact `metadata.worktree.checkoutPath` match against `workspace.worktree.checkout_path`
3. exact `metadata.workspaceCwd` match against pane cwd or worktree checkout path when available
4. exact `metadata.label` match only when a single workspace has that label
5. ambiguous/missing

- [ ] **Step 4: Run tests**

Run: `pnpm test test/unit/herdr-workspace-resolver.test.ts`

Expected: all resolver tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/herdr/workspace-resolver.ts test/unit/herdr-workspace-resolver.test.ts
git commit -m "feat(herdr): resolve observed workspaces"
```

