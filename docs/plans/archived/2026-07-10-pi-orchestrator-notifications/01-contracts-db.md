# Contracts, Scope Persistence, Shared Cursor, and Terminal-Stable Events Plan

> **For implementers:** Execute this plan task-by-task. Complete each checkbox step, run the listed validation, and commit after each task.

**Status:** Completed

**Goal:** Replace subscriber-scoped notification persistence with one orchestrator assignment and unread cursor per Herdr session/workspace, and make agent events carry stable terminal identity.

**Architecture:** Runtime schemas define connection-bound orchestrator registration/set/get/ack requests and wire-safe role state. SQLite stores one row keyed by `(herdr_session_name, workspace_id)` with nullable owner terminal/pane and a monotonic `acked_event_id`; a row is initialized at the latest event only on first claim. Agent records and events use terminal identity so role ownership and self-event filtering survive public pane id changes.

**Tech Stack:** TypeScript, TypeBox/Ajv, Node `DatabaseSync`, Drizzle SQLite schema/migrations, Vitest.

## Global Constraints

- Inherit all constraints from the parent plan.
- Do not retain subscriber-scoped notification stores or compatibility RPC schemas.
- Composite scope identity is always `{ herdrSessionName, workspaceId }` in TypeScript and `(herdr_session_name, workspace_id)` in SQL.
- `ownerTerminalId` and `ownerPaneId` are both null or both non-null.
- `ackedEventId` only moves forward.
- A missing scope row means “never initialized”; an existing row with null owner means “initialized but currently ownerless.”
- Existing `agent_events` rows may have null `terminal_id` after migration. New events created from indexed agents must set it.

## Current Context

- Contracts: `src/observability/contracts.ts`
- Runtime schemas: `src/observability/schemas.ts`
- Drizzle schema: `src/db/schema.ts`
- Event store: `src/db/agent-events.ts`
- Agent store: `src/db/agents.ts`
- Existing subscriber stores: `src/db/agent-notification-cursors.ts`, `src/observability/agent-notification-service.ts`
- DB harness: `test/integration/observability-db-harness.ts`
- Current migration assertion still expects `agent_notification_subscriptions` and `agent_notification_cursors`.

## File Structure

- Modify: `src/observability/contracts.ts` — scope, owner, role state/change, presence registration, and terminal-stable event types.
- Modify: `src/observability/schemas.ts` — strict orchestrator RPC input schemas and connection-bound ack schema.
- Modify: `test/unit/observability-contracts.test.ts` — schema acceptance/rejection tests.
- Create: `src/db/agent-orchestrator-scopes.ts` — atomic owner and cursor persistence.
- Create: `test/integration/agent-orchestrator-scope-store.test.ts` — first claim, replacement, release, move, and monotonic ack tests.
- Modify: `src/db/schema.ts` — new scope table and `agent_events.terminal_id`.
- Create: `drizzle/0001_<generated-name>.sql` and matching `drizzle/meta/*` updates — generated migration; exact suffix comes from Drizzle.
- Modify: `test/integration/sqlite-migrations.test.ts` — final table/column assertions.
- Modify: `test/integration/observability-db-harness.ts` — expose the new store alongside the old cursor store until child 02.
- Modify: `src/db/agent-events.ts` — persist/map `terminalId`.
- Modify: `src/db/agents.ts` — terminal lookup and terminal-first stable refresh.
- Create: `test/integration/agent-store-terminal-identity.test.ts` — pane move preserves agent id and terminal lookup.
- Retain temporarily: `src/db/agent-notification-cursors.ts`, `src/observability/agent-notification-service.ts` — keep the current daemon compiling until child 02 migrates all consumers and deletes both files.

## Interfaces

Add these contracts in `src/observability/contracts.ts`:

```ts
export type AgentScope = {
  herdrSessionName: string;
  workspaceId: string;
};

export type AgentOrchestratorOwner = {
  paneId: string;
  terminalId: string;
};

export type AgentOrchestratorState = AgentScope & {
  ackedEventId: number;
  owner: AgentOrchestratorOwner | null;
  updatedAt: Date;
};

export type AgentOrchestratorWireState = AgentScope & {
  ackedEventId: number;
  owner: AgentOrchestratorOwner | null;
  updatedAt: string;
};

export type AgentOrchestratorChangeReason =
  | "claimed"
  | "disconnected"
  | "moved"
  | "released"
  | "startup_timeout";

export type AgentOrchestratorChanged = {
  current: AgentOrchestratorWireState;
  previous: AgentOrchestratorWireState;
  reason: AgentOrchestratorChangeReason;
};

export type PiPresenceRegistration = {
  autoResume: boolean;
  herdrSocketPath: string;
  paneId: string;
  subscriberId: string;
  subscriberKind: "pi";
  workspaceId: string;
};
```

