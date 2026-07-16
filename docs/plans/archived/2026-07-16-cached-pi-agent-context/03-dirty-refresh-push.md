# Dirty-Pane Refresh, Adaptive Revision Polling, Cached Agent List, and Owner Push Plan

> **For implementers:** Execute this plan task-by-task. Complete each checkbox step, run the listed validation, and commit after each task.

**Status:** Completed

**Goal:** Refresh only dirty agents, poll working sessions at 10 seconds with a 60-second full recovery scan, serve `agent.list` from persisted context, and push owner-filtered snapshots over the existing Pi socket.

**Architecture:** `AgentIndexService` compares Herdr pane revisions and identity fields against persisted/indexed state, asks `AgentContextService` to refresh only missing/dirty agents, and reports changed scopes. `HerdrSessionWatchManager` uses one serialized 10-second scheduler: five active-only ticks followed by a 60-second full rescan/re-subscribe tick. `ObservabilityRpcServer` serves cached list data, includes owner context in connection-state responses, and streams `agent.context.changed` only to the newest socket of the current owner terminal.

**Tech Stack:** TypeScript, Vitest fake timers, Node Unix sockets, existing Herdr socket client, SQLite context service.

## Global Constraints

- Inherit every constraint from the parent plan and children 01–02.
- `ACTIVE_REVISION_POLL_MS = 10_000` and `FULL_RESCAN_MS = 60_000` are exact exported/tested constants.
- Use one serialized scheduler; do not create one uncoordinated `setInterval` per agent.
- At the 60-second boundary, run one full rescan, not an active poll plus a second full refresh.
- A working-only tick calls Herdr only for sessions whose indexed agents contain at least one `agentStatus === "working"`.
- Full rescan retains current responsibilities: discover running/stopped Herdr sessions, recover missed topology events, rebuild subscriptions, refresh revisions, and reconcile owner locations.
- `AgentIndexService` serializes all index/context mutations for the same Herdr session: scheduled/full refresh, `pane.agent_status_changed`, and Pi presence session-hint refresh. Duplicate refresh requests share an in-flight result only when no status/hint mutation has been enqueued between them.
- Dirty means: no persisted context, pane revision is null, pane revision changed (including reset/decrease), or agent identity inputs changed. Status events call a targeted refresh regardless of revision equality.
- Identity inputs are exactly `agent`, `agentSession`, `cwd`, `foregroundCwd`, and stable terminal id. Focus/tab/workspace/pane movement alone does not force history rediscovery; movement still updates metadata/routing.
- Coalesce context notifications by `(herdrSessionName, workspaceId)` after all dirty agents in one refresh complete. Mark a scope changed for compact-history changes or context-visible metadata changes: agent add/remove, status, pane, terminal, or workspace movement. Movement/removal includes the prior scope.
- `agent.list` uses cached `AgentContextService.listAgents()`. It performs no history service calls.
- `agent.get` and `agent.read` retain live stat/read behavior and pass the persisted history ref as their preferred ref.
- Context stream payloads go only to the owner socket and exclude the owner terminal. Role-change broadcasts remain scoped to all registered Pi sockets as before.
- Presence registration persists every Pi `sessionRef`, but context is returned/pushed only if that presence is the owner.
- Do not change event cursor initialization, event self-filtering, wake outcome projection, or ack validation.

## Current Context

- `AgentIndexService.refreshHerdrSession()` currently refreshes compact history for every agent before checking whether status changed.
- `handleHerdrEvent()` already targets one pane for `pane.agent_status_changed`, but it does not persist a reusable latest context row or notify a context stream.
- `HerdrSessionWatchManager` currently starts with a full rescan, uses a 60-second interval, aborts/restarts existing watchers on every rescan, and reconnects event streams after structural events.
- `HerdrSocketClient.sessionSnapshot()` exposes revisions in Herdr `agents[]` and `panes[]`. `normalizeHerdrSessionSnapshot()` returns both arrays separately, so index refresh must overlay `panes[].revision` by pane id when an agent record omits revision.
- `ObservabilityRpcServer.agent.list` currently calls `history.getCompactHistory()` for every row.
- `#connectionState()` currently returns presence, owner state, and pending events only.
- `publishAgentEvent()` already locates the newest owner socket with stable terminal identity; context push should reuse that routing model.

