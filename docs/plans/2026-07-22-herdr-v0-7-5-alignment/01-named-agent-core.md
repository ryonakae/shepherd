# Named Agent Core Implementation Plan

> **For implementers:** Execute this plan task-by-task. Complete each checkbox step, run the listed validation, and commit after each task.

**Status:** Planned

**Goal:** Persist Herdr v0.7.5 live agent names as mutable metadata, resolve named targets before kind fallbacks, and snapshot the observed name into Shepherd events without changing stable identity.

**Architecture:** `AgentStore` maps optional Herdr `AgentInfo.name` into a nullable `agents.name` column and the additive `AgentIndexRecord.name` field. Terminal-first row matching remains unchanged; name changes update the existing row and owner context but do not invalidate history. `AgentStore.resolveTarget()` evaluates exact identifier, live-name, and kind candidate groups in order. `AgentIndexService` includes name in context metadata and event payloads while excluding it from `sameIdentity()`.

**Tech Stack:** TypeScript, Drizzle SQLite, Node `DatabaseSync`, Vitest.

## Global Constraints

- Inherit every constraint from the parent plan.
- Add `name: string | null` to `AgentIndexRecord`; do not rename or repurpose `agent`.
- Map both snake-case/current Herdr data and compatibility fixtures: live name comes from `snapshot.name`; agent kind remains `snapshot.agent`.
- Add nullable SQL column `agents.name`. Do not add an index because target resolution already loads the selected running scope and evaluates candidates in memory.
- Do not use name to decide row continuity, Pi session-ref compatibility, history discovery, context snapshot ownership, or terminal self-exclusion.
- A name-only change must publish changed workspace context without forcing `AgentHistoryService.resolveCompactHistory()` when pane revision and identity are unchanged.
- Old events and old Herdr snapshots without name remain valid and map to null.
- Generate migration index `0004` with Drizzle. Keep its generated suffix and generated metadata; do not hand-edit migration snapshots.

## Current Context

- `src/db/schema.ts` defines four migrations through `0003` and has no `agents.name` column.
- `AgentStore.replaceForSession()` already matches a non-null terminal ID before pane fallback and updates stable rows in place.
- `AgentStore.resolveTarget()` currently combines pane ID, terminal ID, agent kind, and Shepherd ID into one candidate set.
- `AgentIndexService.sameIdentity()` controls history invalidation and must not include name.
- `AgentIndexService.sameContextMetadata()` controls owner context publication and must include name.
- `AgentIndexService.payload()` creates persisted status/outcome event payloads.
- Runtime output schemas are TypeScript contracts rather than TypeBox response schemas, so `src/observability/schemas.ts` needs no change.

## File Structure

- Modify: `src/observability/contracts.ts` — add nullable `AgentIndexRecord.name`.
- Modify: `src/db/schema.ts` — add nullable `agents.name`.
- Modify: `src/db/agents.ts` — map, persist, return, and resolve live names with explicit priority.
- Generate: `drizzle/0004_*.sql` and `drizzle/meta/0004_snapshot.json` — additive nullable column migration; Drizzle chooses the SQL filename suffix.
- Modify: `drizzle/meta/_journal.json` — generated migration journal entry.
- Modify: `test/integration/sqlite-migrations.test.ts` — assert nullable `agents.name`.
- Modify: `test/integration/agent-store-terminal-identity.test.ts` — persistence, rename continuity, target priority, fallback, and ambiguity.
- Modify: `test/unit/observability-contracts.test.ts` — compile-time contract fixture with name.
- Modify: `src/observability/agent-index-service.ts` — metadata comparison and event-time name snapshot.
- Modify: `test/integration/agent-index-service.test.ts` — rename metadata, no history refresh, and event payload.
- Modify: typed `AgentIndexRecord` fixtures found by `pnpm typecheck` — add `name: null` where a complete record is constructed.

## Interfaces

Extend the existing record without changing any current field:

```ts
export type AgentIndexRecord = {
  agent: string | null;
  agentSession: AgentSessionRef | null;
  agentStatus: AgentStatus;
  cwd: string | null;
  firstSeenAt: Date;
  focused: boolean;
  foregroundCwd: string | null;
  herdrSessionName: string;
  id: string;
  lastSeenAt: Date;
  name: string | null;
  paneId: string;
  paneRevision: number | null;
  tabId: string | null;
  terminalId: string | null;
  workspaceId: string;
};
```

