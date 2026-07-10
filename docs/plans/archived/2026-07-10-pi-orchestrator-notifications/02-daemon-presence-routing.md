# Daemon Presence, Role Service, Scoped Routing, and Grace Lifecycle Plan

> **For implementers:** Execute this plan task-by-task. Complete each checkbox step, run the listed validation, and commit after each task.

**Status:** Completed

**Goal:** Make the daemon resolve each Pi connection to a stable Herdr terminal, enforce exclusive owner operations, route agent events only to the owner, and clear disconnected owners after deterministic grace periods.

**Architecture:** `AgentOrchestratorService` owns synchronous role/cursor rules over the stores; it does not know sockets or Pi UI. `ObservabilityRpcServer` binds a validated `PiPresence` to each registered socket, dispatches connection-bound set/get/ack calls, sends scoped role changes, and schedules grace expiry. The server suppresses disconnect expiry during intentional shutdown and revalidates persisted owners after daemon startup.

**Tech Stack:** TypeScript, Node `net`, Node timers, SQLite stores, TypeBox RPC validation, Vitest fake timers and real Unix sockets.

## Global Constraints

- Inherit all parent constraints and child 01 contracts.
- RPC requests that mutate or acknowledge role state derive caller identity from the registered socket. Do not accept caller terminal/session/scope ids in set/get/ack params.
- Registration must resolve `herdrSocketPath` to one running Herdr session. Prefer `(herdrSessionName, paneId)` from the current index; when a moved terminal reconnects with stale launch-time pane/workspace env, resolve that pane alias through the same live Herdr socket and use returned current pane/workspace/terminal identity.
- Unknown socket, unresolved indexed/live pane, mismatched live identity, or missing terminal id is a retryable registration failure. Never create an unresolved owner.
- Only one most-recent registered socket per terminal receives pushed agent events. An overlapping old socket from Pi session replacement must not cause duplicates or disconnect expiry while the replacement socket is connected.
- Role state changes are persisted before stream messages are sent.
- Role change broadcasts are scoped; generic CLI/RPC sockets that never registered Pi presence receive no role or agent event stream.
- `DISCONNECT_GRACE_MS` and `STARTUP_RECONNECT_GRACE_MS` must be constructor-injectable in tests and default to parent-plan values.

## Current Context

- `ObservabilityRpcServer` currently broadcasts to `#sockets` and calls `#dispatch(method, params)` without socket context.
- `HerdrSessionStore` has `listRunning()` and `get()` but no socket-path resolver.
- Existing `agent.notifications.subscribe` creates subscriber rows; it will be replaced by connection registration.
- `AgentEventStore.listAfter()` and `latestEventId()` already support exact scope filters.
- Pi client migration occurs in child 04, so daemon tests must exercise the new JSONL protocol directly before the extension switches.

## File Structure

- Create: `src/observability/agent-orchestrator-service.ts` — owner operations, pending selection, shared ack, persisted-owner reconciliation.
- Create: `test/integration/agent-orchestrator-service.test.ts` — pure service behavior over SQLite.
- Modify: `src/db/herdr-sessions.ts` — `findRunningBySocketPath()`.
- Create: `src/herdr/pane-identity-resolver.ts` — resolve current PaneInfo from exact or stale public pane id through one Herdr socket request.
- Create: `test/integration/herdr-pane-identity-resolver.test.ts` — direct/wrapped response normalization and socket cleanup.
- Modify: `src/daemon/observability-server.ts` — connection registration, scoped RPC dispatch/routing, timers, startup reconciliation.
- Modify: `src/daemon/service.ts` — construct/inject new store/service and start grace lifecycle.
- Modify: `src/observability/contracts.ts` — remove legacy subscriber/cursor records after final consumer migration.
- Modify: `src/observability/schemas.ts` — remove legacy subscribe/ack schemas and use `agentOrchestratorAckInputSchema`.
- Modify: `src/daemon/client.ts` — no new stream behavior required; keep generic request client compatible with new RPC methods.
- Modify: `test/integration/observability-rpc.test.ts` — multi-socket registration, claim, routing, ack, and replacement tests.
- Create: `test/integration/orchestrator-disconnect-grace.test.ts` — normal close, reconnect, startup timeout, and intentional stop.
- Delete: `src/db/agent-notification-cursors.ts` after all daemon consumers are migrated.
- Delete: `src/observability/agent-notification-service.ts` after all daemon consumers are migrated.

## Interfaces

Service API:

```ts
export type AgentOrchestratorChange = {
  current: AgentOrchestratorState;
  previous: AgentOrchestratorState;
  reason: AgentOrchestratorChangeReason;
};

export class AgentOrchestratorService {
  constructor(options: {
    agents: AgentStore;
    agentEvents: AgentEventStore;
    scopes: AgentOrchestratorScopeStore;
  });

  status(scope: AgentScope): AgentOrchestratorState | undefined;
  claim(input: AgentScope & { paneId: string; terminalId: string }): AgentOrchestratorChange;
  release(input: AgentScope & { reason: "disconnected" | "released" | "startup_timeout"; terminalId: string }): AgentOrchestratorChange | undefined;
  pending(input: AgentScope & { limit?: number; terminalId: string }): AgentEventRecord[];
  ack(input: AgentScope & { eventId: number; terminalId: string }): AgentOrchestratorState;
  move(input: {
    from: AgentScope;
    paneId: string;
    terminalId: string;
    to: AgentScope;
  }): AgentOrchestratorChange[];
  persistedOwners(): AgentOrchestratorState[];
}
```

Server-local connection state:

```ts
type PiPresence = AgentScope & {
  autoResume: boolean;
  connectedAt: number;
  paneId: string;
  subscriberId: string;
  terminalId: string;
};

type AgentOrchestratorConnectionStateResult = {
  events: AgentEventWireRecord[];
  presence: PiPresence;
  state: AgentOrchestratorWireState | null;
};

type AgentOrchestratorSetResult = AgentOrchestratorConnectionStateResult & {
  changed: boolean;
};
```

RPC surface:

```text
agent.orchestrator.register PiPresenceRegistration -> AgentOrchestratorConnectionStateResult
agent.orchestrator.get {} -> AgentOrchestratorConnectionStateResult
agent.orchestrator.set { enabled: boolean } -> AgentOrchestratorSetResult
agent.notifications.ack { eventId: number } -> { acknowledged: true, state }
```

Stream surface:

```json
{"method":"agent.event","params":{"event":{}}}
{"method":"agent.orchestrator.changed","params":{"change":{"reason":"claimed","previous":{},"current":{}}}}
```

## Tasks

### Task 1: Implement Orchestrator Domain Service

**Objective:** Prove owner/cursor rules independently of sockets and timers.

**Files:**
- Create: `src/observability/agent-orchestrator-service.ts`
- Create: `test/integration/agent-orchestrator-service.test.ts`

**Interfaces:**
- Consumes: child 01 stores/contracts.
- Produces: `AgentOrchestratorService` API above.

- [x] **Step 1: Write failing service tests**

Cover exact behavior:

1. `status()` returns undefined before first claim.
2. First claim initializes cursor from `latestEventId(scope)` and emits reason `claimed`.
3. Repeated claim by same terminal/pane is idempotent at state level and does not reset cursor.
4. Claim by terminal B replaces terminal A and returns previous/current owners.
5. Release by terminal B succeeds; release by A after replacement returns undefined.
6. `pending()` returns ascending events after the shared cursor, excludes events from other scopes, and excludes events whose `terminalId` equals owner terminal.
7. Ownerless initialized scope accumulates new events; a later claim receives them.
8. `ack()` is owner-only and monotonic.
9. `move()` clears source, replaces destination owner, preserves both initialized cursors, and emits one `moved` change per affected scope.
10. First move into an unseen destination initializes destination cursor at its current latest event.

Example pending setup:

```ts
const self = agentEvents.append({
  herdrSessionName: "default",
  paneId: "wB:p1",
  payload: {},
  terminalId: "term_owner",
  type: "agent.idle",
  workspaceId: "wB",
});
const worker = agentEvents.append({
  herdrSessionName: "default",
  paneId: "wB:p2",
  payload: {},
  terminalId: "term_worker",
  type: "agent.done",
  workspaceId: "wB",
});
expect(service.pending({
  herdrSessionName: "default",
  terminalId: "term_owner",
  workspaceId: "wB",
})).toEqual([expect.objectContaining({ id: worker.id })]);
expect(self.id).toBeLessThan(worker.id);
```

- [x] **Step 2: Run tests to verify red**

Run: `pnpm test test/integration/agent-orchestrator-service.test.ts`

Expected: module/import failures for `AgentOrchestratorService`.

- [x] **Step 3: Implement minimal service**

Rules:

- `claim()` reads `latestEventId(scope)` only when the scope row is absent; pass that value to the store.
- `pending()` first verifies current owner terminal, then calls `listAfter({ ...scope, afterEventId: ackedEventId, limit: scanLimit })`, filters self-terminal events, and returns at most requested limit. Use a bounded scan loop so self events cannot hide later worker events; stop after 1,000 scanned rows per call.
- `ack()` delegates to owner-checked store ack.
- `move()` uses `latestEventId(to)` only if destination row is absent.
- Map persistent `Date` values to ISO strings only at the RPC boundary, not in this service.

- [x] **Step 4: Run service tests**

Run: `pnpm test test/integration/agent-orchestrator-service.test.ts`

Expected: all service behavior passes.

- [x] **Step 5: Commit**

```bash
git add src/observability/agent-orchestrator-service.ts test/integration/agent-orchestrator-service.test.ts
git commit -m "feat(orchestrator): add role service"
```

### Task 2: Resolve Registration to Running Herdr Session and Terminal

**Objective:** Bind untrusted registration params to daemon-indexed identity before any role operation.

**Files:**
- Modify: `src/db/herdr-sessions.ts`
- Create: `src/herdr/pane-identity-resolver.ts`
- Create: `test/integration/herdr-pane-identity-resolver.test.ts`
- Modify: `test/integration/observability-rpc.test.ts`

**Interfaces:**
- Produces: `HerdrSessionStore.findRunningBySocketPath(socketPath)`.
- Consumes: `AgentStore.findByPane()` and terminal-stable records.

- [x] **Step 1: Write failing identity tests**

Add store/RPC tests for:

- exact running socket path resolves `default`;
- stopped session socket path does not resolve;
- register succeeds when socket, workspace, pane, and indexed terminal agree;
- when indexed pane is absent after a move, a fake/live Herdr `pane.get` response for the stale alias returns current `pane_id`, `workspace_id`, and `terminal_id`, and registration uses those authoritative values rather than rejecting the stale requested workspace;
- resolver accepts both direct PaneInfo and `{ pane: PaneInfo }` result shapes, rejects missing identity fields, and always closes its one-shot client;
- wrong workspace for an indexed pane rejects with `Pi presence workspace does not match indexed Herdr pane` only when live alias resolution does not prove a move;
- unresolved pane rejects with `Herdr pane is not indexed yet`;
- null terminal rejects with `Herdr pane has no terminal identity`;
- `subscriberKind !== "pi"` fails schema validation.

- [x] **Step 2: Run red test**

Run: `pnpm test test/integration/observability-rpc.test.ts`

Expected: `agent.orchestrator.register` is unknown and socket lookup is missing.

- [x] **Step 3: Add socket lookup and registration resolver**

Implement:

```ts
findRunningBySocketPath(socketPath: string): HerdrSessionRecord | undefined

export type HerdrPaneIdentity = {
  paneId: string;
  terminalId: string;
  workspaceId: string;
};

export async function resolveHerdrPaneIdentity(input: {
  clientFactory?: (socketPath: string) => Pick<HerdrSocketClient, "close" | "getPane">;
  paneId: string;
  socketPath: string;
}): Promise<HerdrPaneIdentity>;
```

Use exact stored socket path equality and `running = 1`. `resolveHerdrPaneIdentity()` creates one client, awaits `getPane({ pane_id: input.paneId })`, normalizes direct or wrapped pane data, and closes in `finally`.

In the server, make `#resolvePiPresence(input)` async. Use the indexed pane when it agrees with requested workspace and has terminal id. Otherwise call the live resolver through an injected test seam and accept the returned current identity only from the already validated session socket. Return current `herdrSessionName`, `terminalId`, pane/workspace, subscriber metadata, and `connectedAt` from injected clock.

Do not trust a `herdrSessionName` supplied by clients; the registration schema does not accept one.

- [x] **Step 4: Run focused test**

Run: `pnpm test test/integration/herdr-pane-identity-resolver.test.ts test/integration/observability-rpc.test.ts`

Expected: direct/indexed and stale-alias registration cases pass; later routing assertions may remain red until Task 3.

- [x] **Step 5: Commit**

```bash
git add src/db/herdr-sessions.ts src/herdr/pane-identity-resolver.ts src/daemon/observability-server.ts test/integration/herdr-pane-identity-resolver.test.ts test/integration/observability-rpc.test.ts
git commit -m "feat(orchestrator): bind pi presence"
```

### Task 3: Add Connection-Bound RPC and Scoped Stream Routing