## File Structure

- Modify: `src/observability/agent-index-service.ts` — dirty detection, per-session mutation queue, targeted context refresh, and changed-scope results.
- Modify: `test/integration/agent-index-service.test.ts` — dirty-pane call counts, identity invalidation, immediate status refresh, scope coalescing.
- Modify: `src/daemon/herdr-session-watch-manager.ts` — non-overlapping 10-second scheduler, 60-second full rescan, working-session selection, and ordered result publication.
- Modify: `test/unit/herdr-session-watch-manager.test.ts` — exact fake-timer cadence, no duplicate 60-second refresh, stopped/structural recovery.
- Modify: `src/daemon/observability-server.ts` — cached list, session-ref ingestion, owner context responses, context stream routing.
- Modify: `test/integration/observability-rpc.test.ts` — cached list/live get-read and owner/non-owner context response tests.
- Modify: `test/integration/orchestrator-pane-move.test.ts` — old-owner clearing and destination-owner context after movement.
- Modify: `test/integration/orchestrator-disconnect-grace.test.ts` — reconnect registration restores owner context.
- Modify: `src/daemon/service.ts` — inject shared context service and changed-scope callback.
- Modify: `packages/shepherd-pi/src/daemon-client.ts` type declarations only if needed to compile integration fixtures; behavioral client work is in child 04.

## Interfaces

Export scheduler constants from `src/daemon/herdr-session-watch-manager.ts`:

```ts
export const ACTIVE_REVISION_POLL_MS = 10_000;
export const FULL_RESCAN_MS = 60_000;
```

Replace callback-based index output with explicit results so the watch manager can reconcile locations before pushing context:

```ts
export type AgentIndexRefreshResult = {
  agents: AgentIndexRecord[];
  contextChangedScopes: AgentScope[];
  events: AgentEventRecord[];
};

export type AgentEventHandlingResult = {
  contextChangedScopes: AgentScope[];
  events: AgentEventRecord[];
};

export type PiSessionRefRegistrationResult = {
  agent: AgentIndexRecord | undefined;
  contextChangedScopes: AgentScope[];
};

refreshHerdrSession(input: {
  herdrSessionName: string;
  sessionDir: string;
  socketPath: string;
}): Promise<AgentIndexRefreshResult>;

handleHerdrEvent(input: {
  event: unknown;
  herdrSessionName: string;
  sessionDir: string;
  socketPath: string;
}): Promise<AgentEventHandlingResult>;

registerPiSessionRef(input: {
  herdrSessionName: string;
  sessionRef: AgentSessionRef;
  terminalId: string;
}): Promise<PiSessionRefRegistrationResult>;
```

Extend `HerdrSessionWatchManager` options:

```ts
{
  activeRevisionPollMs?: number; // default ACTIVE_REVISION_POLL_MS
  fullRescanMs?: number; // default FULL_RESCAN_MS
  onAgentContextChanged?(scope: AgentScope): void;
  // existing options remain
}
```

Extend connection-state results in `ObservabilityRpcServer` and Pi wire types:

```ts
type AgentOrchestratorConnectionStateResult = {
  context: AgentWorkspaceContextSnapshot | null;
  events: AgentEventRecord[];
  presence: PiPresence;
  state: AgentOrchestratorWireState | null;
};
```

Add this stream message:

```ts
{
  method: "agent.context.changed";
  params: {
    context: AgentWorkspaceContextSnapshot | null;
    herdrSessionName: string;
    workspaceId: string;
  };
}
```

## Tasks

### Task 1: Refresh Only Missing or Dirty Agents During Session Snapshots

**Objective:** Make a full Herdr snapshot cheap when pane revisions and agent identity are unchanged.

**Files:**
- Modify: `src/observability/agent-index-service.ts`
- Modify: `test/integration/agent-index-service.test.ts`

