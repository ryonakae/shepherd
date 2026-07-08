# Daemon Session Discovery, Indexing, Watch Loop, and Agent Events Plan

> **For implementers:** Execute this plan task-by-task. Complete each checkbox step, run the listed validation, and commit after each task.

**Goal:** Make the daemon automatically discover all running Herdr sessions, index all workspaces/agents, subscribe to status changes, and persist/push agent events with compact history.

**Architecture:** Replace the old `WorkerStatePipeline` with an agent-oriented `AgentIndexService` and `HerdrSessionWatchManager`. The daemon polls `herdr session list --json` every 60 seconds, connects to every running session socket, snapshots all workspaces/agents, and maintains one Herdr event subscription per running session. Status changes trigger compact history refresh and agent event creation.

**Tech Stack:** TypeScript, Node.js child_process, Herdr socket API, SQLite stores, Vitest integration tests.

## Global Constraints

- Watch only running Herdr sessions from `herdr session list --json`.
- Stopped sessions are out of scope.
- Watch all workspaces and agents inside each running Herdr session.
- Rescan Herdr session list every 60 seconds.
- Push trigger is Herdr agent status changes. On trigger, reread history and attach compact history to agent event.
- DB remains index/cache/push/cursor layer.
- Remove old `WorkerStatePipeline` and worker event semantics from active code.
- Daemon must not require user config for Herdr sessions.

## Current Context

- `src/daemon/service.ts` currently opens old stores, creates `WorkerStatePipeline`, and starts `ObservabilityRpcServer`.
- `HerdrSocketClient.sessionSnapshot()` exists and returns normalized-compatible snapshot data.
- `HerdrSocketClient.subscribeEvents()` currently takes `{ paneIds, workspaceId }` and subscribes to pane-specific `pane.agent_status_changed` events plus broad workspace/pane events.
- `ObservabilityRpcServer.publishWorkerEvent()` streams old `worker.event` notifications manually.

## File Structure

- Create: `src/herdr/session-list.ts` — run and parse `herdr session list --json`.
- Modify: `src/herdr/socket-client.ts` — support event subscription updates needed for whole-session watch.
- Create: `src/daemon/herdr-session-watch-manager.ts` — poll running sessions and manage watchers.
- Create: `src/observability/agent-index-service.ts` — snapshot/index agents and emit agent events.
- Create: `src/observability/agent-notification-service.ts` — pending/ack/hidden context cursor over agent events.
- Modify: `src/daemon/service.ts` — wire new stores, history service, watch manager, RPC server.
- Modify: `src/daemon/observability-server.ts` — remove old worker pipeline dependency and stream `agent.event` notifications.
- Delete or stop using: `src/observability/worker-state-pipeline.ts`.
- Test: `test/unit/herdr-session-list.test.ts`
- Test: `test/integration/agent-index-service.test.ts`
- Test: `test/integration/herdr-session-watch-manager.test.ts`
- Modify: `test/integration/observability-rpc.test.ts`

## Interfaces

Create `src/herdr/session-list.ts`:

```ts
export type HerdrSessionListEntry = {
  default?: boolean;
  name: string;
  running: boolean;
  sessionDir: string;
  socketPath: string;
};

export type HerdrSessionListRunner = () => Promise<HerdrSessionListEntry[]>;

export function createHerdrSessionListRunner(options?: {
  command?: string;
  env?: NodeJS.ProcessEnv;
}): HerdrSessionListRunner;
```

Create `src/observability/agent-index-service.ts`:

```ts
export class AgentIndexService {
  refreshHerdrSession(input: { herdrSessionName: string; sessionDir: string; socketPath: string }): Promise<void>;
  handleHerdrEvent(input: { event: unknown; herdrSessionName: string }): Promise<AgentEventRecord | undefined>;
}
```

Create `src/daemon/herdr-session-watch-manager.ts`:

```ts
export class HerdrSessionWatchManager {
  start(): Promise<void>;
  stop(): Promise<void>;
  rescanNow(): Promise<void>;
}
```

## Tasks