The target resolver uses these ordered candidate groups:

```ts
const agents = this.list(scope);
const identifierMatches = agents.filter(
  (agent) => agent.paneId === target || agent.terminalId === target || agent.id === target,
);
const nameMatches = agents.filter((agent) => agent.name === target);
const kindMatches = agents.filter((agent) => agent.agent === target);
```

Return or reject using the first non-empty group. Never merge lower-priority candidates into a higher-priority match.

Status/outcome payloads use this additive shape:

```ts
{
  agent: agent.agent,
  from,
  herdrSessionName: agent.herdrSessionName,
  name: agent.name,
  paneId: agent.paneId,
  terminalId: agent.terminalId,
  to,
  workspaceId: agent.workspaceId,
}
```

## Tasks

### Task 1: Add the Live-Name Contract and Persistence

**Objective:** Round-trip an optional Herdr live name through the current agent row while preserving the row ID, session refs, and context snapshot across rename.

**Files:**
- Modify: `src/observability/contracts.ts`
- Modify: `src/db/schema.ts`
- Modify: `src/db/agents.ts`
- Modify: `test/unit/observability-contracts.test.ts`
- Modify: `test/integration/sqlite-migrations.test.ts`
- Modify: `test/integration/agent-store-terminal-identity.test.ts`
- Modify: `test/integration/agent-context-service.test.ts`
- Modify: `test/integration/orchestrator-pane-move.test.ts`
- Modify: `test/unit/herdr-session-watch-manager.test.ts`
- Generate: `drizzle/0004_*.sql`
- Generate: `drizzle/meta/0004_snapshot.json`
- Modify: `drizzle/meta/_journal.json`

**Interfaces:**
- Produces: `AgentIndexRecord.name: string | null` and persisted `agents.name`.
- Preserves: terminal-first matching, `agent` kind, reported/Pi session refs, pane revisions, and context snapshot cascade behavior.

- [ ] **Step 1: Write failing contract, migration, and store tests**

In `test/unit/observability-contracts.test.ts`, update the complete `AgentIndexRecord` fixture with:

```ts
name: "reviewer",
```

and assert that nullable compatibility remains representable with a second fixture or assignment using:

```ts
name: null,
```

In `test/integration/sqlite-migrations.test.ts`, add this assertion beside the existing `agents` column checks:

```ts
expect(agentColumns.find((column) => column.name === "name")).toMatchObject({
  dflt_value: null,
  notnull: 0,
});
```

Extend `replacePiAgent()` in `test/integration/agent-store-terminal-identity.test.ts` with `name?: string | null`, pass `name` into the raw Herdr fixture only when supplied, and add a test with these exact invariants:

```ts
const initial = replacePiAgent(agents, {
  agent: "codex",
  name: "reviewer",
  revision: 41,
});
if (!initial) throw new Error("Expected named agent");
agentContextSnapshots.put({
  agentId: initial.id,
  compactHistory: {
    historyRef: null,
    lastAssistantMessage: null,
    lastToolResult: null,
    lastUserMessage: null,
    messageCount: 0,
    source: null,
    updatedAt: null,
  },
  historyRef: null,
  paneRevision: 41,
  sourceFingerprint: null,
});

const renamed = replacePiAgent(agents, {
  agent: "codex",
  name: "implementer",
  revision: 41,
});
expect(renamed).toMatchObject({
  agent: "codex",
  id: initial.id,
  name: "implementer",
  terminalId: "term_1",
});
expect(agentContextSnapshots.get(initial.id)).toBeDefined();

const cleared = replacePiAgent(agents, {
  agent: "codex",
  name: null,
  revision: 41,
});
expect(cleared).toMatchObject({ id: initial.id, name: null });
```

Ensure the helper distinguishes omitted name from explicit null:

```ts
...(Object.hasOwn(input, "name") ? { name: input.name } : {}),
```

- [ ] **Step 2: Run focused tests to verify red**

Run:

```bash
pnpm test test/unit/observability-contracts.test.ts test/integration/sqlite-migrations.test.ts test/integration/agent-store-terminal-identity.test.ts
```

Expected: TypeScript reports missing `AgentIndexRecord.name`, the migration assertion cannot find `name`, and store results omit live names.

