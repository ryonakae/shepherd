# Contracts, DB Schema, and Migrations Plan

> **For implementers:** Execute this plan task-by-task. Complete each checkbox step, run the listed validation, and commit after each task.

**Goal:** Replace worker/snapshot/context contracts and persistence with Herdr-aligned agent contracts and SQLite tables.

**Architecture:** Define the public data contracts first, then rebuild persistence around Herdr running sessions, workspaces, agents, agent events, notification cursors, and optional compact history cache. Existing DB compatibility is intentionally dropped; generate a fresh migration baseline from the new Drizzle schema.

**Tech Stack:** TypeScript, TypeBox, Drizzle SQLite, `node:sqlite`, Vitest.

## Global Constraints

- Use `agent`, `agent_session`, and `agent history` externally.
- Remove `worker` terminology from non-plan code/docs/tests touched by this rewrite.
- DB is index/cache/push/cursor layer, not source of truth for agent history.
- Existing user DB compatibility is not required.
- Runtime schema must stay TypeBox/Ajv-based.
- DB schema changes require `pnpm db:generate` and generated SQL review.

## Current Context

- Current files to replace or heavily rewrite:
  - `src/observability/contracts.ts`
  - `src/observability/schemas.ts`
  - `src/db/schema.ts`
  - `src/db/workers.ts`
  - `src/db/worker-events.ts`
  - `src/db/worker-snapshots.ts`
  - `src/db/notification-cursors.ts`
  - `test/integration/observability-db-harness.ts`
- Current migrations describe `workers`, `worker_events`, `worker_snapshots`, and old notification tables.

## File Structure

- Modify: `src/observability/contracts.ts` — replace worker contracts with agent/session/workspace/history/event contracts.
- Modify: `src/observability/schemas.ts` — replace old RPC schema names with agent RPC and agent telemetry schemas.
- Modify: `src/db/schema.ts` — define new Drizzle tables.
- Create: `src/db/herdr-sessions.ts` — store running Herdr session index records.
- Create: `src/db/herdr-workspaces.ts` — store workspace index records per Herdr session.
- Create: `src/db/agents.ts` — store agent index records.
- Create: `src/db/agent-events.ts` — store push event records.
- Create: `src/db/agent-history-cache.ts` — store compact history cache keyed by agent/history ref/formatter version.
- Create or rewrite: `src/db/agent-notification-cursors.ts` — store subscriptions and cursors for agent events.
- Modify: `test/integration/observability-db-harness.ts` — expose new stores for integration tests.
- Modify: `test/integration/sqlite-migrations.test.ts` — expect new tables only.
- Create: `test/integration/agent-stores.test.ts` — test stores and cache behavior.
- Modify: `drizzle/*` and `drizzle/meta/*` — generated migration baseline.

## Interfaces

Add these contracts in `src/observability/contracts.ts`:

```ts
export type HerdrSessionRecord = {
  lastScannedAt: Date | null;
  name: string;
  running: boolean;
  sessionDir: string;
  socketPath: string;
  updatedAt: Date;
};

export type HerdrWorkspaceRecord = {
  agentStatus: AgentStatus;
  focused: boolean;
  herdrSessionName: string;
  label: string | null;
  lastSeenAt: Date;
  workspaceId: string;
};

export type AgentStatus = "blocked" | "done" | "idle" | "unknown" | "working";

export type AgentSessionRef = {
  agent: string;
  kind: "id" | "path";
  source: string;
  value: string;
};

export type AgentIndexRecord = {
  agent: string | null;
  agentSession: AgentSessionRef | null;
  agentStatus: AgentStatus;
  cwd: string | null;
  focused: boolean;
  foregroundCwd: string | null;
  herdrSessionName: string;
  id: string;
  lastSeenAt: Date;
  paneId: string;
  tabId: string | null;
  terminalId: string | null;
  workspaceId: string;
};

export type CompactAgentHistory = {
  historyRef: AgentHistoryRef | null;
  lastAssistantMessage: AgentHistoryExcerpt | null;
  lastToolResult: CompactToolResult | null;
  lastUserMessage: AgentHistoryExcerpt | null;
  messageCount: number;
  source: string | null;
  updatedAt: string | null;
};

export type AgentHistoryRef = {
  kind: "agent_session" | "discovered_file";
  path?: string;
  source: "claude-jsonl" | "pi-jsonl" | "unknown";
  value: string;
};

export type AgentHistoryExcerpt = {
  ref: string;
  text: string;
  timestamp: string | null;
};

export type AgentHistoryMessage = {
  compact?: CompactToolResult;
  ref: string;
  role: "assistant" | "tool_result" | "user";
  text: string;
  timestamp: string | null;
  toolName?: string;
};

export type CompactToolResult = {
  compaction: {
    mode:
      | "failure_focus"
      | "grouped_matches"
      | "structured_summary"
      | "truncated_passthrough"
      | "web_sources"
      | "unknown";
    originalChars: number;
    returnedChars: number;
  };
  isError: boolean;
  ref: string;
  text: string;
  toolName: string;
};

export type AgentListItem = AgentIndexRecord & {
  history: Pick<CompactAgentHistory, "lastAssistantMessage" | "lastUserMessage" | "source" | "updatedAt">;
};

export type AgentGetResult = AgentIndexRecord & {
  history: CompactAgentHistory;
};

export type AgentReadResult = AgentIndexRecord & {
  historyRef: AgentHistoryRef | null;
  messages: AgentHistoryMessage[];
};

export type AgentEventType =
  | "agent.status.changed"
  | "agent.blocked"
  | "agent.done"
  | "agent.idle"
  | "agent.tool.failed";

export type AgentEventRecord = {
  agentId: string | null;
  compactHistory: CompactAgentHistory | null;
  createdAt: Date;
  herdrSessionName: string;
  id: number;
  paneId: string | null;
  payload: unknown;
  type: AgentEventType;
  workspaceId: string | null;
};
```

## Tasks

### Task 1: Replace contract and schema surface

**Objective:** Define agent-first TypeScript and TypeBox contracts that later tasks consume.

**Files:**
- Modify: `src/observability/contracts.ts`
- Modify: `src/observability/schemas.ts`
- Test: `test/unit/observability-contracts.test.ts`

**Interfaces:**
- Produces: `AgentListItem`, `AgentGetResult`, `AgentReadResult`, `AgentEventRecord`, `CompactAgentHistory`, `AgentHistoryMessage`.
- Produces schemas: `agentListInputSchema`, `agentGetInputSchema`, `agentReadInputSchema`, `agentEventsInputSchema`, `agentNotificationSubscribeInputSchema`, `agentNotificationAckInputSchema`, `agentTelemetryInputSchema`.

- [ ] **Step 1: Write the failing tests**

In `test/unit/observability-contracts.test.ts`, replace worker telemetry validation cases with these cases:

1. `agentListInputSchema` accepts `{}` and `{ workspaceId: "wB", herdrSessionName: "default" }`.
2. `agentListInputSchema` accepts `{ all: true }`.
3. `agentGetInputSchema` accepts `{ target: "claude", workspaceId: "wB", herdrSessionName: "default" }`.
4. `agentReadInputSchema` accepts `{ target: "wB:p2", limit: 10 }` and rejects `limit: 0` and `limit: 501`.
5. `agentTelemetryInputSchema` accepts a Pi tool result event with type `agent.tool.completed` and no `workerKey`.
6. Old worker schemas are not exported from `src/observability/schemas.ts`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test test/unit/observability-contracts.test.ts`

Expected: TypeScript or Vitest failures because new schema exports do not exist yet.

- [ ] **Step 3: Write minimal implementation**

Replace worker contracts with the interfaces listed above. In `schemas.ts`, define TypeBox schemas that match the contract names exactly. Use these input shapes. Do not use `Type.Intersect` with closed objects here because each branch would reject fields from the other branch.

```ts
export const agentListInputSchema = Type.Object(
  {
    all: Type.Optional(Type.Boolean()),
    herdrSessionName: Type.Optional(Type.String({ minLength: 1 })),
    workspaceId: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

export const agentGetInputSchema = Type.Object(
  {
    herdrSessionName: Type.Optional(Type.String({ minLength: 1 })),
    target: Type.String({ minLength: 1 }),
    workspaceId: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

export const agentReadInputSchema = Type.Object(
  {
    herdrSessionName: Type.Optional(Type.String({ minLength: 1 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
    target: Type.String({ minLength: 1 }),
    workspaceId: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);
```

For telemetry, replace `worker.tool.completed` with `agent.tool.completed` and `worker.message.final` with `agent.message.final`. Keep redaction and excerpt fields bounded to 4096 chars.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test test/unit/observability-contracts.test.ts`

Expected: All contract/schema tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/observability/contracts.ts src/observability/schemas.ts test/unit/observability-contracts.test.ts
git commit -m "contracts: define agent history surface"
```

### Task 2: Replace DB schema and stores

**Objective:** Replace old worker tables with Herdr session, workspace, agent, event, cache, and cursor stores.

**Files:**
- Modify: `src/db/schema.ts`
- Create: `src/db/herdr-sessions.ts`
- Create: `src/db/herdr-workspaces.ts`
- Create: `src/db/agents.ts`
- Create: `src/db/agent-events.ts`
- Create: `src/db/agent-history-cache.ts`
- Create: `src/db/agent-notification-cursors.ts`
- Test: `test/integration/agent-stores.test.ts`
- Modify: `test/integration/observability-db-harness.ts`

**Interfaces:**
- Consumes: contracts from Task 1.
- Produces store classes: `HerdrSessionStore`, `HerdrWorkspaceStore`, `AgentStore`, `AgentEventStore`, `AgentHistoryCacheStore`, `AgentNotificationCursorStore`.

- [ ] **Step 1: Write the failing tests**

Create `test/integration/agent-stores.test.ts` with these cases:

1. `HerdrSessionStore.upsertRunning()` inserts and updates a session by `name`; `markStoppedMissingFrom([...])` marks absent running sessions as `running=false`.
2. `HerdrWorkspaceStore.replaceForSession()` replaces workspace rows for one Herdr session without touching another session.
3. `AgentStore.replaceForSession()` upserts agents by `(herdrSessionName, paneId)`, preserves stable generated `id`, and removes agents absent from the latest snapshot for that session.
4. `AgentStore.resolveTarget()` resolves pane id, terminal id, and unique agent name within `(herdrSessionName, workspaceId)` and throws an error containing all candidates when ambiguous.
5. `AgentEventStore.append()` dedupes by `(herdrSessionName, idempotencyKey)` when an idempotency key is present.
6. `AgentHistoryCacheStore.getFresh()` returns a cache only when path, source mtime, source size, and formatter version match.
7. `AgentNotificationCursorStore` subscribes, lists pending agent events, and acks by event id.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test test/integration/agent-stores.test.ts`

Expected: Imports fail because new store files do not exist.

- [ ] **Step 3: Write minimal implementation**

Define these tables in `src/db/schema.ts`:

```ts
export const herdrSessions = sqliteTable("herdr_sessions", {
  lastScannedAt: integer("last_scanned_at", { mode: "timestamp_ms" }),
  name: text("name").primaryKey(),
  running: integer("running", { mode: "boolean" }).notNull(),
  sessionDir: text("session_dir").notNull(),
  socketPath: text("socket_path").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const herdrWorkspaces = sqliteTable(
  "herdr_workspaces",
  {
    agentStatus: text("agent_status", { enum: ["blocked", "done", "idle", "unknown", "working"] }).notNull(),
    focused: integer("focused", { mode: "boolean" }).notNull(),
    herdrSessionName: text("herdr_session_name").notNull().references(() => herdrSessions.name, { onDelete: "cascade" }),
    label: text("label"),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }).notNull(),
    workspaceId: text("workspace_id").notNull(),
  },
  (table) => [uniqueIndex("herdr_workspaces_session_workspace_idx").on(table.herdrSessionName, table.workspaceId)],
);

export const agents = sqliteTable(
  "agents",
  {
    agent: text("agent"),
    agentSessionJson: text("agent_session_json"),
    agentStatus: text("agent_status", { enum: ["blocked", "done", "idle", "unknown", "working"] }).notNull(),
    cwd: text("cwd"),
    firstSeenAt: integer("first_seen_at", { mode: "timestamp_ms" }).notNull(),
    focused: integer("focused", { mode: "boolean" }).notNull(),
    foregroundCwd: text("foreground_cwd"),
    herdrSessionName: text("herdr_session_name").notNull().references(() => herdrSessions.name, { onDelete: "cascade" }),
    id: text("id").primaryKey(),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }).notNull(),
    paneId: text("pane_id").notNull(),
    tabId: text("tab_id"),
    terminalId: text("terminal_id"),
    workspaceId: text("workspace_id").notNull(),
  },
  (table) => [
    uniqueIndex("agents_session_pane_idx").on(table.herdrSessionName, table.paneId),
    uniqueIndex("agents_session_terminal_idx").on(table.herdrSessionName, table.terminalId),
  ],
);

export const agentEvents = sqliteTable(
  "agent_events",
  {
    agentId: text("agent_id").references(() => agents.id, { onDelete: "set null" }),
    compactHistoryJson: text("compact_history_json"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    herdrSessionName: text("herdr_session_name").notNull().references(() => herdrSessions.name, { onDelete: "cascade" }),
    id: integer("id").primaryKey({ autoIncrement: true }),
    idempotencyKey: text("idempotency_key"),
    paneId: text("pane_id"),
    payloadJson: text("payload_json").notNull(),
    type: text("type").notNull(),
    workspaceId: text("workspace_id"),
  },
  (table) => [uniqueIndex("agent_events_session_idempotency_idx").on(table.herdrSessionName, table.idempotencyKey)],
);
```

Also add `agent_history_cache`, `agent_notification_subscriptions`, and `agent_notification_cursors` tables. Keep cursor columns equivalent to the current notification cursor semantics: `acked_event_id`, `delivered_event_id`, `hidden_context_event_id`, and `auto_resume_event_id`, but reference agent notification subscriptions.

Implement store classes with explicit map functions. Do not keep compatibility wrappers named `WorkerStore`, `WorkerEventStore`, or `WorkerSnapshotStore`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test test/integration/agent-stores.test.ts`

Expected: All new store tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts src/db/herdr-sessions.ts src/db/herdr-workspaces.ts src/db/agents.ts src/db/agent-events.ts src/db/agent-history-cache.ts src/db/agent-notification-cursors.ts test/integration/agent-stores.test.ts test/integration/observability-db-harness.ts
git commit -m "db: replace worker persistence with agent index"
```

### Task 3: Reset migrations for the new schema

**Objective:** Generate and verify SQLite migrations for the new agent schema.

**Files:**
- Modify: `drizzle/*.sql`
- Modify: `drizzle/meta/*.json`
- Modify: `test/integration/sqlite-migrations.test.ts`

**Interfaces:**
- Consumes: Drizzle schema from Task 2.
- Produces: migration baseline matching new table names.

- [ ] **Step 1: Update migration test**

In `test/integration/sqlite-migrations.test.ts`, update expected table list to exactly:

```ts
[
  "agent_events",
  "agent_history_cache",
  "agent_notification_cursors",
  "agent_notification_subscriptions",
  "agents",
  "herdr_sessions",
  "herdr_workspaces",
]
```

The test must also assert that no table name starts with `worker` and that `observed_workspaces` and `worker_snapshots` are absent.

- [ ] **Step 2: Run migration test to verify it fails**

Run: `pnpm test test/integration/sqlite-migrations.test.ts`

Expected: Test fails because existing migrations still create old tables.

- [ ] **Step 3: Regenerate migrations**

Because DB compatibility is intentionally dropped, remove old generated migration files under `drizzle/` and `drizzle/meta/`, then run:

```bash
pnpm db:generate
```

Expected: Drizzle generates a new baseline SQL and meta snapshot for the new schema.

- [ ] **Step 4: Verify migration test and Drizzle check**

Run:

```bash
pnpm test test/integration/sqlite-migrations.test.ts
pnpm db:check
```

Expected: Migration test passes and Drizzle reports no schema drift.

- [ ] **Step 5: Commit**

```bash
git add drizzle test/integration/sqlite-migrations.test.ts
git commit -m "db: reset migrations for agent schema"
```

## Validation

- `pnpm test test/unit/observability-contracts.test.ts`
- `pnpm test test/integration/agent-stores.test.ts`
- `pnpm test test/integration/sqlite-migrations.test.ts`
- `pnpm db:check`

## Risks, Tradeoffs, and Open Questions

- `uniqueIndex` on nullable `terminalId` may allow multiple nulls in SQLite. Target resolution must not rely on null uniqueness.
- Drizzle migration reset is destructive by design. Do not try to preserve old DB rows.
- This child plan does not update CLI/daemon call sites; they will fail until later child plans adapt imports. Use targeted tests during this child plan and full `pnpm check` after all children.