### Task 1: Parse `herdr session list --json`

**Objective:** Give daemon a tested source of running Herdr sessions.

**Files:**
- Create: `src/herdr/session-list.ts`
- Test: `test/unit/herdr-session-list.test.ts`

**Interfaces:**
- Produces: `createHerdrSessionListRunner()` and `normalizeHerdrSessionList()`.

- [ ] **Step 1: Write the failing tests**

Test cases:

1. Parses JSON `{ sessions: [{ name, running, session_dir, socket_path }] }` into camelCase entries.
2. Rejects entries missing `name`, `session_dir`, or `socket_path`.
3. Keeps stopped entries in the returned array with `running: false`; filtering happens in watch manager.
4. Command runner calls `herdr session list --json` with inherited env.
5. Invalid JSON throws `Failed to parse herdr session list --json output`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test test/unit/herdr-session-list.test.ts`

Expected: Import fails because session-list module does not exist.

- [ ] **Step 3: Write minimal implementation**

Use `node:child_process` `execFile` or `spawn` wrapped in a promise. Do not shell interpolate arguments. Normalize snake_case to camelCase.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test test/unit/herdr-session-list.test.ts`

Expected: All session list tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/herdr/session-list.ts test/unit/herdr-session-list.test.ts
git commit -m "herdr: discover running sessions"
```

### Task 2: Implement AgentIndexService snapshot indexing

**Objective:** Index all workspaces and agents from one Herdr running session snapshot.

**Files:**
- Create: `src/observability/agent-index-service.ts`
- Test: `test/integration/agent-index-service.test.ts`

**Interfaces:**
- Consumes: stores from child plan 01, `createAgentHistoryService()` from child plan 02, `normalizeHerdrSessionSnapshot()`.
- Produces: `refreshHerdrSession()`.

- [ ] **Step 1: Write the failing tests**

Test cases:

1. `refreshHerdrSession()` upserts Herdr session row with `running: true`.
2. It replaces workspace rows from snapshot workspaces.
3. It replaces agent rows from snapshot agents and stores `agent_session` when present.
4. It computes compact history for each indexed agent using `AgentHistoryService.getCompactHistory()` and writes cache when service does so.
5. It removes agent rows that disappeared from the latest snapshot for that Herdr session.
6. It does not remove rows for other Herdr sessions.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test test/integration/agent-index-service.test.ts`

Expected: Import fails because `AgentIndexService` does not exist.

- [ ] **Step 3: Write minimal implementation**

Implementation outline:

```ts
async refreshHerdrSession(input) {
  const client = new HerdrSocketClient({ socketPath: input.socketPath });
  try {
    const snapshot = normalizeHerdrSessionSnapshot(await client.sessionSnapshot());
    sessions.upsertRunning(input);
    workspaces.replaceForSession({ herdrSessionName: input.herdrSessionName, workspaces: snapshot.workspaces });
    const agents = agentsStore.replaceForSession({ herdrSessionName: input.herdrSessionName, agents: snapshot.agents });
    for (const agent of agents) {
      await history.getCompactHistory({ agent: agent.agent, agentSession: agent.agentSession, cwd: agent.cwd, foregroundCwd: agent.foregroundCwd });
    }
  } finally {
    client.close();
  }
}
```

Keep socket client factory injectable for tests.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test test/integration/agent-index-service.test.ts`

Expected: Snapshot indexing tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/observability/agent-index-service.ts test/integration/agent-index-service.test.ts
git commit -m "observability: index herdr agents"
```

### Task 3: Emit agent events on Herdr status changes

**Objective:** Convert Herdr `pane.agent_status_changed` into agent events with compact history.

**Files:**
- Modify: `src/observability/agent-index-service.ts`
- Test: `test/integration/agent-index-service.test.ts`

**Interfaces:**
- Consumes: `AgentStore.resolveTarget` or pane lookup, `AgentEventStore.append`, `AgentHistoryService.getCompactHistory`.
- Produces: `handleHerdrEvent()`.

- [ ] **Step 1: Write the failing tests**

