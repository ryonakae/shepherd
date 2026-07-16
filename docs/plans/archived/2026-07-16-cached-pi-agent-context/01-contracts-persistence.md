# Contracts, Persisted Agent Context, Pane Revisions, and Pi Session Identity Plan

> **For implementers:** Execute this plan task-by-task. Complete each checkbox step, run the listed validation, and commit after each task.

**Status:** Completed

**Goal:** Define the final cached-context wire model and persist one latest compact context snapshot per indexed agent, including the pane revision and source fingerprint needed for dirty refresh and safe history-ref reuse.

**Architecture:** `agents` stores current Herdr identity, pane revision, Herdr-reported `agent_session`, and a separate Pi presence session hint. `AgentIndexRecord.agentSession` is projected with strict priority `reported agent_session > presence hint > null`. A new `agent_context_snapshots` table stores the latest compact history, resolved history ref, source fingerprint, observed pane revision, and update time keyed by `agent_id`; a changed terminal occupant/agent clears incompatible hints.

**Tech Stack:** TypeScript, TypeBox/Ajv, Drizzle SQLite, Node `DatabaseSync`, Vitest.

## Global Constraints

- Inherit every constraint from the parent plan.
- Migration is additive and generated after schema tests are red. Do not edit `drizzle/0000_rare_robin_chapel.sql`, `0001_opposite_toxin.sql`, or `0002_worthless_energizer.sql`.
- `paneRevision` is a non-negative integer when present and `null` when Herdr does not provide it. Existing rows migrate with null.
- `AgentContextSnapshotRecord.historyRef` and source fingerprint fields are nullable together when no readable history is known.
- Store a complete `CompactAgentHistory`, including its `historyRef`; do not create a second reduced persisted history shape.
- Pi registration requires a non-null path `sessionRef` with `agent: "pi"`. Reject id refs, empty paths, mismatched agents, and extra properties.
- Keep Herdr-reported `agents.agent_session_json` and Pi-provided `agents.agent_session_hint_json` separate. Effective `AgentIndexRecord.agentSession` is reported ref first, hint second. A null/missing Herdr ref may expose the hint only while the terminal still reports the same agent name.
- Agent row deletion must cascade to its context snapshot.

## Current Context

- `src/observability/contracts.ts` defines `AgentSessionRef`, `AgentIndexRecord`, `CompactAgentHistory`, and `AgentListItem`.
- `src/observability/schemas.ts` already exports `agentSessionRefSchema` and strict orchestrator input schemas.
- `src/db/schema.ts` has `agents.agent_session_json` but no pane revision or latest-agent snapshot relation.
- `src/db/agent-history-cache.ts` caches parsed content by source path/mtime/size but does not link a current agent to a source.
- `AgentStore.replaceForSession()` currently overwrites `agent_session_json` with null whenever Herdr omits `agent_session`.
- `test/integration/observability-db-harness.ts` is the shared store fixture.

## File Structure

- Modify: `src/observability/contracts.ts` — pane revision, persisted snapshot, source fingerprint, workspace snapshot, and registration session-ref types.
- Modify: `src/observability/schemas.ts` — require a strict Pi path ref in presence registration.
- Modify: `test/unit/observability-contracts.test.ts` — acceptance/rejection matrix for final registration shape.
- Modify: `src/db/schema.ts` — `agents.pane_revision`, `agents.agent_session_hint_json`, and `agent_context_snapshots`.
- Generate: `drizzle/0003_<generated-name>.sql` and `drizzle/meta/*` — additive migration.
- Create: `src/db/agent-context-snapshots.ts` — snapshot persistence and mapping.
- Create: `test/integration/agent-context-snapshot-store.test.ts` — round-trip, upsert, null history, and cascade tests.
- Modify: `src/db/agents.ts` — map revisions, keep reported refs and Pi hints separate, and update hints by stable terminal.
- Modify: `test/integration/agent-store-terminal-identity.test.ts` — revision/session-ref precedence and pane-move persistence.
- Modify: `test/integration/observability-db-harness.ts` — expose `agentContextSnapshots`.
- Modify: `test/integration/sqlite-migrations.test.ts` — table, columns, nullability, and foreign-key assertions.

## Interfaces

Add these types to `src/observability/contracts.ts`:

```ts
export type AgentHistorySourceFingerprint = {
  mtimeMs: number;
  path: string;
  size: number;
};

export type AgentContextSnapshotRecord = {
  agentId: string;
  compactHistory: CompactAgentHistory;
  historyRef: AgentHistoryRef | null;
  paneRevision: number | null;
  sourceFingerprint: AgentHistorySourceFingerprint | null;
  updatedAt: Date;
};

export type AgentWorkspaceContextSnapshot = AgentScope & {
  agents: AgentListItem[];
  updatedAt: string;
};
```