- [ ] **Step 3: Add the contract and Drizzle column**

Add the exact contract field:

```ts
name: string | null;
```

Add the nullable column inside `agents` in `src/db/schema.ts`:

```ts
name: text("name"),
```

Do not add a default, `notNull()`, or an index.

- [ ] **Step 4: Map the live name through AgentStore**

Add `name: string | null` to `AgentRow`.

In `replaceForSession()`, derive name independently from kind:

```ts
const agent = stringValue(snapshot.agent.agent);
const name = stringValue(snapshot.agent.name);
```

Insert `name` into the update/insert value list and SQL column lists. Keep `sessionHint` compatibility based only on `current?.agent === agent`.

In `mapAgent()`, return:

```ts
name: row.name,
```

Do not change row matching, `setSessionRefByTerminal()`, or snapshot deletion.

- [ ] **Step 5: Generate and inspect migration 0004**

Run:

```bash
pnpm db:generate
```

Expected: Drizzle creates exactly one SQL file with index `0004`, `drizzle/meta/0004_snapshot.json`, and one journal entry.

Inspect the generated SQL. It must add one nullable text column equivalent to:

```sql
ALTER TABLE `agents` ADD `name` text;
```

It must not recreate tables, drop data, modify migrations `0000` through `0003`, or add an index.

- [ ] **Step 6: Update every complete typed fixture**

Run:

```bash
pnpm typecheck
```

Expected before fixture updates: complete `AgentIndexRecord` literals report missing `name`.

Add `name: null` to complete records in the files reported by TypeScript, expected to include:

- `test/integration/agent-context-service.test.ts`
- `test/integration/orchestrator-pane-move.test.ts`
- `test/unit/herdr-session-watch-manager.test.ts`
- `test/unit/observability-contracts.test.ts`

Do not add name to raw Herdr fixtures unless a test exercises a named agent; omission must continue to map to null.

- [ ] **Step 7: Run focused tests and typecheck to verify green**

Run:

```bash
pnpm test test/unit/observability-contracts.test.ts test/integration/sqlite-migrations.test.ts test/integration/agent-store-terminal-identity.test.ts test/integration/agent-context-service.test.ts test/integration/orchestrator-pane-move.test.ts test/unit/herdr-session-watch-manager.test.ts
pnpm db:check
pnpm typecheck
```

Expected: contract, migration, stable-ID rename/clear, fixture compatibility, Drizzle, and typecheck pass.

- [ ] **Step 8: Commit**

Use the actual generated migration filename:

```bash
git add src/observability/contracts.ts src/db/schema.ts src/db/agents.ts test/unit/observability-contracts.test.ts test/integration/sqlite-migrations.test.ts test/integration/agent-store-terminal-identity.test.ts test/integration/agent-context-service.test.ts test/integration/orchestrator-pane-move.test.ts test/unit/herdr-session-watch-manager.test.ts drizzle/0004_*.sql drizzle/meta/0004_snapshot.json drizzle/meta/_journal.json
git commit -m "feat(observability): persist Herdr agent names"
```

### Task 2: Implement Priority-Aware Target Resolution

**Objective:** Resolve stable identifiers first, live names second, and runtime kind only as a compatibility fallback.

**Files:**
- Modify: `src/db/agents.ts`
- Modify: `test/integration/agent-store-terminal-identity.test.ts`
- Modify: `test/integration/observability-rpc.test.ts`

**Interfaces:**
- Consumes: `AgentIndexRecord.name` from Task 1.
- Produces: deterministic `AgentStore.resolveTarget(scope, target)` priority used by `agent.get` and `agent.read`.

- [ ] **Step 1: Write failing resolver tests**

Add a focused store test that seeds these agents in one workspace:

```ts
agents.replaceForSession({
  agents: [
    {
      agent: "codex",
      agent_status: "idle",
      name: "claude",
      pane_id: "wA:p1",
      terminal_id: "term_named",
      workspace_id: "wA",
    },
    {
      agent: "claude",
      agent_status: "idle",
      pane_id: "wA:p2",
      terminal_id: "term_kind_1",
      workspace_id: "wA",
    },
    {
      agent: "claude",
      agent_status: "idle",
      pane_id: "wA:p3",
      terminal_id: "term_kind_2",
      workspace_id: "wA",
    },
  ],
  herdrSessionName: "default",
});
```

