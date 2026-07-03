# Persistence Baseline

Parent: [2026-07-02-herdr-worker-observability-rewrite.md](../2026-07-02-herdr-worker-observability-rewrite.md)

## Status

Done.

## Progress

- Done — Task 2.

## Next steps

- Done. Final validation passed with `pnpm check` and `pnpm build`.

## Objective

Replace the session/Gateway database baseline with observed workspace, worker, worker event, snapshot, and notification cursor persistence.

## Scope

Task 2.

### Task 2: Replace DB Baseline with Observability Tables

**Objective:** Add observed workspace, worker, worker event, snapshot, and notification cursor persistence.

**Files:**
- Modify: `src/db/schema.ts`
- Create: `src/db/observed-workspaces.ts`
- Create: `src/db/workers.ts`
- Create: `src/db/worker-events.ts`
- Create: `src/db/worker-snapshots.ts`
- Create: `src/db/notification-cursors.ts`
- Modify: `drizzle/`
- Test: `test/integration/observed-workspaces-store.test.ts`
- Test: `test/integration/workers-store.test.ts`
- Test: `test/integration/worker-events-store.test.ts`
- Test: `test/integration/notification-service.test.ts`
- Test: `test/integration/sqlite-migrations.test.ts`

**Interfaces:**
- Consumes: `src/observability/contracts.ts`.
- Produces: persistence APIs for pipeline, RPC server, notification service, and CLI.

- [x] **Step 1: Write failing store tests**

Create tests that assert:

1. `ObservedWorkspaceStore.observe()` creates an `active` record with `id` prefix `ow_`.
2. Observing the same Herdr session + workspace id returns the existing record.
3. `ObservedWorkspaceStore.markResolution()` updates live workspace id and status.
4. `WorkerStore.upsertFromHerdrAgent()` uses agent session identity when present.
5. `WorkerStore.upsertFromHerdrAgent()` falls back to live pane identity when agent session is missing.
6. `WorkerEventStore.append()` dedupes by `idempotencyKey` per observed workspace.
7. `WorkerEventStore.listAfter()` returns ascending ids after cursor.
8. `NotificationCursorStore.ack()` advances cursor monotonically and never moves backward.

- [x] **Step 2: Run tests to verify they fail**

Run: `pnpm test test/integration/observed-workspaces-store.test.ts test/integration/workers-store.test.ts test/integration/worker-events-store.test.ts test/integration/notification-service.test.ts`

Expected: tests fail because stores and tables do not exist.

- [x] **Step 3: Replace schema with MVP observability baseline**

Modify `src/db/schema.ts` to keep only tables needed for the rewrite MVP:

```text
observed_workspaces
workers
worker_events
worker_snapshots
notification_subscriptions
notification_cursors
```

Use these columns:

```text
observed_workspaces:
  id text primary key
  herdr_session_name text
  socket_path text
  live_workspace_id text
  status text not null enum active|missing|ambiguous
  metadata_json text not null
  created_at integer not null
  updated_at integer not null
  last_resolved_at integer

workers:
  id text primary key
  observed_workspace_id text not null references observed_workspaces(id) on delete cascade
  worker_key text not null
  identity_kind text not null enum agent_session|live_pane
  agent_session_json text
  current_pane_id text
  current_tab_id text
  current_workspace_id text
  agent_name text
  runtime text
  status text not null enum blocked|done|idle|unknown|working
  metadata_json text not null
  first_seen_at integer not null
  last_seen_at integer not null
  updated_at integer not null
  unique(observed_workspace_id, worker_key)

worker_events:
  id integer primary key autoincrement
  observed_workspace_id text not null references observed_workspaces(id) on delete cascade
  worker_id text references workers(id) on delete set null
  type text not null
  idempotency_key text
  payload_json text not null
  created_at integer not null
  unique(observed_workspace_id, idempotency_key)

worker_snapshots:
  id integer primary key autoincrement
  observed_workspace_id text not null references observed_workspaces(id) on delete cascade
  worker_id text not null references workers(id) on delete cascade
  snapshot_json text not null
  created_at integer not null

notification_subscriptions:
  id text primary key
  observed_workspace_id text not null references observed_workspaces(id) on delete cascade
  subscriber_id text not null
  subscriber_kind text not null
  auto_resume integer not null
  created_at integer not null
  updated_at integer not null
  unique(observed_workspace_id, subscriber_id)

notification_cursors:
  subscription_id text primary key references notification_subscriptions(id) on delete cascade
  delivered_event_id integer not null default 0
  acked_event_id integer not null default 0
  hidden_context_event_id integer not null default 0
  auto_resume_event_id integer not null default 0
  updated_at integer not null
```