Extend existing types exactly:

```ts
export type AgentIndexRecord = {
  // existing fields remain
  paneRevision: number | null;
};

export type PiPresenceRegistration = {
  herdrSocketPath: string;
  paneId: string;
  sessionRef: AgentSessionRef;
  subscriberId: string;
  subscriberKind: "pi";
  workspaceId: string;
};
```

The new store API is:

```ts
export class AgentContextSnapshotStore {
  constructor(sqlite: DatabaseSync);
  get(agentId: string): AgentContextSnapshotRecord | undefined;
  listByAgentIds(agentIds: string[]): AgentContextSnapshotRecord[];
  put(input: Omit<AgentContextSnapshotRecord, "updatedAt">): AgentContextSnapshotRecord;
  delete(agentId: string): void;
}
```

Add this `AgentStore` method:

```ts
setSessionRefByTerminal(input: {
  agentSession: AgentSessionRef;
  herdrSessionName: string;
  terminalId: string;
}): AgentIndexRecord | undefined;
```

## Tasks

### Task 1: Finalize Cached-Context and Presence Contracts

**Objective:** Make later store, daemon, and Pi work compile against one wire/persistence model and require exact Pi session identity at registration.

**Files:**
- Modify: `src/observability/contracts.ts`
- Modify: `src/observability/schemas.ts`
- Modify: `test/unit/observability-contracts.test.ts`

**Interfaces:**
- Produces: `AgentHistorySourceFingerprint`, `AgentContextSnapshotRecord`, `AgentWorkspaceContextSnapshot`, `AgentIndexRecord.paneRevision`, and `PiPresenceRegistration.sessionRef`.
- Consumes: existing `AgentSessionRef`, `AgentScope`, `AgentHistoryRef`, `CompactAgentHistory`, and `AgentListItem`.

- [x] **Step 1: Write failing contract tests**

Add the exact valid registration fixture:

```ts
const validPiRegistration = {
  herdrSocketPath: "/tmp/herdr.sock",
  paneId: "wB:p1",
  sessionRef: {
    agent: "pi",
    kind: "path",
    source: "herdr:pi",
    value: "/tmp/pi-session.jsonl",
  },
  subscriberId: "pi-session",
  subscriberKind: "pi",
  workspaceId: "wB",
};

expect(Value.Check(agentOrchestratorRegisterInputSchema, validPiRegistration)).toBe(true);
```

Add rejection assertions for:

```ts
expect(
  Value.Check(agentOrchestratorRegisterInputSchema, {
    ...validPiRegistration,
    sessionRef: { ...validPiRegistration.sessionRef, kind: "id" },
  }),
).toBe(false);
expect(
  Value.Check(agentOrchestratorRegisterInputSchema, {
    ...validPiRegistration,
    sessionRef: { ...validPiRegistration.sessionRef, agent: "claude" },
  }),
).toBe(false);
expect(
  Value.Check(agentOrchestratorRegisterInputSchema, {
    ...validPiRegistration,
    sessionRef: { ...validPiRegistration.sessionRef, value: "" },
  }),
).toBe(false);
expect(
  Value.Check(agentOrchestratorRegisterInputSchema, {
    herdrSocketPath: "/tmp/herdr.sock",
    paneId: "wB:p1",
    subscriberId: "pi-session",
    subscriberKind: "pi",
    workspaceId: "wB",
  }),
).toBe(false);
```

Add compile-time fixtures for `AgentIndexRecord` with `paneRevision: 42`, a null-history `AgentContextSnapshotRecord`, and an `AgentWorkspaceContextSnapshot` with ISO `updatedAt`.

- [x] **Step 2: Run the contract test to verify red**

Run: `pnpm test test/unit/observability-contracts.test.ts`

Expected: registration without `sessionRef` still passes or the new types/fields are missing.

- [x] **Step 3: Implement the types and strict registration schema**

Define a Pi-specific path schema rather than weakening the shared schema:

```ts
const piPresenceSessionRefSchema = Type.Object(
  {
    agent: Type.Literal("pi"),
    kind: Type.Literal("path"),
    source: Type.String({ minLength: 1 }),
    value: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
```

Add `sessionRef: piPresenceSessionRefSchema` to `agentOrchestratorRegisterInputSchema`, then add the contract types above and `paneRevision` to `AgentIndexRecord`.