**Interfaces:**
- Consumes: `AgentContextService.refreshAgent()` and snapshot store state.
- Produces: dirty-agent refresh and changed-scope coalescing.

- [x] **Step 1: Write failing dirty-refresh tests**

Use a two-agent Herdr snapshot with revisions `claude=10`, `codex=20` and a fake context service that records agent ids. Assert this sequence:

1. First refresh has no persisted contexts and calls `refreshAgent()` for both agents.
2. Second identical refresh calls it zero times.
3. Third refresh changes only Claude revision to `11`; only Claude is refreshed.
4. Fourth refresh changes Codex cwd with revision still `20`; only Codex is refreshed with `identityChanged: true`.
5. A pane move changes Claude pane/workspace but preserves terminal, runtime, cwd, session ref, and revision; history refresh is not forced, but the result includes both old and new workspace scopes so publication removes it from the old snapshot and adds it to the new one.
6. Removing an agent includes the prior workspace in `contextChangedScopes` even though there is no current agent to refresh; adding an agent includes the current workspace.
7. A status-only change includes the workspace even when compact history is byte-for-byte unchanged.
8. Agent-record revision is used when present; if it is absent but the matching `panes[]` record has revision, that pane revision is persisted and used for dirty detection.
9. A null revision refreshes that agent on each full rescan; a numeric revision reset/decrease is dirty and reaches the history invalidation matrix.
10. If both dirty agents belong to the same workspace, `contextChangedScopes` contains it once after both complete.
11. If dirty agents span two workspaces, `contextChangedScopes` contains each scope once in stable workspace-id order.
12. A missed `working -> idle` transition still emits one status event using the newly persisted compact history.
13. Two concurrent `refreshHerdrSession()` calls before another mutation share one in-flight refresh.
14. If a status operation is enqueued behind an older refresh, a subsequent refresh uses the new mutation epoch and queues after status rather than reusing the old promise.
15. A delayed old refresh, then status update, then later refresh completes in invocation order and leaves the newest status/context in SQLite.
16. `registerPiSessionRef()` queued during a delayed refresh is serialized; a later refresh uses the post-hint epoch, and the Herdr-reported-over-hint effective ref remains authoritative.

Update the snapshot fixture to include exact revisions:

```ts
{
  agent: "claude",
  agent_status: status,
  cwd: "/repo",
  foreground_cwd: "/repo",
  pane_id: "wJ:p2",
  revision: 10,
  tab_id: "wJ:t1",
  terminal_id: "term_claude",
  workspace_id: "wJ",
}
```

- [x] **Step 2: Run the index test to verify red**

Run: `pnpm test test/integration/agent-index-service.test.ts`

Expected: current implementation refreshes every agent on identical snapshots and returns no changed-scope result.

- [x] **Step 3: Inject `AgentContextService` and compare pre/post index state**

Replace the direct history dependency with the shared context service. Add per-session serialization state to `AgentIndexService`:

```ts
readonly #mutationEpochBySession = new Map<string, number>();
readonly #refreshInFlightBySession = new Map<
  string,
  { epoch: number; promise: Promise<AgentIndexRefreshResult> }
>();
readonly #sessionOperationTail = new Map<string, Promise<void>>();
```

`refreshHerdrSession()` captures the current mutation epoch and reuses an in-flight refresh only when its epoch matches. `handleHerdrEvent()` and `registerPiSessionRef()` synchronously increment the session epoch before enqueueing, creating a barrier that prevents a later refresh from reusing an older promise. Queue operations with this helper:

```ts
#enqueueSessionOperation<T>(sessionName: string, operation: () => Promise<T>): Promise<T> {
  const prior = this.#sessionOperationTail.get(sessionName) ?? Promise.resolve();
  const result = prior.catch(() => undefined).then(operation);
  const tail = result.then(() => undefined, () => undefined);
  this.#sessionOperationTail.set(sessionName, tail);
  void tail.finally(() => {
    if (this.#sessionOperationTail.get(sessionName) === tail) {
      this.#sessionOperationTail.delete(sessionName);
    }
  });
  return result;
}
```