Extend `AgentEventRecord` with:

```ts
terminalId: string | null;
```

Export strict schemas with these exact names and shapes:

```ts
export const agentOrchestratorRegisterInputSchema = Type.Object(
  {
    autoResume: Type.Optional(Type.Boolean()),
    herdrSocketPath: Type.String({ minLength: 1 }),
    paneId: Type.String({ minLength: 1 }),
    subscriberId: Type.String({ minLength: 1 }),
    subscriberKind: Type.Literal("pi"),
    workspaceId: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const agentOrchestratorSetInputSchema = Type.Object(
  { enabled: Type.Boolean() },
  { additionalProperties: false },
);

export const agentOrchestratorGetInputSchema = Type.Object({}, { additionalProperties: false });

export const agentOrchestratorAckInputSchema = Type.Object(
  { eventId: Type.Integer({ minimum: 1 }) },
  { additionalProperties: false },
);
```

The persistent store API is:

```ts
export type AgentOrchestratorScopeKey = {
  herdrSessionName: string;
  workspaceId: string;
};

export type ClaimOrchestratorInput = AgentOrchestratorScopeKey & {
  initialAckedEventId: number;
  paneId: string;
  terminalId: string;
};

export class AgentOrchestratorScopeStore {
  constructor(sqlite: DatabaseSync);
  get(scope: AgentOrchestratorScopeKey): AgentOrchestratorState | undefined;
  listOwnedForSession(herdrSessionName: string): AgentOrchestratorState[];
  claim(input: ClaimOrchestratorInput): {
    current: AgentOrchestratorState;
    previous: AgentOrchestratorState;
  };
  // On first claim, previous is a synthetic ownerless state with the same
  // initialAckedEventId and timestamp as the inserted current state.
  releaseIfOwner(input: AgentOrchestratorScopeKey & { terminalId: string }): {
    changed: boolean;
    current: AgentOrchestratorState | undefined;
    previous: AgentOrchestratorState | undefined;
  };
  moveOwner(input: {
    from: AgentOrchestratorScopeKey;
    initialTargetAckedEventId: number;
    paneId: string;
    terminalId: string;
    to: AgentOrchestratorScopeKey;
  }): Array<{ current: AgentOrchestratorState; previous: AgentOrchestratorState }>;
  ack(input: AgentOrchestratorScopeKey & { eventId: number; terminalId: string }): AgentOrchestratorState;
}
```

## Tasks

### Task 1: Define Orchestrator and Connection-Bound RPC Contracts

**Objective:** Make every later layer compile against one explicit role/presence contract and reject legacy subscriber ack inputs.

**Files:**
- Modify: `src/observability/contracts.ts`
- Modify: `src/observability/schemas.ts`
- Modify: `test/unit/observability-contracts.test.ts`

**Interfaces:**
- Produces: all types and schemas listed above.
- Consumes: existing TypeBox conventions and `AgentEventRecord`.

- [x] **Step 1: Write failing schema tests**

Add tests that assert:

```ts
expect(
  Value.Check(agentOrchestratorRegisterInputSchema, {
    autoResume: false,
    herdrSocketPath: "/tmp/herdr.sock",
    paneId: "wB:p1",
    subscriberId: "pi-session-1",
    subscriberKind: "pi",
    workspaceId: "wB",
  }),
).toBe(true);
expect(
  Value.Check(agentOrchestratorRegisterInputSchema, {
    herdrSocketPath: "/tmp/herdr.sock",
    paneId: "wB:p1",
    subscriberId: "pi-session-1",
    subscriberKind: "claude",
    workspaceId: "wB",
  }),
).toBe(false);
expect(Value.Check(agentOrchestratorSetInputSchema, { enabled: true })).toBe(true);
expect(Value.Check(agentOrchestratorSetInputSchema, { enabled: false })).toBe(true);
expect(Value.Check(agentOrchestratorSetInputSchema, {})).toBe(false);
expect(Value.Check(agentOrchestratorGetInputSchema, {})).toBe(true);
expect(Value.Check(agentOrchestratorAckInputSchema, { eventId: 42 })).toBe(true);
expect(
  Value.Check(agentOrchestratorAckInputSchema, {
    eventId: 42,
    subscriptionId: "ans_legacy",
  }),
).toBe(false);
```