- [x] **Step 4: Run the contract test to verify green**

Run: `pnpm test test/unit/observability-contracts.test.ts`

Expected: all schema and compile-time contract tests pass.

- [x] **Step 5: Commit**

```bash
git add src/observability/contracts.ts src/observability/schemas.ts test/unit/observability-contracts.test.ts
git commit -m "feat(observability): define cached agent context contracts"
```

### Task 2: Define the Persisted Agent Context Schema and Migration

**Objective:** Add an additive schema that survives daemon restart and records the revision/source used for each agent snapshot.

**Files:**
- Modify: `src/db/schema.ts`
- Modify: `test/integration/sqlite-migrations.test.ts`
- Generate: `drizzle/0003_<generated-name>.sql`
- Generate: `drizzle/meta/_journal.json`
- Generate: `drizzle/meta/0003_snapshot.json`

**Interfaces:**
- Consumes: Task 1 contracts.
- Produces: `agents.pane_revision`, `agents.agent_session_hint_json`, and `agent_context_snapshots` SQL contracts.

- [x] **Step 1: Write failing migration assertions**

Extend `sqlite-migrations.test.ts` to require:

```ts
expect(tables).toContain("agent_context_snapshots");

const agentColumns = sqlite
  .prepare("pragma table_info(agents)")
  .all()
  .map((row) => row as { dflt_value: string | null; name: string; notnull: number });
expect(agentColumns.find((column) => column.name === "pane_revision")).toMatchObject({
  dflt_value: null,
  notnull: 0,
});
expect(agentColumns.find((column) => column.name === "agent_session_hint_json")).toMatchObject({
  dflt_value: null,
  notnull: 0,
});

const contextColumns = sqlite
  .prepare("pragma table_info(agent_context_snapshots)")
  .all()
  .map((row) => row as { name: string; notnull: number; pk: number });
expect(contextColumns.map((column) => column.name)).toEqual([
  "agent_id",
  "compact_history_json",
  "history_ref_json",
  "pane_revision",
  "source_path",
  "source_mtime_ms",
  "source_size",
  "updated_at",
]);
expect(contextColumns.find((column) => column.name === "agent_id")?.pk).toBe(1);
expect(contextColumns.find((column) => column.name === "history_ref_json")?.notnull).toBe(0);
```

Also assert `pragma foreign_key_list(agent_context_snapshots)` references `agents(id)` with `on_delete = "CASCADE"`.

- [x] **Step 2: Run migration tests to verify red**

Run: `pnpm test test/integration/sqlite-migrations.test.ts`

Expected: `agent_context_snapshots` and `pane_revision` assertions fail.

- [x] **Step 3: Add the Drizzle schema**

Add separate revision/hint fields to `agents`:

```ts
agentSessionHintJson: text("agent_session_hint_json"),
paneRevision: integer("pane_revision"),
```

Add the table:

```ts
export const agentContextSnapshots = sqliteTable("agent_context_snapshots", {
  agentId: text("agent_id")
    .primaryKey()
    .references(() => agents.id, { onDelete: "cascade" }),
  compactHistoryJson: text("compact_history_json").notNull(),
  historyRefJson: text("history_ref_json"),
  paneRevision: integer("pane_revision"),
  sourcePath: text("source_path"),
  sourceMtimeMs: integer("source_mtime_ms"),
  sourceSize: integer("source_size"),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});
```

- [x] **Step 4: Generate and inspect the migration**

Run: `pnpm db:generate`

Expected: one new `0003_*.sql`, one matching metadata snapshot, and one journal entry are generated. Inspect the SQL and verify it only adds nullable `agents.pane_revision` plus `agents.agent_session_hint_json` and creates `agent_context_snapshots`; it must not drop or recreate unrelated tables.

- [x] **Step 5: Run migration validation**

Run: `pnpm test test/integration/sqlite-migrations.test.ts && pnpm db:check`

Expected: migration test and Drizzle check pass.

- [x] **Step 6: Commit**

```bash
git add src/db/schema.ts drizzle test/integration/sqlite-migrations.test.ts
git commit -m "feat(db): persist latest agent context snapshots"
```

### Task 3: Implement Snapshot Persistence

**Objective:** Round-trip exact compact context and source metadata, overwrite atomically by agent id, and cascade cleanup with the agent row.

**Files:**
- Create: `src/db/agent-context-snapshots.ts`
- Create: `test/integration/agent-context-snapshot-store.test.ts`
- Modify: `test/integration/observability-db-harness.ts`

