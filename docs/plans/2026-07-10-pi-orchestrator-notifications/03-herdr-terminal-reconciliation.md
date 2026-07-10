# Herdr Terminal Reconciliation and Cross-Workspace Role Movement Plan

> **For implementers:** Execute this plan task-by-task. Complete each checkbox step, run the listed validation, and commit after each task.

**Status:** Planned

**Goal:** Reconcile registered Pi connections and persisted orchestrator owners after Herdr index refreshes so the role follows the same terminal across pane/workspace movement.

**Architecture:** `AgentIndexService.refreshHerdrSession()` returns the final indexed agents. `HerdrSessionWatchManager` invokes one topology callback after every successful initial/reconnect refresh, including the refresh triggered after `pane.moved`. The RPC server matches active presences and persisted owners by `(herdrSessionName, terminalId)`, updates connection scope/pane metadata, atomically moves owner state when workspace changes, and emits old/new scoped role changes.

**Tech Stack:** TypeScript, Herdr `session.snapshot` and event stream, SQLite agent index, Vitest async iterator tests.

## Global Constraints

- Inherit parent, child 01, and child 02 constraints.
- Do not derive continuity from public pane id; use terminal id.
- Reconciliation is snapshot-driven. Raw `pane.moved` fields may trigger a refresh but are not the source of final identity.
- Reconcile after every successful session refresh so missed/reordered lifecycle events self-heal.
- A move within the same workspace updates owner pane id and presence pane id without resetting cursor.
- A move across workspaces emits an owner-null change in the old scope and owner-present change in the destination.
- Destination owner replacement follows normal claim semantics and last successful movement wins.
- A non-owner Pi presence also updates to its new scope so later status/on commands and telemetry use the correct workspace.
- Missing terminals are not immediately released by topology reconciliation; socket disconnect/startup grace owns absence expiry and avoids transient snapshot races.

## Current Context

- `AgentIndexService.refreshHerdrSession()` currently returns `Promise<void>` despite already collecting final indexed agents.
- `HerdrSessionWatchManager.#watch()` refreshes before subscribing, handles status events inline, and breaks/restarts for `pane.moved` and other topology events.
- `AgentStore` will preserve terminal identity after child 01.
- The current shepherd-pi process environment cannot change after a cross-workspace move; the daemon must return/stream updated presence scope.

## File Structure

- Modify: `src/observability/agent-index-service.ts` — return indexed agents from refresh.
- Modify: `src/daemon/herdr-session-watch-manager.ts` — topology callback after refresh.
- Modify: `src/daemon/observability-server.ts` — `reconcileAgentLocations()` for presences and owners.
- Modify: `src/daemon/service.ts` — wire watch callback to server reconciliation.
- Modify: `test/unit/herdr-session-watch-manager.test.ts` — refresh callback ordering and pane move restart.
- Create: `test/integration/orchestrator-pane-move.test.ts` — same-workspace and cross-workspace movement.
- Modify: `test/integration/observability-rpc.test.ts` — status responses expose updated presence.

## Interfaces

Update index/watch contracts:

```ts
// AgentIndexService
async refreshHerdrSession(input: {
  herdrSessionName: string;
  sessionDir: string;
  socketPath: string;
}): Promise<AgentIndexRecord[]>;

// HerdrSessionWatchManager options
onAgentIndexRefreshed(input: {
  agents: AgentIndexRecord[];
  herdrSessionName: string;
}): void;
```

Add server method:

```ts
reconcileAgentLocations(input: {
  agents: AgentIndexRecord[];
  herdrSessionName: string;
}): void;
```

## Tasks

### Task 1: Publish Final Agent Index After Every Herdr Refresh

**Objective:** Give downstream role reconciliation one stable snapshot boundary.

**Files:**
- Modify: `src/observability/agent-index-service.ts`
- Modify: `src/daemon/herdr-session-watch-manager.ts`
- Modify: `test/unit/herdr-session-watch-manager.test.ts`

**Interfaces:**
- Produces: `onAgentIndexRefreshed` callback.
- Consumes: terminal-stable `AgentStore.replaceForSession()`.

- [ ] **Step 1: Write failing watch-manager tests**

Add tests using a scripted async iterator:

1. Initial refresh returns agents and calls `onAgentIndexRefreshed` before the first `subscribeEvents()` call.
2. A yielded `{ type: "pane.moved" }` causes the current subscription to end, a second refresh, a second callback with changed pane/workspace, and then resubscription.
3. `pane.agent_status_changed` does not invoke topology callback unless its recovery `refresh` path actually runs.
4. Callback receives the Herdr session name supplied by `session list`.

Record operation order and assert an exact sequence such as:

```ts
expect(operations).toEqual([
  "refresh:1",
  "reconcile:wA:p1",
  "subscribe:1",
  "refresh:2",
  "reconcile:wB:p3",
  "subscribe:2",
]);
```

- [ ] **Step 2: Run red test**

Run: `pnpm test test/unit/herdr-session-watch-manager.test.ts`

Expected: refresh returns void and the manager has no topology callback.

- [ ] **Step 3: Return agents and invoke callback**

Return the `agents` array already produced by `replaceForSession()`. In every manager refresh site, await the result and synchronously call `onAgentIndexRefreshed` before deriving pane ids/subscribing. Provide a default no-op only if existing isolated tests need compatibility; daemon construction must pass the real callback explicitly.

- [ ] **Step 4: Run focused tests**

Run: `pnpm test test/unit/herdr-session-watch-manager.test.ts`