**Objective:** Replace all-socket broadcast and subscriber RPCs with owner-only event delivery and scope-local role changes.

**Files:**
- Modify: `src/daemon/observability-server.ts`
- Modify: `src/daemon/service.ts`
- Modify: `src/observability/contracts.ts`
- Modify: `src/observability/schemas.ts`
- Modify: `src/db/schema.ts`
- Modify: `test/integration/observability-rpc.test.ts`
- Modify: `test/integration/observability-db-harness.ts`
- Modify: `test/integration/sqlite-migrations.test.ts`
- Create: generated `drizzle/0002_<generated-name>.sql` and `drizzle/meta/0002_snapshot.json`
- Modify: generated `drizzle/meta/_journal.json`
- Delete: `src/db/agent-notification-cursors.ts`
- Delete: `src/observability/agent-notification-service.ts`

**Interfaces:**
- Consumes: registration resolver and `AgentOrchestratorService`.
- Produces: final RPC/stream surface listed above.

- [x] **Step 1: Write failing two-socket routing tests**

Open three real daemon sockets:

- Pi A registered in `default/wB`, terminal A;
- Pi B registered in `default/wB`, terminal B;
- Pi C registered in `default/wC`, terminal C.

Assert:

1. Before any claim, `publishAgentEvent(wB worker)` reaches nobody.
2. A sets enabled true; A and B receive `agent.orchestrator.changed`, C does not.
3. A receives `wB` worker event; B and C do not.
4. An event with terminal A is delivered to nobody.
5. B sets enabled true; A and B receive changed state naming B; later event reaches B only.
6. A sets enabled false after replacement; response has `changed: false` and B remains owner.
7. B sets enabled false; both A/B receive owner-null change and later events reach nobody.
8. Generic unregistered RPC client receives request responses but no stream notifications.
9. `agent.notifications.ack` from non-owner fails; owner ack advances shared state.
10. Register/reconnect/get as current owner returns pending non-self events; non-owner responses return `events: []`.
11. B's successful `set { enabled: true }` response includes A's still-unacked events immediately; no reconnect is required.

Decode JSONL by method and assert exact scope/owner values, not only method names.

- [x] **Step 2: Run tests to verify red**

Run: `pnpm test test/integration/observability-rpc.test.ts`

Expected: current broadcast sends events to all sockets and new role methods are unknown.

- [x] **Step 3: Make dispatch socket-aware**

Change:

```ts
#dispatch(method: string, params: unknown)
```

to:

```ts
#dispatch(socket: Socket, method: string, params: unknown)
```

Maintain:

```ts
readonly #piPresenceBySocket = new Map<Socket, PiPresence>();
```

Add `#requirePiPresence(socket)` for set/get/ack. Registration replaces any prior presence for the same socket. Build register/get/set responses with one helper that includes pending events only when the caller terminal currently owns the scope; this is the transfer path for a connected Pi that claims from another owner.

- [x] **Step 4: Implement role change and event routing**

- `publishAgentEvent(event)` finds an exact scope owner, rejects null/mismatched `terminalId`, selects the newest connection for the owner terminal, and writes once.
- `#publishOrchestratorChange(change)` sends to registered presences whose exact scope equals `change.previous` or `change.current` scope. This supports cross-scope move in child 03.
- Convert dates with one `toWireState()` helper.
- Set/get responses always include the caller's current presence and current scope state.
- An idempotent owner claim may return `changed: false` without broadcasting.

- [x] **Step 5: Remove subscriber notification code**

Remove `AgentNotificationService` constructor injection and both old RPC cases. Delete the old store/service files now that no active consumer remains. Remove the two legacy Drizzle table declarations and `agentNotificationCursors` from the DB harness. Remove legacy `agentNotificationSubscribeInputSchema`, `agentNotificationAckInputSchema`, `AgentNotificationSubscriptionRecord`, and `AgentNotificationCursorRecord`; validate the remaining `agent.notifications.ack` case with `agentOrchestratorAckInputSchema`.

Update `test/integration/sqlite-migrations.test.ts` to the final six-table list from child 01 without the two legacy notification tables, then run:

```bash
pnpm db:generate
pnpm db:check
```

Expected: Drizzle creates migration index `0002`, drops `agent_notification_cursors` before `agent_notification_subscriptions`, leaves `0000` and `0001` unchanged, and passes schema validation.

Run: `rg "agent\.notifications\.subscribe|subscriptionId|AgentNotification(CursorStore|Service)" src test -n`