Add tests:

1. `working -> idle` produces `agent.status.changed` and `agent.idle` events with compact history.
2. `working -> blocked` produces `agent.status.changed` and `agent.blocked` events.
3. `working -> done` produces `agent.status.changed` and `agent.done` events.
4. Repeating the same event idempotency key does not duplicate events.
5. Event payload includes `from`, `to`, `agent`, `paneId`, `workspaceId`, and `herdrSessionName`.
6. Unknown pane id causes service to refresh the Herdr session once, then tries again before dropping the event.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test test/integration/agent-index-service.test.ts`

Expected: New status event tests fail because `handleHerdrEvent()` is missing/incomplete.

- [ ] **Step 3: Write minimal implementation**

Rules:

- Ignore events whose `type` is not `pane.agent_status_changed`.
- Find agent by `(herdrSessionName, pane_id)`.
- If not found, call `refreshHerdrSession()` once and retry.
- Update agent status from event.
- Build compact history from current agent metadata.
- Append `agent.status.changed` when previous status differs.
- Append status-specific event for `idle`, `blocked`, or `done`.
- Return the last appended event for streaming; caller can also fetch latest.

Use idempotency keys:

```ts
`${type}:${herdrSessionName}:${paneId}:${from}:${to}:${eventSeqOrTimestamp}`
```

If Herdr event has no sequence/timestamp, use current persisted status transition key without timestamp so repeated identical transitions dedupe.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test test/integration/agent-index-service.test.ts`

Expected: All agent index service tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/observability/agent-index-service.ts test/integration/agent-index-service.test.ts
git commit -m "observability: emit agent status events"
```

### Task 4: Watch all running Herdr sessions and resubscribe when panes change

**Objective:** Keep daemon watches aligned with running Herdr sessions and their current pane sets.

**Files:**
- Modify: `src/herdr/socket-client.ts`
- Create: `src/daemon/herdr-session-watch-manager.ts`
- Test: `test/integration/herdr-session-watch-manager.test.ts`
- Modify: `test/integration/herdr-socket-client.test.ts`

**Interfaces:**
- Consumes: `HerdrSessionListRunner`, `AgentIndexService`, `HerdrSocketClient.subscribeEvents()`.
- Produces: session watch manager lifecycle.

- [ ] **Step 1: Write the failing tests**

Test cases:

1. `start()` calls session list runner, starts watchers for `running: true`, and ignores stopped sessions.
2. `rescanNow()` starts a watcher for a newly running session.
3. `rescanNow()` aborts and closes watcher for a session that becomes stopped or disappears.
4. `rescanNow()` calls `HerdrSessionStore.markStoppedMissingFrom(runningSessionNames)` so sessions that are no longer running are persisted as `running=false`.
5. Watcher calls `AgentIndexService.refreshHerdrSession()` before subscribing.
6. Watcher sends `pane.agent_status_changed` events to `AgentIndexService.handleHerdrEvent()`.
7. On broad pane/workspace events (`pane.created`, `pane.closed`, `pane.moved`, `pane.agent_detected`, `workspace.closed`), watcher refreshes session and recreates status subscriptions for the current pane ids.
8. Watch manager uses a 60,000 ms interval by default and accepts an injected interval for tests.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test test/integration/herdr-session-watch-manager.test.ts test/integration/herdr-socket-client.test.ts`

Expected: Watch manager import fails or subscription tests fail.

- [ ] **Step 3: Write minimal implementation**

Update `HerdrSocketClient.subscribeEvents()` to accept:

```ts
async *subscribeEvents(
  params: { paneIds?: string[]; workspaceId?: string } = {},
  options: { signal?: AbortSignal } = {},
): AsyncIterable<unknown>
```

Subscription payload should include broad events and `pane.agent_status_changed` for each known pane id. If `paneIds` is empty, subscribe only broad events and rely on refresh/resubscribe after snapshot yields panes.

Implement watch manager:

- Keep `Map<string, Watcher>` by Herdr session name.
- `rescanNow()` calls session list runner.
- Compute `runningEntries` and call `HerdrSessionStore.markStoppedMissingFrom(runningEntries.map((entry) => entry.name))` before watcher reconciliation.
- For running entries not watched, create `AbortController`, client, and async loop.
- For watched entries no longer running, abort and close.
- Each watcher:
  1. Calls `index.refreshHerdrSession(entry)`.
  2. Reads current pane ids from `AgentStore.listForHerdrSession(entry.name)`.
  3. Starts `subscribeEvents({ paneIds })`.
  4. For status events, calls `index.handleHerdrEvent()` and emits an `agent.event` through a callback if an event is returned.
  5. For topology events, aborts current subscription and restarts after refresh.
- On socket errors, retry after the next session rescan. Do not crash daemon.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test test/integration/herdr-session-watch-manager.test.ts test/integration/herdr-socket-client.test.ts`

Expected: Watch manager and socket subscription tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/herdr/socket-client.ts src/daemon/herdr-session-watch-manager.ts test/integration/herdr-session-watch-manager.test.ts test/integration/herdr-socket-client.test.ts
git commit -m "daemon: watch running herdr sessions"
```

### Task 5: Wire daemon service and stream agent events

**Objective:** Start watch manager in daemon and stream `agent.event` messages to subscribers.

**Files:**
- Modify: `src/daemon/service.ts`
- Modify: `src/daemon/observability-server.ts`
- Create or modify: `src/observability/agent-notification-service.ts`
- Modify: `test/integration/observability-rpc.test.ts`

**Interfaces:**
- Consumes: new stores, history service, index service, watch manager.
- Produces: running daemon with agent event stream.

- [ ] **Step 1: Write the failing tests**

Update `test/integration/observability-rpc.test.ts`:

1. Server streams `{ method: "agent.event", params: { event } }` when `publishAgentEvent()` is called.
2. `agent.notifications.subscribe` returns pending `agent_events` and a subscription id.
3. `agent.notifications.ack` marks an event as acked.
4. Old methods `workspace.snapshot`, `worker.events`, `runtime.telemetry` with worker event types, and `notification.subscribe` return `Unknown method` after child plan 04 completes. For this child, mark the expectations but enable them when RPC method replacement is implemented.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test test/integration/observability-rpc.test.ts`

Expected: Tests fail because server still streams old worker methods.

- [ ] **Step 3: Write minimal implementation**

In `service.ts`:

- Open new stores.
- Create `AgentHistoryService` with cache store.
- Create `AgentIndexService`.
- Create `AgentNotificationService`.
- Create `ObservabilityRpcServer` with agent stores/services.
- Create `HerdrSessionWatchManager` and call `await watchManager.start()` before logging daemon ready.
- Stop watch manager during SIGINT/SIGTERM cleanup.

In `observability-server.ts`:

- Rename `publishWorkerEvent` to `publishAgentEvent`.
- Stream method name `agent.event`.
- Keep JSON Lines framing unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test test/integration/observability-rpc.test.ts`

Expected: Agent event streaming and notification cursor tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/service.ts src/daemon/observability-server.ts src/observability/agent-notification-service.ts test/integration/observability-rpc.test.ts
git commit -m "daemon: stream agent events"
```

## Validation

- `pnpm test test/unit/herdr-session-list.test.ts`
- `pnpm test test/integration/agent-index-service.test.ts`
- `pnpm test test/integration/herdr-session-watch-manager.test.ts`
- `pnpm test test/integration/observability-rpc.test.ts`
- `pnpm test test/integration/herdr-socket-client.test.ts test/integration/managed-herdr-socket-client.test.ts`

## Risks, Tradeoffs, and Open Questions

- Herdr event subscription changes may require careful socket lifecycle handling to avoid duplicate subscriptions.
- If Herdr `session.snapshot` is unsupported, fallback list APIs must still provide enough pane ids for status subscriptions.
- Polling every 60 seconds means newly started Herdr sessions may not be watched instantly. This is accepted.
- Status events can miss message-only changes; direct read/get still uses history files/cache.