- [x] **Step 4: Implement stores**

Store method names must be exactly:

```ts
class ObservedWorkspaceStore {
  observe(input: ObserveWorkspaceStoreInput): ObservedWorkspaceRecord;
  get(id: string): ObservedWorkspaceRecord;
  listActive(): ObservedWorkspaceRecord[];
  markResolution(input: { id: string; liveWorkspaceId: string | null; metadata?: ObservedWorkspaceMetadata; status: ObservedWorkspaceStatus }): ObservedWorkspaceRecord;
}

class WorkerStore {
  upsertFromHerdrAgent(input: UpsertWorkerFromHerdrAgentInput): WorkerRecord;
  updateLiveIdentity(input: { id: string; paneId: string | null; tabId: string | null; workspaceId: string | null }): WorkerRecord;
  updateStatus(input: { id: string; status: WorkerStatus }): WorkerRecord;
  listForWorkspace(observedWorkspaceId: string): WorkerRecord[];
  get(id: string): WorkerRecord;
  findByWorkerKey(input: { observedWorkspaceId: string; workerKey: string }): WorkerRecord | undefined;
}

class WorkerEventStore {
  append(input: AppendWorkerEventInput): WorkerEventRecord;
  listAfter(input: { afterEventId?: number; limit?: number; observedWorkspaceId: string }): WorkerEventRecord[];
  latestEventId(observedWorkspaceId: string): number;
}

class WorkerSnapshotStore {
  putCurrent(input: { observedWorkspaceId: string; snapshot: WorkerSnapshot; workerId: string }): WorkerSnapshotRecord;
  listCurrent(observedWorkspaceId: string): WorkerSnapshot[];
}

class NotificationCursorStore {
  subscribe(input: { autoResume: boolean; observedWorkspaceId: string; subscriberId: string; subscriberKind: string }): NotificationSubscriptionRecord;
  markDelivered(input: { eventId: number; subscriptionId: string }): void;
  ack(input: { eventId: number; subscriptionId: string }): void;
  listPending(input: { limit?: number; subscriptionId: string }): WorkerEventRecord[];
}
```

- [x] **Step 5: Generate migration baseline**

Run: `pnpm db:generate`

Expected: Drizzle creates a migration reflecting the new observability tables. Inspect generated SQL and confirm no old Gateway/session tables remain.

- [x] **Step 6: Run tests**

Run: `pnpm test test/integration/observed-workspaces-store.test.ts test/integration/workers-store.test.ts test/integration/worker-events-store.test.ts test/integration/notification-service.test.ts test/integration/sqlite-migrations.test.ts`

Expected: all listed tests pass.

- [x] **Step 7: Commit**

```bash
git add src/db/schema.ts src/db/observed-workspaces.ts src/db/workers.ts src/db/worker-events.ts src/db/worker-snapshots.ts src/db/notification-cursors.ts drizzle test/integration/observed-workspaces-store.test.ts test/integration/workers-store.test.ts test/integration/worker-events-store.test.ts test/integration/notification-service.test.ts test/integration/sqlite-migrations.test.ts
git commit -m "feat(db): add observability persistence"
```