Assert all priority rules:

```ts
expect(agents.resolveTarget({ workspaceId: "wA" }, "wA:p2").terminalId).toBe("term_kind_1");
expect(agents.resolveTarget({ workspaceId: "wA" }, "term_kind_2").paneId).toBe("wA:p3");
expect(agents.resolveTarget({ workspaceId: "wA" }, "claude")).toMatchObject({
  agent: "codex",
  name: "claude",
  terminalId: "term_named",
});
```

Then clear the explicit name through `replaceForSession()` while retaining the two Claude kinds and assert:

```ts
expect(() => agents.resolveTarget({ workspaceId: "wA" }, "claude")).toThrow(
  /agent target claude is ambiguous/,
);
```

Add a separate unique-kind fixture and assert kind fallback resolves it when no live name matches.

Assert ambiguity diagnostics contain both fields:

```ts
expect(() => agents.resolveTarget({ workspaceId: "wA" }, "claude")).toThrow(/name=unnamed agent=claude/);
```

In `test/integration/observability-rpc.test.ts`, seed `name: "reviewer"` on the existing Pi fixture and assert both RPC methods resolve it:

```ts
await expect(
  client.request("agent.get", { target: "reviewer", workspaceId: "wB" }),
).resolves.toMatchObject({ agent: { agent: "pi", name: "reviewer", paneId: "wB:p1" } });

await expect(
  client.request("agent.read", { limit: 10, target: "reviewer", workspaceId: "wB" }),
).resolves.toMatchObject({ agent: { name: "reviewer", messages: [] } });
```

- [ ] **Step 2: Run tests to verify red**

Run:

```bash
pnpm test test/integration/agent-store-terminal-identity.test.ts test/integration/observability-rpc.test.ts
```

Expected: the current merged candidate search reports `claude` as ambiguous instead of preferring the explicit name, and RPC lookup by `reviewer` fails.

- [ ] **Step 3: Implement ordered candidate groups**

Replace the current single `candidates` filter with:

```ts
resolveTarget(scope: AgentQueryScope, target: string): AgentIndexRecord {
  const agents = this.list(scope);
  const groups = [
    agents.filter(
      (agent) => agent.paneId === target || agent.terminalId === target || agent.id === target,
    ),
    agents.filter((agent) => agent.name === target),
    agents.filter((agent) => agent.agent === target),
  ];
  const candidates = groups.find((group) => group.length > 0) ?? [];
  if (candidates.length === 1) return candidates[0] as AgentIndexRecord;
  if (candidates.length === 0) throw new Error(`agent target not found: ${target}`);
  throw new Error(
    `agent target ${target} is ambiguous; candidates: ${candidates
      .map(
        (agent) =>
          `session=${agent.herdrSessionName} workspace=${agent.workspaceId} pane=${agent.paneId} terminal=${agent.terminalId ?? "unknown"} name=${agent.name ?? "unnamed"} agent=${agent.agent ?? "unknown"}`,
      )
      .join("; ")}`,
  );
}
```

Do not fall through to lower-priority groups after a non-empty group is found.

- [ ] **Step 4: Run tests to verify green**

Run:

```bash
pnpm test test/integration/agent-store-terminal-identity.test.ts test/integration/observability-rpc.test.ts
```

Expected: ID priority, live-name priority, unique-kind fallback, same-priority ambiguity, diagnostics, and RPC named lookup pass.

- [ ] **Step 5: Commit**

```bash
git add src/db/agents.ts test/integration/agent-store-terminal-identity.test.ts test/integration/observability-rpc.test.ts
git commit -m "feat(observability): prioritize named agent targets"
```

### Task 3: Publish Name Metadata and Event-Time Labels

**Objective:** Push renamed metadata to owner context without reparsing history and persist the observed live name on future status/outcome events.

**Files:**
- Modify: `src/observability/agent-index-service.ts`
- Modify: `test/integration/agent-index-service.test.ts`

**Interfaces:**
- Consumes: persisted `AgentIndexRecord.name` from Task 1.
- Produces: name-sensitive context metadata and additive event payload `name`.
- Preserves: `sameIdentity()` behavior and history refresh decisions.