Expected: no daemon/source references; shepherd-pi and its old tests may still match until child 04.

- [x] **Step 6: Run routing and migration tests**

Run: `pnpm test test/integration/observability-rpc.test.ts test/integration/agent-orchestrator-service.test.ts test/integration/sqlite-migrations.test.ts`

Expected: all role/stream routing and final-schema tests pass.

- [x] **Step 7: Commit**

```bash
git add src/daemon/observability-server.ts src/daemon/service.ts src/db/schema.ts src/observability/contracts.ts src/observability/schemas.ts test/integration/observability-rpc.test.ts test/integration/observability-db-harness.ts test/integration/sqlite-migrations.test.ts drizzle
git add -u src/db/agent-notification-cursors.ts src/observability/agent-notification-service.ts
git commit -m "feat(orchestrator): route owner notifications"
```

### Task 4: Implement Disconnect and Startup Grace

**Objective:** Preserve role through brief replacement/restart gaps and clear genuinely absent owners.

**Files:**
- Modify: `src/daemon/observability-server.ts`
- Modify: `src/daemon/service.ts`
- Create: `test/integration/orchestrator-disconnect-grace.test.ts`

**Interfaces:**
- Consumes: connection registry and persisted owners.
- Produces: deterministic owner expiry lifecycle.

- [x] **Step 1: Write fake-timer lifecycle tests**

Construct the server with `disconnectGraceMs: 50`, `startupReconnectGraceMs: 100`, and injected `now/setTimeout/clearTimeout` adapters or Vitest fake timers. Assert:

1. Owner socket close leaves role during 49ms and clears after 50ms.
2. Same terminal reconnect with a different subscriber id before 50ms cancels expiry and keeps role.
3. Different terminal connection does not cancel owner expiry.
4. Overlapping old/new sockets for the same terminal: closing old socket schedules no expiry.
5. Persisted owner on server start survives when matching terminal registers inside 100ms.
6. Persisted owner clears with reason `startup_timeout` after 100ms without a match.
7. `server.stop()` cancels timers and closes sockets without clearing DB owner.
8. Expiry broadcasts owner-null change only to still-connected Pi presences in the scope.

- [x] **Step 2: Run tests to verify red**

Run: `pnpm test test/integration/orchestrator-disconnect-grace.test.ts`

Expected: owner never clears or clears immediately because grace lifecycle is absent.

- [x] **Step 3: Implement grace registries**

Use terminal key:

```ts
function terminalPresenceKey(input: { herdrSessionName: string; terminalId: string }): string {
  return `${input.herdrSessionName}\0${input.terminalId}`;
}
```

Maintain one timer per terminal. On socket close/error:

- remove presence;
- if stopping, do nothing else;
- if another registered socket has the same terminal key, do nothing;
- otherwise schedule release after grace;
- at expiry, recheck absence before calling service release.

On register, cancel matching disconnect and startup timers. On `start()`, arm startup timers for `service.persistedOwners()`. On `stop()`, set `#stopping = true` before destroying sockets and clear all timers.

- [x] **Step 4: Run lifecycle and routing tests**

Run: `pnpm test test/integration/orchestrator-disconnect-grace.test.ts test/integration/observability-rpc.test.ts`

Expected: all tests pass without real 5/10 second sleeps.

- [x] **Step 5: Commit**

```bash
git add src/daemon/observability-server.ts src/daemon/service.ts test/integration/orchestrator-disconnect-grace.test.ts
git commit -m "feat(orchestrator): expire disconnected owners"
```

## Validation

- `pnpm test test/integration/agent-orchestrator-service.test.ts`
- `pnpm test test/integration/observability-rpc.test.ts`
- `pnpm test test/integration/orchestrator-disconnect-grace.test.ts`
- `pnpm typecheck`
- `rg "agent\.notifications\.subscribe|AgentNotification(CursorStore|Service)" src test -n` has no active daemon/store matches.

## Risks, Tradeoffs, and Open Questions

- Socket writes can fail after owner selection. Keep events unacked; reconnect replay provides at-least-once delivery.
- A generic client cannot subscribe to streams under the new protocol. This is intentional; `agent.events` remains the explicit pull API.
- Startup grace requires indexed agents before registration can resolve. `runObservabilityDaemonService()` must retain server/watch startup ordering and shepherd-pi retries registration failures.
- No product questions remain for this child plan.

## Next Steps

Completed. Herdr terminal reconciliation was implemented and verified in child 03.