**Interfaces:**
- Consumes: Task 1 `AgentContextSnapshotRecord`; Task 2 table.
- Produces: `AgentContextSnapshotStore` for child 02.

- [x] **Step 1: Write failing store tests**

Create an indexed agent with `harness.agents.replaceForSession()`, then assert:

1. `get()` is initially undefined.
2. `put()` round-trips `CompactAgentHistory`, `historyRef`, `paneRevision`, source fingerprint, and a real `Date`.
3. A second `put()` for the same agent changes the assistant text, revision, and fingerprint without adding a second row.
4. A snapshot with `historyRef: null` and `sourceFingerprint: null` round-trips nullable columns.
5. `listByAgentIds([known, unknown])` returns only the known snapshot.
6. Replacing the Herdr session with no agents deletes the agent and cascades the snapshot.

Use a fixture shaped like:

```ts
const input = {
  agentId: agent.id,
  compactHistory: {
    historyRef: {
      kind: "discovered_file",
      path: "/tmp/claude.jsonl",
      source: "claude-jsonl",
      value: "/tmp/claude.jsonl",
    },
    lastAssistantMessage: { ref: "entry-2", text: "done", timestamp: null },
    lastToolResult: null,
    lastUserMessage: { ref: "entry-1", text: "work", timestamp: null },
    messageCount: 2,
    source: "claude-jsonl",
    updatedAt: "2026-07-16T00:00:00.000Z",
  },
  historyRef: {
    kind: "discovered_file" as const,
    path: "/tmp/claude.jsonl",
    source: "claude-jsonl" as const,
    value: "/tmp/claude.jsonl",
  },
  paneRevision: 42,
  sourceFingerprint: { mtimeMs: 100, path: "/tmp/claude.jsonl", size: 200 },
};
```

- [x] **Step 2: Run the new test to verify red**

Run: `pnpm test test/integration/agent-context-snapshot-store.test.ts`

Expected: import of `AgentContextSnapshotStore` fails.

- [x] **Step 3: Implement the store and harness wiring**

Implement one `insert ... on conflict(agent_id) do update` statement. Enforce nullable ref/fingerprint consistency before SQL:

```ts
if ((input.historyRef === null) !== (input.sourceFingerprint === null)) {
  throw new Error("Agent context history ref and source fingerprint must both be null or non-null");
}
```

Map JSON fields defensively with typed helpers, return `updatedAt: new Date(row.updated_at)`, and add `agentContextSnapshots: new AgentContextSnapshotStore(sqlite)` to the DB harness.

- [x] **Step 4: Run store and migration tests**

Run: `pnpm test test/integration/agent-context-snapshot-store.test.ts test/integration/sqlite-migrations.test.ts`

Expected: all snapshot persistence and migration tests pass.

- [x] **Step 5: Commit**

```bash
git add src/db/agent-context-snapshots.ts test/integration/agent-context-snapshot-store.test.ts test/integration/observability-db-harness.ts
git commit -m "feat(db): add agent context snapshot store"
```

### Task 4: Persist Revisions and Pi Session Hints on Agent Rows

**Objective:** Keep stable terminal identity while recording Herdr revisions and preserving exact Pi path hints across null Herdr snapshots.

**Files:**
- Modify: `src/db/agents.ts`
- Modify: `test/integration/agent-store-terminal-identity.test.ts`
- Modify: every `AgentIndexRecord` test fixture that now requires `paneRevision`

**Interfaces:**
- Consumes: Task 1 `paneRevision` and `sessionRef` contracts.
- Produces: revision-aware `AgentStore` and `setSessionRefByTerminal()` for daemon registration.

- [x] **Step 1: Write failing AgentStore tests**

Add cases proving:

1. `revision: 41` from a Herdr agent snapshot maps to `paneRevision: 41`.
2. Missing revision maps to `null`; later full refreshes must treat null as dirty instead of freezing context.
3. `setSessionRefByTerminal()` writes only `agent_session_hint_json`, stores an exact Pi path, and returns the effective updated row.
4. A later same-terminal/same-agent Herdr refresh with `agent_session: null` and a higher revision preserves/exposes the Pi hint.
5. A Herdr refresh with a non-null authoritative `agent_session` stores it in `agent_session_json` and returns it as effective without deleting the separate Pi hint.
6. When a later Herdr snapshot clears its reported ref, the still-compatible Pi hint becomes effective again.
7. A same-terminal refresh whose detected `agent` changes from `pi` to `claude` clears the incompatible Pi hint when Herdr supplies no replacement.
8. A pane move with the same terminal preserves agent id, reported ref, hint, effective ref, and latest revision.
9. If an existing pane id is reused by a different non-null terminal id, the new occupant receives a new agent id and does not inherit the old reported ref, hint, effective ref, or context snapshot.
10. An unknown terminal passed to `setSessionRefByTerminal()` returns undefined and does not create a row.