Also add a compile-time fixture assigning an `AgentEventRecord` with `terminalId: "term_1"` and an `AgentOrchestratorChanged` with ISO `updatedAt` strings.

- [x] **Step 2: Run tests to verify red**

Run: `pnpm test test/unit/observability-contracts.test.ts`

Expected: import/type failures for the new orchestrator schemas/contracts.

- [x] **Step 3: Add the contracts and schemas**

Implement the exact interfaces above. Keep legacy `agentNotificationAckInputSchema`, `AgentNotificationSubscriptionRecord`, and `AgentNotificationCursorRecord` temporarily so the old daemon compiles through child 01. Child 02 Task 3 must switch to `agentOrchestratorAckInputSchema` and remove those legacy contracts in the same commit that deletes their consumers.

- [x] **Step 4: Run focused tests**

Run: `pnpm test test/unit/observability-contracts.test.ts`

Expected: all contract tests pass.

- [x] **Step 5: Commit**

```bash
git add src/observability/contracts.ts src/observability/schemas.ts test/unit/observability-contracts.test.ts
git commit -m "feat(orchestrator): define role contracts"
```

### Task 2: Add Scope Persistence Alongside Subscriber Cursor Tables

**Objective:** Persist one owner and one cursor per exact Herdr session/workspace scope.

**Files:**
- Create: `src/db/agent-orchestrator-scopes.ts`
- Create: `test/integration/agent-orchestrator-scope-store.test.ts`
- Modify: `src/db/schema.ts`
- Modify: `test/integration/observability-db-harness.ts`
- Modify: `test/integration/sqlite-migrations.test.ts`
- Retain temporarily: `src/db/agent-notification-cursors.ts`, `src/observability/agent-notification-service.ts`
- Create: generated `drizzle/0001_<generated-name>.sql`
- Modify: generated `drizzle/meta/_journal.json`
- Create: generated `drizzle/meta/0001_snapshot.json`

**Interfaces:**
- Consumes: `AgentOrchestratorState`, `AgentOrchestratorScopeKey`.
- Produces: `AgentOrchestratorScopeStore`.

- [x] **Step 1: Write failing store tests**

Cover these cases with a fresh DB harness:

1. `get()` returns `undefined` before first claim.
2. First `claim({ initialAckedEventId: 12 })` creates owner and cursor 12; its returned `previous` is the same scope/cursor/timestamp with `owner: null`.
3. A second claim in the same scope changes owner but preserves cursor 12.
4. Reclaim by the same terminal with a changed pane updates `ownerPaneId` without resetting cursor.
5. `releaseIfOwner()` from a different terminal returns `changed: false` and preserves owner.
6. `releaseIfOwner()` from the owner nulls owner fields but preserves cursor.
7. `ack(20)` followed by `ack(18)` leaves cursor 20.
8. `ack()` from a non-owner throws `Only the current orchestrator can acknowledge notifications`.
9. `moveOwner()` clears the old scope and claims the destination atomically; an existing destination owner is replaced, source cursor is preserved, and a previously initialized destination cursor is preserved.
10. Moving to a never-initialized destination uses `initialTargetAckedEventId`.
11. `listOwnedForSession()` excludes ownerless rows and other Herdr sessions.

Use explicit expected records, for example:

```ts
expect(store.get({ herdrSessionName: "default", workspaceId: "wB" })).toMatchObject({
  ackedEventId: 12,
  herdrSessionName: "default",
  owner: { paneId: "wB:p1", terminalId: "term_1" },
  workspaceId: "wB",
});
```

- [x] **Step 2: Run tests to verify red**

Run: `pnpm test test/integration/agent-orchestrator-scope-store.test.ts test/integration/sqlite-migrations.test.ts`

Expected: the new store/table is missing and migration assertions still contain legacy notification tables.