Public wrappers call private `#refreshHerdrSessionNow`, `#handleHerdrEventNow`, and `#registerPiSessionRefNow`. Implement the refresh/barrier rules exactly:

```ts
// refreshHerdrSession
const epoch = this.#mutationEpochBySession.get(sessionName) ?? 0;
const existing = this.#refreshInFlightBySession.get(sessionName);
if (existing?.epoch === epoch) return existing.promise;
const promise = this.#enqueueSessionOperation(sessionName, () =>
  this.#refreshHerdrSessionNow(input),
);
this.#refreshInFlightBySession.set(sessionName, { epoch, promise });
const clear = () => {
  if (this.#refreshInFlightBySession.get(sessionName)?.promise === promise) {
    this.#refreshInFlightBySession.delete(sessionName);
  }
};
void promise.then(clear, clear);
return promise;
```

Before enqueueing `handleHerdrEvent()` or `registerPiSessionRef()`, increment `#mutationEpochBySession` synchronously. Therefore a refresh requested after either mutation cannot reuse an older-epoch promise and is appended after that mutation. When an event references an unknown pane, `#handleHerdrEventNow` calls `#refreshHerdrSessionNow({ herdrSessionName, sessionDir, socketPath })` directly using the event input while it already owns the queue; it must not recursively call the public queued method.

Inside `#refreshHerdrSessionNow`, retain previous rows by terminal/pane and build `revisionByPane` from `snapshot.panes`. Copy the matching pane revision onto an agent record only when `agents[].revision` is absent. After replacement, for each current agent:

```ts
const prior =
  (agent.terminalId ? previousByTerminal.get(agent.terminalId) : undefined) ??
  previousByPane.get(agent.paneId);
const identityChanged =
  !prior ||
  prior.agent !== agent.agent ||
  prior.terminalId !== agent.terminalId ||
  prior.cwd !== agent.cwd ||
  prior.foregroundCwd !== agent.foregroundCwd ||
  !sameAgentSession(prior.agentSession, agent.agentSession);
const cached = snapshotStore.get(agent.id);
const dirty =
  !cached ||
  agent.paneRevision === null ||
  cached.paneRevision !== agent.paneRevision ||
  identityChanged;
```

Call `context.refreshAgent({ agent, identityChanged })` only when dirty. Build a `Set` of changed scopes from `result.changed` **and** context-visible metadata differences. Compare previous/current agents by stable terminal first and pane fallback only under child 01's terminal rules. Add the prior scope for removed/moved agents and the current scope for added/moved/status/pane/terminal changes. Return scopes in stable `(herdrSessionName, workspaceId)` order after persistence finishes. Collect missed status-transition events in agent order and return them in `events`; do not publish callbacks from inside the index service. Use the refreshed snapshot's compact history for those events, or the persisted row when context content was unchanged.

- [x] **Step 4: Run index/context tests**

Run: `pnpm test test/integration/agent-index-service.test.ts test/integration/agent-context-service.test.ts`

Expected: exact dirty call counts and existing repeated-cycle events pass.

- [x] **Step 5: Commit**

```bash
git add src/observability/agent-index-service.ts test/integration/agent-index-service.test.ts
git commit -m "perf(observability): refresh only dirty agent contexts"
```

### Task 2: Refresh Context Immediately on Agent Status Events

**Objective:** Update the affected agent context and owner snapshot before publishing idle/done/blocked events.

**Files:**
- Modify: `src/observability/agent-index-service.ts`
- Modify: `test/integration/agent-index-service.test.ts`

**Interfaces:**
- Consumes: Task 1 dirty refresh.
- Produces: targeted event-driven context updates.

- [x] **Step 1: Add failing status-event assertions**

Add tests proving:

1. `pane.agent_status_changed` for Claude calls `refreshAgent()` once even if pane revision equals the persisted snapshot revision.
2. Codex in the same workspace is not refreshed.
3. The returned `agent.done`/`agent.idle` event contains the compact history returned by that targeted refresh.
4. The result includes scope `{ herdrSessionName: "default", workspaceId: "wJ" }` whenever `from !== to`, even when compact history did not change.
5. A duplicate status with no state or context change returns `events: []` and no changed scope.
6. An unknown-pane status runs one in-queue full refresh and does not recursively enqueue or deadlock. If the pane was previously unindexed, synthesize `from: "unknown"` and assert the triggering done/idle/blocked transition is returned and persisted exactly once; if recovery already emitted an event for the same agent/type/target status, it is not duplicated.