Expected: ordering and reconnect tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/observability/agent-index-service.ts src/daemon/herdr-session-watch-manager.ts test/unit/herdr-session-watch-manager.test.ts
git commit -m "feat(orchestrator): expose herdr topology refresh"
```

### Task 2: Reconcile Active Pi Presence by Terminal

**Objective:** Keep every registered Pi connection's current pane/workspace accurate after Herdr moves.

**Files:**
- Modify: `src/daemon/observability-server.ts`
- Modify: `src/daemon/service.ts`
- Create: `test/integration/orchestrator-pane-move.test.ts`

**Interfaces:**
- Consumes: `reconcileAgentLocations()` input and `PiPresence` registry.
- Produces: updated presence returned by get/set/ack and role streams.

- [ ] **Step 1: Write failing presence movement tests**

Register Pi A at `default/wA:p1/term_A`, replace the indexed agent snapshot with `default/wB:p3/term_A`, call `server.reconcileAgentLocations()`, then assert:

```ts
await expect(client.request("agent.orchestrator.get", {})).resolves.toMatchObject({
  presence: {
    herdrSessionName: "default",
    paneId: "wB:p3",
    terminalId: "term_A",
    workspaceId: "wB",
  },
});
```

Also test:

- non-owner presence moves and can claim only the new scope;
- same-workspace pane move updates only `paneId`;
- a terminal absent from one refresh retains its last presence until disconnect handling;
- another Herdr session with the same terminal id does not affect the connection.

- [ ] **Step 2: Run red test**

Run: `pnpm test test/integration/orchestrator-pane-move.test.ts`

Expected: presence remains at launch-time scope.

- [ ] **Step 3: Update presence registry from indexed terminals**

Build a map keyed by exact `herdrSessionName + terminalId`. For each presence in that Herdr session, if an indexed record exists, replace `paneId` and `workspaceId` while retaining socket, subscriber id, autoResume, terminal id, and connection time. Do not update from agent name or cwd.

Wire `HerdrSessionWatchManager.onAgentIndexRefreshed` in `src/daemon/service.ts` to `server.reconcileAgentLocations(input)`.

- [ ] **Step 4: Run movement and RPC tests**

Run: `pnpm test test/integration/orchestrator-pane-move.test.ts test/integration/observability-rpc.test.ts`

Expected: presence status reflects current Herdr topology.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/observability-server.ts src/daemon/service.ts test/integration/orchestrator-pane-move.test.ts test/integration/observability-rpc.test.ts
git commit -m "feat(orchestrator): reconcile pi terminal location"
```

### Task 3: Move Persisted Owner and Broadcast Both Scopes

**Objective:** Follow the owner terminal into its destination workspace and replace any destination owner.

**Files:**
- Modify: `src/daemon/observability-server.ts`
- Modify: `test/integration/orchestrator-pane-move.test.ts`

**Interfaces:**
- Consumes: `AgentOrchestratorService.move()` and updated presence registry.
- Produces: old/new `agent.orchestrator.changed` streams.

- [ ] **Step 1: Add failing owner movement cases**

Use registered sockets in `wA` and `wB` and assert:

1. Owner A moves from `wA` to empty `wB`: old state owner null, new state owner A at new pane.
2. Connected Pi remaining in `wA` receives only the old-scope null change.
3. Connected Pi in `wB` receives the new-scope owner change.
4. Moving owner socket receives enough change data to set itself on and update current scope.
5. Existing owner B in destination is replaced and receives a transient off change naming A.
6. Source and destination cursors retain independent values.
7. Same-workspace pane move updates owner pane and broadcasts one `moved` change only if public owner information changed.
8. Repeating reconciliation with unchanged topology emits no duplicate role change.
9. Events in old workspace stop reaching A; events in new workspace reach A; self-terminal events in new workspace remain excluded.

- [ ] **Step 2: Run tests to verify red**

Run: `pnpm test test/integration/orchestrator-pane-move.test.ts`

Expected: persistent owner remains in old scope or destination owner is not replaced.

- [ ] **Step 3: Reconcile owner after presence locations**

For each persisted owner in the refreshed Herdr session:

- find indexed agent by owner terminal;
- if absent, leave it for grace expiry;
- if pane/workspace unchanged, do nothing;
- if only pane changed, claim/update same scope without cursor reset and publish one `moved` change;
- if workspace changed, call `service.move()` exactly once and publish returned changes after DB commit.

Update all presence locations before publishing changes so scope filtering reaches the moved owner and destination peers correctly.

- [ ] **Step 4: Run all topology tests**

Run: `pnpm test test/integration/orchestrator-pane-move.test.ts test/unit/herdr-session-watch-manager.test.ts test/integration/orchestrator-disconnect-grace.test.ts`

Expected: all movement and grace behavior passes.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/observability-server.ts test/integration/orchestrator-pane-move.test.ts
git commit -m "feat(orchestrator): follow moved herdr terminals"
```

## Validation

- `pnpm test test/unit/herdr-session-watch-manager.test.ts`
- `pnpm test test/integration/orchestrator-pane-move.test.ts`
- `pnpm test test/integration/observability-rpc.test.ts test/integration/orchestrator-disconnect-grace.test.ts`
- `pnpm typecheck`

## Risks, Tradeoffs, and Open Questions

- Cross-workspace movement can replace a destination owner without that owner issuing a command. This is an explicit product decision; the destination owner must receive the role change immediately.
- Pi process environment remains stale after a move. Child 04 must update its in-memory current scope from registration/get/role-change responses and use that for telemetry/context.
- Snapshot reconciliation may run repeatedly. Every operation must be idempotent to prevent repeated UI notifications.
- No product questions remain for this child plan.

## Next Steps

After terminal movement tests pass, continue with [shepherd-pi extension and UX](04-pi-extension-ux.md).