- [x] **Step 3: Define the Drizzle table**

Add nullable `terminalId: text("terminal_id")` to `agentEvents`, then add this table without removing the two legacy notification table declarations:

```ts
export const agentOrchestratorScopes = sqliteTable(
  "agent_orchestrator_scopes",
  {
    ackedEventId: integer("acked_event_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    herdrSessionName: text("herdr_session_name")
      .notNull()
      .references(() => herdrSessions.name, { onDelete: "cascade" }),
    ownerPaneId: text("owner_pane_id"),
    ownerTerminalId: text("owner_terminal_id"),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    workspaceId: text("workspace_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.herdrSessionName, table.workspaceId] }),
  ],
);
```

Import `primaryKey` from `drizzle-orm/sqlite-core`. Do not add subscriber/session ids or auto-election fields.

- [x] **Step 4: Implement the store transactionally**

Use `DatabaseSync.exec("begin immediate")`, `commit`, and rollback in a private transaction helper. `claim()` inserts when absent using `initialAckedEventId` and returns a synthetic ownerless `previous` with the insert timestamp; otherwise it updates only owner fields and `updated_at`. `moveOwner()` must mutate source and target within one transaction and return both externally visible changes. Validate the paired null invariant while mapping rows and throw on corrupt rows.

- [x] **Step 5: Update the harness and migration assertions**

Expose `agentOrchestratorScopes: new AgentOrchestratorScopeStore(sqlite)` alongside `agentNotificationCursors` so the current daemon integration tests remain green. Update expected tables for migration `0001` to:

```ts
[
  "agent_events",
  "agent_history_cache",
  "agent_notification_cursors",
  "agent_notification_subscriptions",
  "agent_orchestrator_scopes",
  "agents",
  "herdr_sessions",
  "herdr_workspaces",
]
```

Also assert `pragma table_info(agent_orchestrator_scopes)` contains `acked_event_id`, `herdr_session_name`, `owner_pane_id`, `owner_terminal_id`, and `workspace_id`, and `pragma table_info(agent_events)` contains nullable `terminal_id`.

- [x] **Step 6: Generate and inspect migration 0001**

Run: `pnpm db:generate`

Expected: Drizzle creates migration index `0001`, creates `agent_orchestrator_scopes`, adds nullable `agent_events.terminal_id`, retains both legacy notification tables, and leaves migration `0000` unchanged. Inspect generated SQL and metadata; do not hand-rename the generated suffix.

- [x] **Step 7: Run focused tests**

Run: `pnpm test test/integration/agent-orchestrator-scope-store.test.ts test/integration/sqlite-migrations.test.ts && pnpm db:check`

Expected: store and migration tests pass; Drizzle reports no schema/migration inconsistency.

- [x] **Step 8: Keep legacy consumers compiling until child 02**

Do not delete `AgentNotificationCursorStore` or `AgentNotificationService` in this task: `ObservabilityRpcServer` still constructs them. Migration `0001` deliberately retains their backing tables, so the current daemon and full test suite remain runnable. Child 02 must migrate daemon construction, remove the old Drizzle declarations, generate migration `0002`, and delete both classes in one compiling commit.

- [x] **Step 9: Commit**

```bash
git add src/db/schema.ts src/db/agent-orchestrator-scopes.ts test/integration/agent-orchestrator-scope-store.test.ts test/integration/observability-db-harness.ts test/integration/sqlite-migrations.test.ts drizzle
git commit -m "feat(orchestrator): persist workspace owner"
```

### Task 3: Preserve Terminal Identity Across Agent Refresh and Events

**Objective:** Keep a stable agent row and terminal id when Herdr changes a public pane id, and store terminal identity on each new event.

**Files:**
- Modify: `src/db/schema.ts`
- Modify: `src/db/agents.ts`
- Modify: `src/db/agent-events.ts`
- Modify: `src/observability/agent-index-service.ts`
- Create: `test/integration/agent-store-terminal-identity.test.ts`
- Modify: tests that construct `AgentEventRecord`
- Consume: generated migration `0001_<generated-name>.sql`, which already includes nullable `agent_events.terminal_id` from Task 2.

**Interfaces:**
- Produces: `AgentStore.findByTerminal()` and `AgentEventRecord.terminalId` persistence.
- Consumes: Herdr snapshot fields `terminal_id`, `pane_id`, and `workspace_id`.

