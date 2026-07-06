# Notifications, RPC, and CLI

Parent: [2026-07-02-herdr-worker-observability-rewrite.md](../2026-07-02-herdr-worker-observability-rewrite.md)

## Status

Done.

## Progress

- Done — Task 9 through Task 11.

## Next steps

- No remaining implementation steps. Final validation passed with `pnpm check` and `pnpm build`.

## Objective

Implement durable notification cursors, the observability JSONL RPC API, and observed-workspace CLI commands.

## Scope

Task 9 through Task 11.

### Task 9: Implement Notification Service and Ack Semantics

**Objective:** Provide non-invasive notifications, optional autoResume state, durable daemon cursors, and subscriber ack.

**Files:**
- Create: `src/observability/notification-service.ts`
- Test: `test/integration/notification-service.test.ts`

**Interfaces:**
- Consumes: `NotificationCursorStore`, `WorkerEventStore`.
- Produces: pending notification queries and ack methods for daemon RPC and Pi extension.

- [x] **Step 1: Write failing tests**

Assert:

1. `subscribe()` creates or reuses a subscription for `subscriberId + observedWorkspaceId`.
2. `pending()` returns events after `acked_event_id`.
3. `markDelivered()` advances `delivered_event_id` but not `acked_event_id`.
4. `ack()` advances `acked_event_id` and never moves backward.
5. `nextHiddenContextEvents()` returns unacked events not yet injected into hidden context.
6. `nextAutoResumeEvent()` returns only when subscription has `autoResume: true`.

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm test test/integration/notification-service.test.ts`

Expected: service missing or behavior missing.

- [x] **Step 3: Implement service**

Export:

```ts
export class NotificationService {
  constructor(options: { cursors: NotificationCursorStore; workerEvents: WorkerEventStore });
  subscribe(input: { autoResume: boolean; observedWorkspaceId: string; subscriberId: string; subscriberKind: string }): NotificationSubscriptionRecord;
  pending(input: { limit?: number; subscriptionId: string }): WorkerEventRecord[];
  markDelivered(input: { eventId: number; subscriptionId: string }): void;
  ack(input: { eventId: number; subscriptionId: string }): void;
  nextHiddenContextEvents(input: { limit: number; subscriptionId: string }): WorkerEventRecord[];
  markHiddenContextInjected(input: { eventId: number; subscriptionId: string }): void;
  nextAutoResumeEvent(input: { subscriptionId: string }): WorkerEventRecord | undefined;
  markAutoResumed(input: { eventId: number; subscriptionId: string }): void;
}
```

- [x] **Step 4: Run tests**

Run: `pnpm test test/integration/notification-service.test.ts`

Expected: all notification tests pass.

- [x] **Step 5: Commit**

```bash
git add src/observability/notification-service.ts test/integration/notification-service.test.ts
git commit -m "feat(observability): add notification cursors"
```

### Task 10: Replace Daemon RPC with Observability API

**Objective:** Expose observed workspace, worker snapshot, worker event, notification, and runtime telemetry APIs over JSON Lines.

**Files:**
- Create: `src/daemon/observability-server.ts`
- Create: `src/daemon/client.ts`
- Create: `src/daemon/service.ts`
- Modify: `src/gateway/service.ts` to delegate to `runObservabilityDaemonService()` until Task 14 removes old gateway naming
- Test: `test/integration/observability-rpc.test.ts`

**Interfaces:**
- Consumes: stores, pipeline, notification service, schemas.
- Produces: public daemon API used by CLI and Pi extension.

- [x] **Step 1: Write failing RPC tests**

Use a socket test harness to assert:

1. `workspace.observe` returns `{ observedWorkspace: { id: "ow_..." } }`.
2. `workspace.snapshot` returns `workers: WorkerSnapshot[]`.
3. `worker.events` returns worker events after cursor.
4. `runtime.telemetry` passes telemetry to pipeline and returns `{ accepted: true }`.
5. `notification.subscribe` returns subscription id and replay events.
6. `notification.ack` advances cursor.
7. unknown method returns JSON-RPC error.

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm test test/integration/observability-rpc.test.ts`

Expected: server missing.

- [x] **Step 3: Implement RPC server**

The server must:

- validate inputs with TypeBox schemas
- keep transport logic separate from pipeline logic
- never expose low-level Herdr pane/tab proxy methods
- stream event notifications as JSONL messages:

```json
{"method":"worker.event","params":{"event":{...}}}
```

- [x] **Step 4: Wire daemon service**

Create service startup that:

1. opens SQLite
2. applies migrations
3. creates stores
4. creates Herdr client pool
5. creates `WorkerStatePipeline`
6. refreshes active observed workspaces on startup
7. starts Herdr `events.subscribe` loops for active observed workspaces
8. starts JSONL RPC server

- [x] **Step 5: Run tests**

Run: `pnpm test test/integration/observability-rpc.test.ts`

Expected: all RPC tests pass.

- [x] **Step 6: Commit**

```bash
git add src/daemon/observability-server.ts src/daemon/client.ts src/daemon/service.ts src/gateway/service.ts test/integration/observability-rpc.test.ts
git commit -m "feat(daemon): expose observability RPC"
```

### Task 11: Rewrite CLI for Observed Workspace Workflows

**Objective:** Replace session/Gateway CLI commands with observed workspace JSON/JSONL commands.

**Files:**
- Modify: `src/cli/shepherd.ts`
- Delete: `src/cli/shepherd-tools.ts`
- Modify: `package.json` if bin entries change
- Test: `test/unit/cli.test.ts`

**Interfaces:**
- Consumes: `src/daemon/client.ts`.
- Produces: formal CLI entrypoint for scripts, Herdr plugin, and humans.

- [x] **Step 1: Write failing CLI tests**

Update `test/unit/cli.test.ts` for the commands listed in Core Interfaces. Assert:

- parser accepts `observe --herdr-session main --workspace w1 --json`
- parser accepts `observe-current --json`
- parser rejects `observe-current` when required env vars are absent
- `snapshot ow_123 --json` calls `workspace.snapshot`
- `events ow_123 --after 10 --json` calls `worker.events`
- `ack --subscription ns_1 --event 42 --json` calls `notification.ack`
- old `send`, `open`, `watch`, `audit` commands are rejected

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm test test/unit/cli.test.ts`

Expected: old CLI behavior causes failures.

- [x] **Step 3: Implement CLI parser and runners**

Implement command types for new commands. Output JSON when `--json` is present; otherwise print concise human text:

```text
Observed workspace ow_abc123 (active) -> Herdr workspace w1
```

For `events`, print JSON Lines in `--json` mode and tab-separated summaries otherwise.

- [x] **Step 4: Delete `shepherd-tools`**

Delete `src/cli/shepherd-tools.ts` and remove the bin entry. Do not rewrite it for the MVP because the formal API is the observed-workspace CLI plus JSONL daemon RPC.

- [x] **Step 5: Run tests**

Run: `pnpm test test/unit/cli.test.ts`

Expected: CLI tests pass.

- [x] **Step 6: Commit**

```bash
git add src/cli/shepherd.ts src/cli/shepherd-tools.ts package.json test/unit/cli.test.ts
git commit -m "feat(cli): switch to observed workspace commands"
```

