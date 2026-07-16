# History-Ref Reuse and Daemon-Owned Agent Context Cache Plan

> **For implementers:** Execute this plan task-by-task. Complete each checkbox step, run the listed validation, and commit after each task.

**Status:** Completed

**Goal:** Resolve and parse agent history once per dirty agent, reuse the persisted history ref on later updates, and assemble cached agent-list/workspace context without history discovery on read paths.

**Architecture:** `AgentHistoryService` gains an explicit “read this already-resolved ref” path that returns a source fingerprint. A new `AgentContextService` owns ref selection/invalidation, writes `AgentContextSnapshotStore`, joins current agent metadata to persisted compact histories, and produces owner-filtered workspace snapshots. Discovery remains the fallback for missing or invalid refs; cached list/snapshot reads never call discovery.

**Tech Stack:** TypeScript, Node `fs/promises`, existing Pi/Claude/Codex/OpenCode/Gemini readers, SQLite stores, Vitest.

## Global Constraints

- Inherit every constraint from the parent plan and child 01.
- Do not change history parser output, compaction rules, excerpt bounds, or `agent.read` message semantics.
- `AgentHistoryService.read()` remains a live read API for `agent.read`; it accepts a preferred persisted ref and rediscovers only when that ref is absent or invalid.
- A valid preferred history ref bypasses `discoverAgentHistory()`. A missing source, stat failure, or reader failure invalidates it and triggers exactly one discovery fallback; `forceDiscovery` skips the preferred attempt.
- File-backed fingerprints use the real source file path, integer `mtimeMs`, and size. OpenCode uses the DB file path while preserving its session-specific `AgentHistoryRef.value`.
- If stat/read fails, return empty compact history and a null ref/fingerprint only after the preferred ref has been invalidated or discovery also fails; do not throw from background cache refresh for a vanished history file.
- A cached context read (`listAgents`, `workspaceSnapshot`) must execute no `discover`, `stat`, or reader calls.
- Snapshot updates are per agent id. Missing snapshots do not hide the underlying indexed agent from CLI list output.
- Workspace snapshot filtering excludes only the receiving terminal and only at assembly time; persisted data remains complete.

## Current Context

- `createAgentHistoryService().getCompactHistory()` always calls `discoverAgentHistory()` before stat/cache lookup.
- `cacheSourcePathForRef()` already handles file refs and OpenCode session-specific keys.
- `AgentHistoryCacheStore` can reuse parsed compact history after a ref is known.
- Child 01 provides `AgentContextSnapshotStore`, `AgentContextSnapshotRecord`, `AgentHistorySourceFingerprint`, and `AgentIndexRecord.paneRevision`.
- `AgentStore.list(scope)` already filters stopped Herdr sessions and resolves ambiguous workspace/session scope in the RPC server.

## File Structure

- Modify: `src/agent-history/service.ts` — explicit ref resolution/read API with source fingerprint.
- Modify: `test/unit/agent-history-service.test.ts` — preferred-ref bypass, fingerprint, cache hit, vanished path, and OpenCode behavior.
- Create: `src/observability/agent-context-service.ts` — refresh/invalidation, persistence, cached list, and owner-filtered workspace snapshot.
- Create: `test/integration/agent-context-service.test.ts` — discovery matrix, persisted restart behavior, partial cache list, self filter, and zero-history-call reads.
- Modify: `src/daemon/service.ts` — construct the context service once and inject it into later daemon layers; final consumers are wired in child 03.
- Modify: `test/unit/daemon-service.test.ts` only if constructor extraction is needed for testability; do not start the real daemon in unit tests.

## Interfaces

Add this resolved result to `src/agent-history/service.ts`:

```ts
export type ResolvedCompactAgentHistory = {
  compactHistory: CompactAgentHistory;
  historyRef: AgentHistoryRef | null;
  sourceFingerprint: AgentHistorySourceFingerprint | null;
};
```

Extend `AgentHistoryService` with these methods while retaining existing `discover`, `getCompactHistory`, and `read`:

```ts
resolveCompactHistory(
  input: AgentHistoryLookupInput,
  options?: { forceDiscovery?: boolean; preferredRef?: AgentHistoryRef | null },
): Promise<ResolvedCompactAgentHistory>;

readCompactRef(historyRef: AgentHistoryRef): Promise<ResolvedCompactAgentHistory>;

read(
  input: AgentHistoryLookupInput,
  options: { limit: number; preferredRef?: AgentHistoryRef | null },
): Promise<{ historyRef: AgentHistoryRef | null; messages: AgentHistoryMessage[] }>;
```

`getCompactHistory(input)` becomes a compatibility wrapper returning:

```ts
return (await resolveCompactHistory(input)).compactHistory;
```

Create `AgentContextService` with this API:

```ts
export type RefreshAgentContextInput = {
  agent: AgentIndexRecord;
  identityChanged: boolean;
};

export type RefreshAgentContextResult = {
  changed: boolean;
  snapshot: AgentContextSnapshotRecord;
};

export class AgentContextService {
  constructor(options: {
    history: AgentHistoryService;
    stores: {
      agentContextSnapshots: AgentContextSnapshotStore;
      agents: AgentStore;
    };
  });

  refreshAgent(input: RefreshAgentContextInput): Promise<RefreshAgentContextResult>;
  getAgentSnapshot(agentId: string): AgentContextSnapshotRecord | undefined;
  listAgents(scope: AgentQueryScope): AgentListItem[];
  workspaceSnapshot(input: AgentScope & {
    excludeTerminalId: string;
  }): AgentWorkspaceContextSnapshot | null;
}
```

## Tasks

### Task 1: Add Explicit History-Ref Reads

**Objective:** Separate expensive discovery from cheap parsing/cache reuse so dirty refresh can reuse a persisted ref.

**Files:**
- Modify: `src/agent-history/service.ts`
- Modify: `test/unit/agent-history-service.test.ts`

**Interfaces:**
- Produces: `ResolvedCompactAgentHistory`, `resolveCompactHistory()`, and `readCompactRef()`.
- Consumes: existing readers, `AgentHistoryCacheStore`, `cacheSourcePathForRef()`, and child 01 fingerprint type.

- [x] **Step 1: Write failing preferred-ref tests**

Replace the current minimal service fixture with injected fake reader/cache tests that prove:

1. `resolveCompactHistory(input, { preferredRef })` with a valid readable ref never calls discovery and calls the matching reader once on cache miss.
2. The returned fingerprint is `{ path, mtimeMs: Math.trunc(stats.mtimeMs), size }`.
3. A fresh `AgentHistoryCacheStore` result returns without calling the reader.
4. `forceDiscovery: true` ignores `preferredRef` and uses the newly discovered ref.
5. `readCompactRef()` returns null ref/fingerprint plus `emptyCompactHistory(source)` when the source path disappears.
6. OpenCode fingerprint path is the SQLite DB path while `historyRef.value` remains the session id.
7. `read(input, { limit, preferredRef })` bypasses discovery and performs a live reader read from that ref; a missing preferred path falls back to discovery.
8. `resolveCompactHistory()` with a missing preferred path calls discovery exactly once and returns the newly discovered ref.
9. If preferred-ref stat succeeds but its reader throws, `resolveCompactHistory()` invalidates it, calls discovery exactly once, and returns the discovered ref; if that read also fails, it returns null/empty without a discovery loop.
10. `read()` applies the same one-fallback rule for missing/stat-failing/reader-failing preferred refs.
11. `getCompactHistory()` still returns exactly the prior compact shape.

Use temporary files and a reader shaped like:

```ts
const reader = {
  canRead: (ref: AgentHistoryRef) => ref.source === "pi-jsonl",
  async read() {
    return [];
  },
  async readCompact(ref: AgentHistoryRef) {
    readRefs.push(ref);
    return {
      ...emptyCompactHistory("pi-jsonl"),
      historyRef: ref,
      lastAssistantMessage: { ref: "entry", text: "done", timestamp: null },
    };
  },
};
```