- [ ] **Step 1: Write failing index/event tests**

Extend the `oneAgent()` or raw agent fixture helper in `test/integration/agent-index-service.test.ts` to accept a nullable live name independently of agent kind.

Add a test that performs two snapshots with the same terminal, kind, cwd, session ref, pane, status, and revision:

```ts
let current = oneAgent("working", 10, "codex", "reviewer");
const calls: string[] = [];
const index = new AgentIndexService({
  clientFactory: () => ({
    close() {},
    async sessionSnapshot() {
      return current;
    },
  }),
  history: history((agent) => calls.push(agent.agent ?? "unknown")),
  stores: harness,
});

await index.refreshHerdrSession(sessionInput());
calls.length = 0;
current = oneAgent("working", 10, "codex", "implementer");
const renamed = await index.refreshHerdrSession(sessionInput());

expect(calls).toEqual([]);
expect(renamed.contextChangedScopes).toEqual([
  { herdrSessionName: "default", workspaceId: "wJ" },
]);
expect(renamed.agents[0]).toMatchObject({
  agent: "codex",
  name: "implementer",
  terminalId: "term_claude",
});
```

After the renamed snapshot, send a done event and assert the stored outcome payload snapshots both values:

```ts
const status = await index.handleHerdrEvent({
  event: { agent_status: "done", pane_id: "wJ:p2", type: "pane.agent_status_changed" },
  ...sessionInput(),
});
expect(status.events).toContainEqual(
  expect.objectContaining({
    payload: expect.objectContaining({
      agent: "codex",
      name: "implementer",
      to: "done",
    }),
    type: "agent.done",
  }),
);
```

Also assert an unnamed snapshot creates payload `name: null`; do not omit the key on new events.

- [ ] **Step 2: Run the focused test to verify red**

Run:

```bash
pnpm test test/integration/agent-index-service.test.ts
```

Expected: indexed agents omit `name`, name-only refresh does not publish the expected scope, and event payloads omit `name`.

- [ ] **Step 3: Update metadata and event payload rules**

Keep `sameIdentity()` unchanged. Add name only to `sameContextMetadata()`:

```ts
function sameContextMetadata(left: AgentIndexRecord, right: AgentIndexRecord): boolean {
  return (
    sameIdentity(left, right) &&
    left.name === right.name &&
    left.agentStatus === right.agentStatus &&
    left.paneId === right.paneId &&
    left.tabId === right.tabId &&
    left.workspaceId === right.workspaceId
  );
}
```

Add this property to `payload()`:

```ts
name: agent.name,
```

Do not add name to `sameIdentity()`, `idempotencyKey()`, history lookup input, or terminal session keys.

- [ ] **Step 4: Run the index test and typecheck to verify green**

Run:

```bash
pnpm test test/integration/agent-index-service.test.ts
pnpm typecheck
```

Expected: name-only changes publish context without a history call, events snapshot name, unnamed compatibility passes, and the repository still typechecks.

- [ ] **Step 5: Commit**

```bash
git add src/observability/agent-index-service.ts test/integration/agent-index-service.test.ts
git commit -m "feat(observability): publish named agent metadata"
```

## Validation

- `pnpm test test/unit/observability-contracts.test.ts test/integration/sqlite-migrations.test.ts test/integration/agent-store-terminal-identity.test.ts test/integration/agent-index-service.test.ts test/integration/agent-context-service.test.ts test/integration/observability-rpc.test.ts test/integration/orchestrator-pane-move.test.ts test/unit/herdr-session-watch-manager.test.ts` — all core name, identity, target, event, and compatibility cases pass.
- `pnpm db:check` — schema and migration metadata agree.
- `pnpm typecheck` — every complete `AgentIndexRecord` supplies nullable name.
- `git diff --check` — no whitespace errors.

## Risks, Tradeoffs, and Open Questions

- `name` is nullable for Herdr 0.7.0-0.7.4 and manually launched unnamed agents.
- Target kind remains a compatibility fallback. An explicit live name always wins, even when multiple agents share that kind.
- Name-only changes update the persisted agent row's `lastSeenAt`; they do not alter event idempotency or create a standalone rename event.
- Event payload is intentionally unversioned and additive. Existing readers already treat it as unknown data and must tolerate missing `name` on historical records.
- No open questions remain.