- [x] **Step 2: Run the index test to verify red**

Run: `pnpm test test/integration/agent-index-service.test.ts`

Expected: changed-scope result or targeted refresh assertions fail.

- [x] **Step 3: Implement targeted context refresh**

After `updateStatus()`, call:

```ts
const refreshed = await this.#context.refreshAgent({
  agent: current,
  identityChanged: false,
});
const contextChangedScopes = refreshed.changed || from !== to
  ? [{ herdrSessionName: current.herdrSessionName, workspaceId: current.workspaceId }]
  : [];
```

Pass `refreshed.snapshot.compactHistory` into event creation and return it as a one-element `events` array. Preserve the existing early return for unchanged `from/to`; still refresh context first so a final transcript flush can update cached content without creating a duplicate status event. For an unknown pane, run `#refreshHerdrSessionNow()` once, re-resolve the pane, and compare refresh-derived events against the triggering transition by agent id, mapped event type, and target `to` status. Herdr supplies only the new `agent_status`, so use `from: "unknown"` when synthesizing a transition for a previously unindexed pane. If no equivalent event exists, create and persist the triggering event from the re-resolved agent and its persisted refreshed compact snapshot, then append it after refresh-derived events. If an equivalent exists, keep only the refresh-derived event. Return the unioned stable scopes and events so recovery neither loses nor duplicates completion notifications.

- [x] **Step 4: Run index tests to verify green**

Run: `pnpm test test/integration/agent-index-service.test.ts`

Expected: status, context ordering, and duplicate suppression tests pass.

- [x] **Step 5: Commit**

```bash
git add src/observability/agent-index-service.ts test/integration/agent-index-service.test.ts
git commit -m "feat(observability): refresh context on agent status events"
```

### Task 3: Replace the Watcher Interval with a Serialized Adaptive Scheduler

**Objective:** Refresh working sessions every 10 seconds, all running sessions every 60 seconds, and never double-refresh at the 60-second boundary.

**Files:**
- Modify: `src/daemon/herdr-session-watch-manager.ts`
- Modify: `test/unit/herdr-session-watch-manager.test.ts`

**Interfaces:**
- Consumes: Task 1/2 index callbacks.
- Produces: exact adaptive cadence and ordered publication of index results; Task 1's `AgentIndexService` owns per-session mutation serialization.

- [x] **Step 1: Write fake-timer cadence tests**

Use `vi.useFakeTimers()` and injected `activeRevisionPollMs: 10`, `fullRescanMs: 60` to keep tests fast. Prove:

1. Startup performs one full refresh per running session.
2. A session containing `working` refreshes at 10, 20, 30, 40, and 50 ms.
3. An all-idle session does not refresh at those ticks.
4. At 60 ms both working and idle sessions receive exactly one full refresh/re-subscribe; working does not receive a second active refresh.
5. A status event changing idle to working makes the next 10 ms tick refresh that session.
6. If a scheduler tick remains pending across later timer firings, only one tick runs; `AgentIndexService` tests from Task 1 prove refresh/status/hint mutation order.
7. `stop()` clears the scheduler, aborts event subscriptions, and awaits scheduler/subscription work.
8. Manual `rescanNow()` still marks missing sessions stopped and restarts changed watchers.
9. Structural `pane.moved/created/closed/agent_detected/workspace.closed` restart behavior remains unchanged.

- [x] **Step 2: Run watcher tests to verify red**

Run: `pnpm test test/unit/herdr-session-watch-manager.test.ts`

Expected: current 60-second-only interval fails adaptive cadence assertions.

- [x] **Step 3: Implement one 10-second scheduler**

Replace `#intervalMs/#interval` with:

```ts
readonly #activeRevisionPollMs: number;
readonly #fullRescanMs: number;
#scheduler: NodeJS.Timeout | undefined;
#lastFullRescanAt = 0;
#tickInFlight: Promise<void> | undefined;
```

After startup full rescan, schedule a tick every active interval. Serialize ticks:

```ts
async #tick(): Promise<void> {
  const elapsed = Date.now() - this.#lastFullRescanAt;
  if (elapsed >= this.#fullRescanMs) {
    await this.rescanNow();
    return;
  }
  const workingSessions = [...this.#watchers.values()].filter(({ entry }) =>
    this.#agents
      .listForHerdrSession(entry.name)
      .some((agent) => agent.agentStatus === "working"),
  );
  await Promise.all(workingSessions.map(({ entry }) => this.#refresh(entry)));
}
```

Wrap timer ticks so a pending tick is reused. `#refresh(entry)` calls serialized `index.refreshHerdrSession()`, uses `result.agents.map((agent) => agent.paneId)` when rebuilding subscription pane ids, and processes `AgentIndexRefreshResult` in this exact order: `onAgentIndexRefreshed` (owner/presence reconciliation), then `onAgentContextChanged` for each scope, then `onAgentEvent` for each missed transition. In the subscription loop, pass `entry.sessionDir/socketPath` to serialized `index.handleHerdrEvent()`, then process `AgentEventHandlingResult.contextChangedScopes` before publishing its `events` in returned order. Set `#lastFullRescanAt` only after a successful `rescanNow()` finishes. Index serialization prevents delayed scheduler results from overwriting newer status/hint mutations; the watcher controls only cadence and publication ordering.

- [x] **Step 4: Run watcher and index tests**

Run: `pnpm test test/unit/herdr-session-watch-manager.test.ts test/integration/agent-index-service.test.ts`

Expected: cadence, non-overlapping ticks, reconnect, index serialization, and event tests pass.

- [x] **Step 5: Commit**

```bash
git add src/daemon/herdr-session-watch-manager.ts test/unit/herdr-session-watch-manager.test.ts
git commit -m "perf(daemon): poll revisions only for working sessions"
```

### Task 4: Add Owner-Only Context Responses and Push

**Objective:** Deliver current cached context to the active owner on registration/claim/get/reconnect and stream later changes only to that owner.

**Files:**
- Modify: `src/daemon/observability-server.ts`
- Modify: `src/daemon/service.ts`
- Modify: `test/integration/observability-rpc.test.ts`
- Modify: `test/integration/orchestrator-pane-move.test.ts`
- Modify: `test/integration/orchestrator-disconnect-grace.test.ts`

**Interfaces:**
- Consumes: `AgentContextService.workspaceSnapshot()`, Task 3 changed-scope callback, and registration `sessionRef`.
- Produces: `context` connection-state field and `agent.context.changed` stream.

- [x] **Step 1: Write failing multi-socket routing tests**

Extend the real-socket RPC integration setup with owner Pi, off Pi in the same workspace, and Pi in another workspace. Assert:

1. Non-owner registration includes `context: null`.
2. `agent.orchestrator.set({ enabled: true })` returns owner-filtered context to the claimant.
3. The same owner `get` and reconnect registration return the current context.
4. Updating workspace `wB` sends one `agent.context.changed` only to the newest owner socket in `wB`.
5. The off Pi and other-workspace Pi receive no context stream.
6. The pushed snapshot excludes owner `terminalId` but retains another Pi terminal.
7. Direct owner replacement sends context to the new owner's set response; the old owner receives only the existing role-change stream and no later context.
8. Releasing owner returns `context: null` and later context updates are not streamed.
9. Removing/moving the last non-owner agent sends an `agent.context.changed` event with matching scope and `context: null`, allowing the owner to clear its local mirror.
10. Pane movement clears old-scope context routing and returns destination-scope context after the moved Pi refreshes role state.
11. Reconnect inside the existing grace period returns context without changing cursor/event semantics.

- [x] **Step 2: Run RPC/topology tests to verify red**