- [x] **Step 2: Run the service test to verify red**

Run: `pnpm test test/unit/agent-history-service.test.ts`

Expected: `resolveCompactHistory`/`readCompactRef` do not exist.

- [x] **Step 3: Refactor discovery and ref-reading into one implementation**

Implement `readCompactRef()` as the only place that finds a reader, stats the source path, checks `AgentHistoryCacheStore`, reads compact history, and writes cache. Implement `resolveCompactHistory()` so a valid preferred ref bypasses discovery but a vanished preferred ref falls back immediately:

```ts
if (options.preferredRef && !options.forceDiscovery) {
  const preferred = await readCompactRef(options.preferredRef);
  if (preferred.historyRef) return preferred;
}
const discovered = await discoverAgentHistory({ ...input, ...homeDirOption });
if (!discovered) {
  return {
    compactHistory: emptyCompactHistory(),
    historyRef: null,
    sourceFingerprint: null,
  };
}
return readCompactRef(discovered);
```

For OpenCode, stat `historyRef.path ?? historyRef.value`; preserve the existing `cacheSourcePathForRef()` key. `readCompactRef()` catches stat or reader failure and returns null ref/fingerprint, allowing the caller to rediscover exactly once. `resolveCompactHistory()` must not recursively call itself for fallback: discover once, attempt that ref once, then return null/empty on failure. `read()` follows the same preferred-ref-then-one-discovery rule around the live full read, including reader exceptions.

- [x] **Step 4: Run history service and reader tests**

Run: `pnpm test test/unit/agent-history-service.test.ts test/unit/agent-history-readers.test.ts test/unit/agent-history-discovery.test.ts`

Expected: all history tests pass without parser-output changes.

- [x] **Step 5: Commit**

```bash
git add src/agent-history/service.ts test/unit/agent-history-service.test.ts
git commit -m "refactor(history): support resolved history ref reads"
```

### Task 2: Implement Ref Reuse and Invalidation

**Objective:** Refresh one dirty agent from its authoritative or persisted ref and rediscover only for the agreed invalidation conditions.

**Files:**
- Create: `src/observability/agent-context-service.ts`
- Create: `test/integration/agent-context-service.test.ts`

**Interfaces:**
- Consumes: Task 1 history API and child 01 stores/contracts.
- Produces: `AgentContextService.refreshAgent()`.

- [x] **Step 1: Write the failing invalidation matrix**

Use a real DB harness and a fake `AgentHistoryService` that records `preferredRef` and `forceDiscovery`. Cover these exact cases:

| Existing snapshot | Current agent change | Current source stat | Expected |
| --- | --- | --- | --- |
| none | none | n/a | discovery |
| discovered ref | revision changed upward | mtime/size changed | reuse preferred ref |
| discovered ref | revision changed upward | mtime/size unchanged | force discovery |
| discovered ref | revision reset/decreased | unchanged or changed | force discovery |
| discovered ref | revision unchanged but explicit status refresh calls service | changed or unchanged | reuse preferred ref and reread/cache-check |
| discovered ref | `identityChanged: true` | any | force discovery |
| discovered ref | path deleted | missing | force discovery |
| discovered ref | authoritative `agentSession` now differs | any | use authoritative ref, no global discovery |
| authoritative ref | revision changed but source unchanged | unchanged | retain authoritative ref |
| no resolved history | later dirty refresh | n/a | retry discovery |

The changed result must be false only when the complete persisted payload (compact history JSON, ref, fingerprint, and pane revision) is unchanged. A pane revision advance therefore produces `changed: true` even if compact text is unchanged.

- [x] **Step 2: Run the new service test to verify red**

Run: `pnpm test test/integration/agent-context-service.test.ts`

Expected: module import fails.

- [x] **Step 3: Implement ref compatibility and fingerprint comparison helpers**

Keep helpers private to the context service:

```ts
function sameFingerprint(
  left: AgentHistorySourceFingerprint | null,
  right: AgentHistorySourceFingerprint | null,
): boolean {
  return (
    left?.path === right?.path &&
    left?.mtimeMs === right?.mtimeMs &&
    left?.size === right?.size
  );
}

function sameHistoryRef(left: AgentHistoryRef | null, right: AgentHistoryRef | null): boolean {
  return (
    left?.kind === right?.kind &&
    left?.path === right?.path &&
    left?.source === right?.source &&
    left?.value === right?.value
  );
}
```

Convert an authoritative `AgentSessionRef` with `historySourceFromSessionRef()` and prefer it over the stored ref. For discovered refs, stat the persisted fingerprint path before choosing `forceDiscovery`. Do not call global discovery merely because compact history text is unchanged.

- [x] **Step 4: Persist one atomic snapshot**

Call `AgentContextSnapshotStore.put()` with the resolved compact history/ref/fingerprint and current `agent.paneRevision`. Compare with the prior row before writing so unchanged status-event duplicates do not emit cache updates. Tests should assert that `updatedAt` is a `Date` and advances on overwrite, not compare a hard-coded wall clock.

- [x] **Step 5: Run the invalidation test to verify green**

Run: `pnpm test test/integration/agent-context-service.test.ts`

Expected: every matrix case passes and fake discovery call counts match the table.

- [x] **Step 6: Commit**

```bash
git add src/observability/agent-context-service.ts test/integration/agent-context-service.test.ts
git commit -m "feat(observability): reuse resolved agent history refs"
```

### Task 3: Assemble Cached Lists and Owner-Filtered Workspace Snapshots

**Objective:** Return current agent metadata plus persisted compact history without touching history readers and produce the exact owner-local context payload.

**Files:**
- Modify: `src/observability/agent-context-service.ts`
- Modify: `test/integration/agent-context-service.test.ts`

**Interfaces:**
- Consumes: persisted agent and context stores.
- Produces: `listAgents()` and `workspaceSnapshot()` for child 03.

- [x] **Step 1: Write failing cached-read tests**

Seed three agents in one workspace: owner Pi (`term_pi`), Claude (`term_claude`) with a snapshot, and another Pi (`term_other_pi`) with a snapshot. Assert:

```ts
expect(context.listAgents({ herdrSessionName: "default", workspaceId: "wB" })).toEqual([
  expect.objectContaining({ agent: "pi", terminalId: "term_pi" }),
  expect.objectContaining({
    agent: "claude",
    history: expect.objectContaining({ lastAssistantMessage: { text: "claude done" } }),
  }),
  expect.objectContaining({ agent: "pi", terminalId: "term_other_pi" }),
]);
```

The owner-filtered snapshot must:

```ts
expect(
  context.workspaceSnapshot({
    excludeTerminalId: "term_pi",
    herdrSessionName: "default",
    workspaceId: "wB",
  }),
).toMatchObject({
  agents: [
    { terminalId: "term_claude" },
    { terminalId: "term_other_pi" },
  ],
  herdrSessionName: "default",
  workspaceId: "wB",
});
```

Also prove:

1. `getAgentSnapshot(agent.id)` returns the persisted row without calling history.
2. An indexed agent with no context row remains in `listAgents()` with `emptyCompactHistory()` list fields.
3. A workspace with agents but no persisted snapshots returns `null` from `workspaceSnapshot()` so Pi follows cache-miss behavior.
4. A workspace containing only the receiving Pi returns `null` after self filtering.
5. A stopped Herdr session returns no list/snapshot rows.
6. A fake history service whose methods throw is never called by any cached-read method.
7. `updatedAt` is the maximum persisted snapshot update time among included agents.

- [x] **Step 2: Run the service test to verify red**

Run: `pnpm test test/integration/agent-context-service.test.ts`

Expected: list/snapshot methods or filtering assertions fail.

- [x] **Step 3: Implement store-only joins**