- [x] **Step 1: Write failing terminal identity tests**

Seed one Pi agent in `default/wA` with pane `wA:p1`, terminal `term_1`, capture its generated agent id, then call `replaceForSession()` with the same terminal at `wB:p3`. Assert:

```ts
expect(agents.findByTerminal({ herdrSessionName: "default", terminalId: "term_1" })).toMatchObject({
  id: originalId,
  paneId: "wB:p3",
  terminalId: "term_1",
  workspaceId: "wB",
});
expect(agents.findByPane({ herdrSessionName: "default", paneId: "wA:p1" })).toBeUndefined();
```

Append an event with `terminalId: "term_1"`, close/reopen via store access, and assert `get(event.id).terminalId === "term_1"`. Add a null terminal test for migrated/unknown events.

- [x] **Step 2: Run tests to verify red**

Run: `pnpm test test/integration/agent-store-terminal-identity.test.ts`

Expected: `findByTerminal` is missing, the moved snapshot conflicts or changes agent id, and event terminal identity is absent.

- [x] **Step 3: Add terminal id to event schema/store**

Add nullable `terminalId: text("terminal_id")` to `agentEvents`. Update `AgentEventRow`, `append()`, insert SQL, and `mapAgentEvent()`. Update every `AgentEventStore.append()` call in `AgentIndexService` to pass `current.terminalId`.

- [x] **Step 4: Make terminal id the preferred agent identity**

Add:

```ts
findByTerminal(input: {
  herdrSessionName: string;
  terminalId: string;
}): AgentIndexRecord | undefined;
```

In `replaceForSession()`, choose an existing row by non-null terminal id first and pane id second. When terminal identity exists, update that row by stable `id`, including pane/workspace/tab fields, instead of inserting a second row that conflicts with `agents_session_terminal_idx`. Keep pane fallback only for Herdr records without terminal identity. Remove rows not represented by the refreshed snapshot after all stable updates complete.

Wrap the refresh in a DB transaction and add a temporary-pane update phase for any stable terminal whose destination pane currently conflicts, so multi-agent moves cannot violate `agents_session_pane_idx`. Temporary values must use an internal prefix such as `__shepherd_moving__:<agent-id>` and never escape the transaction.

- [x] **Step 5: Verify migration still matches the implemented event store**

Run: `pnpm db:check`

Expected: the existing generated migration `0001` already includes nullable `agent_events.terminal_id`; Drizzle check passes without generating another migration.

- [x] **Step 6: Update fixtures and run tests**

Add `terminalId: null` or a concrete id to direct `AgentEventRecord` object literals in tests. Run:

`pnpm test test/integration/agent-store-terminal-identity.test.ts test/unit/herdr-session-watch-manager.test.ts test/integration/observability-rpc.test.ts test/integration/sqlite-migrations.test.ts`

Expected: all listed tests pass and the moved agent retains its original id.

- [x] **Step 7: Commit**

```bash
git add src/db/schema.ts src/db/agents.ts src/db/agent-events.ts src/observability/agent-index-service.ts test/integration/agent-store-terminal-identity.test.ts test drizzle
git commit -m "fix(index): preserve terminal identity on moves"
```

## Validation

- `pnpm test test/unit/observability-contracts.test.ts`
- `pnpm test test/integration/agent-orchestrator-scope-store.test.ts`
- `pnpm test test/integration/agent-store-terminal-identity.test.ts`
- `pnpm test test/integration/sqlite-migrations.test.ts`
- `pnpm db:check`
- After child 02 Task 3, `rg "AgentNotification(CursorStore|Service)|agent_notification_(subscriptions|cursors)" src test -n` returns no active code references; generated migration SQL may contain old table names only in `DROP TABLE` statements.

## Risks, Tradeoffs, and Open Questions

- Drizzle-generated migration suffix is intentionally not predetermined; migration index and required SQL effects are exact.
- Updating moving agents in place must avoid pane/terminal unique-index collisions. The transaction and temporary pane phase are required, not an optional refactor.
- Historical event rows receive null terminal ids. The first claim starts at the latest event, so those rows do not enter the new notification stream.
- No product questions remain for this child plan.

## Next Steps

Completed. Daemon presence and routing were implemented and verified in child 02.