- [x] **Step 2: Run the focused test to verify red**

Run: `pnpm test test/integration/agent-store-terminal-identity.test.ts`

Expected: `paneRevision` and `setSessionRefByTerminal` expectations fail.

- [x] **Step 3: Implement revision/session-ref precedence**

Extend `AgentRow`, `mapAgent()`, SQL values, and updates with `agent_session_hint_json` and `pane_revision`. Keep the incoming Herdr value in `agent_session_json`; preserve the prior hint only for the same terminal occupant and same detected agent:

```ts
const reportedSession = parseAgentSessionValue(snapshot.agent.agent_session);
const sameAgent = current?.agent === stringValue(snapshot.agent.agent);
const sessionHint = sameAgent ? current?.agentSessionHint ?? null : null;
const effectiveSession = reportedSession ?? sessionHint;
```

Map only `effectiveSession` to public `AgentIndexRecord.agentSession`; keep reported/hint fields private to the row/store implementation or expose a dedicated internal accessor if tests need them. Use `integerValue(snapshot.agent.revision)` for pane revision. When matching snapshots, use terminal identity first; use pane fallback only when at least one side lacks a terminal id. If both terminal ids are non-null and differ, treat the pane occupant as new. Implement `setSessionRefByTerminal()` by updating only `agent_session_hint_json`, then return `findByTerminal()` so reported-over-hint priority is reapplied.

- [x] **Step 4: Fix compile-time fixtures without changing behavior**

Add `paneRevision: null` or the scenario-specific revision to every `AgentIndexRecord` fixture reported by `pnpm typecheck`. Do not make `paneRevision` optional to avoid fixture updates.

- [x] **Step 5: Run focused and type checks**

Run: `pnpm test test/integration/agent-store-terminal-identity.test.ts test/integration/agent-index-service.test.ts test/unit/herdr-session-watch-manager.test.ts && pnpm typecheck`

Expected: agent identity, index, watcher, and type checks pass.

- [x] **Step 6: Commit**

```bash
git add src/db/agents.ts test/integration/agent-store-terminal-identity.test.ts test/integration/agent-index-service.test.ts test/unit/herdr-session-watch-manager.test.ts
git commit -m "feat(observability): track pane revisions and Pi session refs"
```

## Progress

- [x] Contracts and registration schema finalized
- [x] Additive migration and snapshot store completed
- [x] Agent revision and separate Pi hint persistence completed

## Next Steps

No implementation work remains.

## Completion Evidence

- Contracts, migration `0003_opposite_tarantula.sql`, snapshot persistence, pane revision mapping, terminal identity, and separate Pi hints shipped in `8e6f228`.
- Contract, migration, snapshot-store, terminal-identity, type, and Drizzle checks passed.

## Validation

- `pnpm test test/unit/observability-contracts.test.ts` — strict registration and new types pass.
- `pnpm test test/integration/agent-context-snapshot-store.test.ts` — persisted cache round-trip and cascade pass.
- `pnpm test test/integration/agent-store-terminal-identity.test.ts` — revision and session-ref precedence pass.
- `pnpm test test/integration/sqlite-migrations.test.ts` — final schema columns and FK pass.
- `pnpm typecheck` — all required `AgentIndexRecord` fixtures include `paneRevision`.
- `pnpm db:check` — generated migration metadata is valid.

## Risks, Tradeoffs, and Open Questions

- **Session-ref authority:** `agent_session_json` remains the latest Herdr-reported value and `agent_session_hint_json` remains Pi identity metadata. Mapping chooses reported-over-hint without destroying the lower-priority hint. A changed agent/terminal clears the hint to avoid cross-runtime history selection.
- **Revision compatibility:** Herdr 0.7 snapshots observed in dogfood include revisions in both agent and pane records. Missing values map to null, and child 03 refreshes null-revision agents during each full rescan.
- **Source fingerprint consistency:** the store rejects half-null ref/fingerprint data. Child 02 is responsible for producing a consistent pair.
- **Migration size:** the new table starts empty and `pane_revision` is nullable, so migration does not parse existing JSON or block on history discovery. Child 03 treats null as dirty during recovery scans.
- **No unresolved questions remain in this child.**