Run: `pnpm test test/integration/observability-rpc.test.ts test/integration/orchestrator-pane-move.test.ts test/integration/orchestrator-disconnect-grace.test.ts`

Expected: responses lack `context` and no context stream exists.

- [x] **Step 3: Persist the registration session ref before building response context**

Inject an async `registerPiSessionRef` dependency into `ObservabilityRpcServer`; `src/daemon/service.ts` binds it to `index.registerPiSessionRef`. In `agent.orchestrator.register`, resolve presence, store it in `#piPresenceBySocket`, and preserve existing grace handling first. Then, before building the connection-state response:

```ts
const registration = await this.#registerPiSessionRef({
  herdrSessionName: presence.herdrSessionName,
  sessionRef: input.sessionRef,
  terminalId: presence.terminalId,
});
for (const scope of registration.contextChangedScopes) {
  this.publishAgentContext(scope);
}
```

Implement private `AgentIndexService.#registerPiSessionRefNow()` inside Task 1's session queue. It reads the previous effective ref, calls `setSessionRefByTerminal()` (which updates only the hint column), compares the returned effective ref, and calls `context.refreshAgent({ agent: updated, identityChanged: true })` only when the effective ref changed. Return the changed scope only when the context result changed.

Do this for owner and non-owner Pi because another owner may need that Pi's history. Comparing effective refs after the hint update preserves Herdr-reported-over-hint priority: changing a hidden lower-priority hint does not force a context refresh until it becomes effective. Registration remains background startup work; it is not part of Pi's prompt path.

- [x] **Step 4: Add context to connection-state responses**

Compute owner state first. Return context only when the presence terminal is current owner:

```ts
const context = state?.owner?.terminalId === presence.terminalId
  ? this.#context.workspaceSnapshot({
      excludeTerminalId: presence.terminalId,
      herdrSessionName: presence.herdrSessionName,
      workspaceId: presence.workspaceId,
    })
  : null;
return { context, events: this.#orchestrator.pending({ ...presence, limit: 100 }), presence, state };
```

Do not expose another owner's context in non-owner status responses.

- [x] **Step 5: Implement owner-only stream push and service wiring**

Add public:

```ts
publishAgentContext(scope: AgentScope): void;
```

Resolve the current owner and newest socket exactly as `publishAgentEvent()` does, assemble an owner-filtered snapshot, and write:

```ts
{
  method: "agent.context.changed",
  params: { context, herdrSessionName: scope.herdrSessionName, workspaceId: scope.workspaceId },
}
```

If no owner or no owner socket exists, send nothing. If `workspaceSnapshot()` returns null for a changed owned scope, send the null payload so Pi clears stale context. Wire `HerdrSessionWatchManager.onAgentContextChanged` to `server.publishAgentContext` in `src/daemon/service.ts`. Keep `onAgentIndexRefreshed` wired to `server.reconcileAgentLocations`; Task 3 guarantees reconciliation runs before context push.

- [x] **Step 6: Run RPC/topology tests to verify green**

Run: `pnpm test test/integration/observability-rpc.test.ts test/integration/orchestrator-pane-move.test.ts test/integration/orchestrator-disconnect-grace.test.ts`

Expected: owner-only response/push assertions and all existing cursor/grace/move tests pass.

- [x] **Step 7: Commit**

```bash
git add src/daemon/observability-server.ts src/daemon/service.ts test/integration/observability-rpc.test.ts test/integration/orchestrator-pane-move.test.ts test/integration/orchestrator-disconnect-grace.test.ts
git commit -m "feat(daemon): push cached context to the owner Pi"
```

### Task 5: Serve `agent.list` from Cache and Keep Detail Reads Live

**Objective:** Make CLI/plugin list instant while preserving live `agent.get/read` detail behavior.

**Files:**
- Modify: `src/daemon/observability-server.ts`
- Modify: `test/integration/observability-rpc.test.ts`
- Modify: `test/unit/cli.test.ts` only if fixture freshness fields need adjustment

**Interfaces:**
- Consumes: `AgentContextService.listAgents()`.
- Produces: cached `agent.list` contract.

- [x] **Step 1: Write failing RPC call-count tests**