Read agents through `AgentStore.list(scope)`, fetch rows once via `listByAgentIds()`, map by `agentId`, and project `AgentListItem.history` using only:

```ts
{
  lastAssistantMessage: compact.lastAssistantMessage,
  lastUserMessage: compact.lastUserMessage,
  source: compact.source,
  updatedAt: compact.updatedAt,
}
```

For missing rows use `emptyCompactHistory()`. `workspaceSnapshot()` filters the receiving terminal before mapping and returns null when no included agent has a persisted snapshot. Sort order remains `AgentStore.list()` order.

- [x] **Step 4: Run context and store tests**

Run: `pnpm test test/integration/agent-context-service.test.ts test/integration/agent-context-snapshot-store.test.ts`

Expected: cached list/snapshot tests pass and no history method is invoked.

- [x] **Step 5: Commit**

```bash
git add src/observability/agent-context-service.ts test/integration/agent-context-service.test.ts
git commit -m "feat(observability): assemble cached workspace context"
```

### Task 4: Construct One Context Service in the Daemon

**Objective:** Share one daemon-owned cache service between index refresh and RPC/push consumers.

**Files:**
- Modify: `src/daemon/service.ts`
- Modify: `test/unit/daemon-service.test.ts` only if a constructor helper is extracted

**Interfaces:**
- Consumes: completed `AgentContextService`.
- Produces: one `context` instance for `AgentIndexService` and `ObservabilityRpcServer` wiring in child 03.

- [x] **Step 1: Add construction without changing consumers yet**

Create:

```ts
const agentContextSnapshots = new AgentContextSnapshotStore(sqlite);
const context = new AgentContextService({
  history,
  stores: { agentContextSnapshots, agents },
});
```

Pass `agentContextSnapshots` through any existing store aggregate that needs it. Do not create separate context-service instances for index and RPC because their in-flight/read behavior must share one persistence view.

- [x] **Step 2: Run typecheck and daemon service tests**

Run: `pnpm typecheck && pnpm test test/unit/daemon-service.test.ts`

Expected: daemon construction compiles and existing migration-path test passes.

- [x] **Step 3: Commit**

```bash
git add src/daemon/service.ts test/unit/daemon-service.test.ts
git commit -m "refactor(daemon): construct shared agent context service"
```

## Progress

- [x] Preferred-ref reads and one-shot rediscovery completed
- [x] Invalidation matrix and persisted context refresh completed
- [x] Cached list/workspace projection and daemon construction completed

## Next Steps

No implementation work remains.

## Completion Evidence

- Preferred-ref reads, one-shot fallback, authoritative path/ID reuse, invalidation, cached projections, and daemon context construction shipped in `8e6f228`.
- History/context focused tests and final typecheck passed.

## Validation

- `pnpm test test/unit/agent-history-service.test.ts test/unit/agent-history-readers.test.ts test/unit/agent-history-discovery.test.ts` — history behavior and explicit ref reads pass.
- `pnpm test test/integration/agent-context-service.test.ts test/integration/agent-context-snapshot-store.test.ts` — invalidation, persistence, list assembly, and self filtering pass.
- `pnpm typecheck` — daemon wiring uses one final service API.

## Risks, Tradeoffs, and Open Questions

- **Revision-before-flush race:** a status event can precede JSONL flush. Reusing the known ref may return the previous cache once; the next revision poll sees either a changed fingerprint or unchanged-source rediscovery and corrects it. Wake still retains its existing 500 ms settle policy.
- **Discovery cost on new sessions:** same-terminal new sessions intentionally pay one global discovery when pane revision changes but the old source does not.
- **OpenCode fingerprinting:** DB mtime can change because another session writes. The session id stays in `historyRef.value`, so a reread remains scoped even if the shared DB fingerprint changes.
- **Partial cache:** CLI list preserves indexed agent identity/status even before a history snapshot exists; Pi receives no normal context until at least one non-self snapshot exists.
- **No unresolved questions remain in this child.**