Inject a history service whose `getCompactHistory()` and `read()` calls are recorded plus a seeded context snapshot. Assert:

1. `agent.list` returns the seeded cached last user/assistant messages and makes zero history calls.
2. An agent without a snapshot still appears with null history fields.
3. `agent.get` calls live `resolveCompactHistory()` once with `preferredRef` from `context.getAgentSnapshot(agent.id)`.
4. `agent.read` calls live `read()` once with the same preferred ref.
5. Stopped-session filtering and ambiguous workspace errors remain unchanged.
6. Human/JSON CLI rendering continues to use the returned cached `updatedAt` without a new CLI flag.

- [x] **Step 2: Run RPC/CLI tests to verify red**

Run: `pnpm test test/integration/observability-rpc.test.ts test/unit/cli.test.ts`

Expected: current `agent.list` invokes history and ignores the persisted snapshot.

- [x] **Step 3: Replace only the list dispatch path**

Implement:

```ts
case "agent.list": {
  assertSchema(agentListInputSchema, params);
  const scope = this.#resolveScope(params as AgentQueryScope);
  return { agents: this.#context.listAgents(scope) };
}
```

Keep `agent.get` and `agent.read` live, but obtain `const preferredRef = this.#context.getAgentSnapshot(agent.id)?.historyRef` and pass it to `history.resolveCompactHistory()` / `history.read()`. If the preferred ref is missing or invalid, the history service rediscovers according to child 02.

- [x] **Step 4: Run focused daemon/CLI tests**

Run: `pnpm test test/integration/observability-rpc.test.ts test/unit/cli.test.ts test/unit/herdr-plugin-package.test.ts`

Expected: cached list call counts and existing CLI/plugin output tests pass.

- [x] **Step 5: Commit**

```bash
git add src/daemon/observability-server.ts test/integration/observability-rpc.test.ts test/unit/cli.test.ts
git commit -m "perf(rpc): serve agent list from cached context"
```

## Progress

- [x] Serialized dirty/status/hint refresh completed
- [x] Adaptive watcher and ordered publication completed
- [x] Owner response/push and cached list completed

## Next Steps

No implementation work remains.

## Completion Evidence

- Dirty refresh, mutation serialization, pending Pi hint application, adaptive polling, watcher lifecycle guards, owner push, and cached list/live detail reads shipped in `8e6f228`.
- Index, watcher, RPC, topology, CLI, and package regressions passed; final review approved the stop/rescan retirement ordering.

## Validation

- `pnpm test test/integration/agent-index-service.test.ts` — dirty-pane and immediate status refresh pass.
- `pnpm test test/unit/herdr-session-watch-manager.test.ts` — exact 10/60 cadence and non-overlapping scheduler ticks pass.
- `pnpm test test/integration/observability-rpc.test.ts` — cached list and owner-only context response/push pass.
- `pnpm test test/integration/orchestrator-pane-move.test.ts test/integration/orchestrator-disconnect-grace.test.ts` — movement and reconnect context pass.
- `pnpm test test/unit/cli.test.ts test/unit/herdr-plugin-package.test.ts` — CLI and plugin retain output behavior.
- `pnpm typecheck` — final daemon callback and wire types compile.

## Risks, Tradeoffs, and Open Questions

- **Long refreshes:** a 10-second tick can take longer than 10 seconds on first discovery. The watcher skips overlapping ticks, and `AgentIndexService` coalesces same-epoch refreshes instead of queueing duplicate work.
- **Full-rescan topology:** full rescan still restarts subscriptions to recover missed pane sets. At the exact 60-second boundary it replaces, rather than duplicates, the active-only tick.
- **Status-event flush:** the watcher publishes changed scopes before events, but file flush can still lag. Existing wake settle and the next revision tick provide correction.
- **Cached CLI freshness:** `agent.list` returns the last persisted observation. `updatedAt` communicates freshness; `agent.get/read` remain live detail operations.
- **No owner:** daemon still maintains persisted cache for CLI and future claims but emits no context stream.
- **No unresolved questions remain in this child.**
