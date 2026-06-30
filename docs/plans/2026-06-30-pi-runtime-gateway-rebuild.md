# Pi Runtime Gateway Rebuild Implementation Plan

> **For implementers:** Execute this plan task-by-task. Complete each checkbox step, run the listed validation, and commit after each task.

**Goal:** Rebuild Shepherd around `Pi = structured coordinator runtime`, `Herdr = execution surface`, and `Shepherd Gateway = session / delivery / queue`, removing the legacy provider runner path and resetting the DB baseline.

**Architecture:** Pi owns the model/provider/session conversation and acts as the coordinator runtime. Herdr owns terminal execution surfaces: workspaces, tabs, panes, agents, logs, tests, and shells. Shepherd Gateway owns platform sessions, delivery, Pi turn queueing, logical tool policy/idempotency, Herdr bindings, worker-agent bindings, and audit/recovery events.

**Tech Stack:** TypeScript ESM with NodeNext, TypeBox/Ajv runtime schemas, SQLite through `node:sqlite` and Drizzle, JSON Lines RPC over Unix sockets, Herdr socket API, Slack Web API delivery/streaming, Vitest, Biome, pnpm 11.

## Status

Done.

## Progress

- Done — Implementation completed across Tasks 1–11. DB schema/migrations now use a fresh Pi-turn baseline, legacy provider runtime is removed, Gateway RPCs use `pi.*`, final assistant delivery uses `assistant.message`, Pi extension mirroring uses the new runtime protocol, logical tools are renamed and worker bindings are persisted, Herdr progress uses `events.subscribe`, docs describe the Pi/Herdr/Gateway split, and final validation passed.

## Next steps

No implementation steps remain for this plan. Future changes should use a new active plan.

## Global Constraints

- This repository is still in development. Do not preserve compatibility with existing Shepherd DB files, existing Drizzle migration history, old queued/running Gateway runs, old `gateway.run.*` events, old `gateway.message` naming, old `gateway.stream_*`/`gateway.complete_run` RPCs, or old provider config.
- Reset `$SHEPHERD_HOME` during manual testing if an old DB blocks validation.
- Replace `drizzle/0000` through `drizzle/0004` with a new `0000` baseline generated from the new `src/db/schema.ts`.
- Pi session files are the canonical agent conversation history. Shepherd DB stores platform/orchestration/audit/recovery facts and must not reconstruct normal Pi LLM context from event history during normal operation.
- Keep `session_summaries` table/store, but remove automatic provider-backed summary updates. Do not inject Shepherd summaries into normal Pi turns.
- Remove Shepherd-owned LLM/provider runtime: delete provider runner, provider factories/adapters, provider override handling, and provider config schema. Pi owns provider auth and model selection.
- Use `pi_turns` instead of `gateway_runs`. Queueing, owner claiming, terminal state, and recovery are Pi turn state.
- Use `assistant.message` for final assistant text. `pi.turn.*` events are lifecycle events and must not carry the final assistant text.
- Do not persist token deltas. `pi.stream_delta` is transient delivery state keyed by `piTurnId`; only final `assistant.message` is persisted.
- Persist `pi.tool.started`, `pi.tool.completed`, and `pi.tool.failed` as compact timeline events. Keep detailed logical tool input/result/status in `logical_tool_calls`.
- Scope logical tool idempotency to `(pi_turn_id, idempotency_key)`, not the entire session.
- State-changing Herdr operations for Shepherd-managed work must go through Shepherd logical tools. Normal read-only inspection should use `shepherd_herdr_read`; raw Herdr read is an escape hatch for insufficient Shepherd tools or explicit user requests.
- Gateway does not intercept raw Herdr socket/CLI mutations outside the Shepherd tool surface. Enforcement boundary is the Pi tool surface plus hidden prompt guidance.
- Headless Pi starts with the user's normal Pi configuration. It is not forced into a Shepherd-only profile; Pi may complete light tasks without Herdr.
- Use this prompt tone in `shepherd-pi` hidden context: `Choose the execution surface that fits the work. Use Pi directly for quick reasoning, small edits, and short checks. Use Shepherd/Herdr when a visible terminal surface, parallel worker agents, long-running commands, resumable execution, or inspection by the user or another Pi owner would help.`
- Attached Pi conversation mirroring follows the archived bidirectional sync decision: Pi-originated user messages are stored, published, and delivered to Slack bindings without queueing another Pi turn; Slack-originated messages do not echo back as user messages.
- Slack `platforms.slack.streaming.tool_progress` remains exactly `"off" | "compact" | "verbose"`; default is `off`. Compact/verbose progress is transient and sanitized.
- Do not persist or send raw Pi tool args, raw tool results, stdout/stderr dumps, full file contents, provider request/response payloads, or hidden thinking.
- Herdr progress is internal event data. Rebuild it on `events.subscribe`, not `events.wait`. Do not normal-fanout `herdr.progress` to Slack.
- All public docs/code comments in this private repo may be English unless surrounding content is Japanese. Chat progress remains Japanese.
- After implementation changes, run `pnpm check`. Run `pnpm build` because this rebuild changes import/export surfaces and CLI package output.

## Current Context

- The previous active plan `docs/plans/2026-06-29-pi-bidirectional-sync-runtime-events.md` is archived as historical context. It decided Pi bidirectional mirroring and runtime events, but it used older names: `gatewayRunId`, `gateway_runs`, and `gateway.message`.
- `src/gateway/server.ts` currently supports both legacy provider runner wake paths and Pi owner/heartbeat/claim paths.
- `src/gateway/runtime.ts` creates a legacy `GatewayRunner` when provider config exists; otherwise it creates external run queue + logical tools for Pi.
- `src/gateway/runner.ts`, `src/gateway/provider-factory.ts`, `src/gateway/ai-sdk-provider.ts`, and `src/gateway/codex-provider.ts` are legacy provider-runner code paths to remove.
- `src/config/schema.ts` still accepts `providers`, `gateway.default_provider`, `gateway.model`, and `gateway.provider_overrides`.
- `src/db/schema.ts` currently contains `gateway_runs`, `logical_tool_calls` with `(session_id, idempotency_key)` uniqueness, `herdr_bindings` for workspace binding only, and `session_summaries`.
- `src/gateway/turn-queue.ts` currently defines `GatewayRunStore` over `gateway_runs` and imports provider-runner types.
- `src/gateway/external-run-queue.ts` currently queues `gateway.run.queued`, claims `gateway.run.started`, and completes with `gateway.message` + `gateway.run.completed`.
- `packages/shepherd-pi/src/index.ts` currently calls legacy RPCs such as `gateway.stream_delta`, `gateway.stream_finish`, and `gateway.complete_run`.
- `src/herdr/progress-subscriptions.ts` currently loops on `source.waitForEvent()`, which uses Herdr `events.wait`. Herdr 0.7.0 returned `not_implemented` for `events.wait`; use `events.subscribe`.
- `src/herdr/orchestrator.ts` currently records workspace bindings in `herdr_bindings` and returns agent pane results from `startAgent`, but it does not persist worker-agent bindings.
- `packages/shepherd-pi/src/index.ts` registers Gateway tools as visible Pi tools with `shepherd_${tool.name}` names.
- Existing validation command is `pnpm check`; DB migrations are generated with `pnpm db:generate`; build validation is `pnpm build`.

## File Structure

- Create: `src/db/pi-turns.ts` — `PiTurnStore` for queued/running/completed/failed/recovery-required turn state.
- Create: `src/db/worker-agent-bindings.ts` — store for Shepherd worker-agent bindings and best-effort status/health cache.
- Create: `src/gateway/pi-runtime-events.ts` — Pi runtime payload types, parsers, sanitizer, idempotency helpers, and terminal conflict helpers.
- Create: `src/platforms/slack/tool-progress.ts` — transient Slack compact/verbose Pi tool progress rendering.
- Create: `test/unit/pi-runtime-events.test.ts` — payload helper tests.
- Modify: `test/integration/delivery-fanout.test.ts` — fanout allowlist and Pi mirror delivery tests.
- Modify: `src/db/schema.ts` — new baseline schema with `pi_turns`, updated `logical_tool_calls`, worker-agent bindings, and no `gateway_runs`.
- Modify: `drizzle/` — delete old migration files and generate a new baseline.
- Modify: `src/config/schema.ts` — remove provider config and provider override schema.
- Modify: `src/config/runtime.ts` — keep runtime path resolution compatible with the smaller config type.
- Modify: `src/gateway/runtime.ts` — remove provider runner construction and return Pi runtime queue/tools/progress manager only.
- Modify: `src/gateway/service.ts` — wire `PiTurnStore`, `PiTurnQueue`, headless Pi supervisor, runtime delivery, logical tools, Herdr progress subscription, and no provider overrides.
- Modify: `src/gateway/server.ts` — replace legacy run/stream completion RPCs with `pi.*` RPCs backed by `pi_turns` and `assistant.message`.
- Create: `src/gateway/pi-turn-queue.ts` — queueing, claim, start, terminal, and recovery event orchestration for `pi_turns`.
- Delete: `src/gateway/external-run-queue.ts` — superseded by `src/gateway/pi-turn-queue.ts`.
- Delete: `src/gateway/turn-queue.ts` — provider-era queue/store code is superseded by `src/db/pi-turns.ts` and `src/gateway/pi-turn-queue.ts`.
- Modify: `src/gateway/tools.ts` — add `piTurnId` to logical tool context, store tool calls by `(pi_turn_id, idempotency_key)`, and emit `pi.tool.*` timeline events.
- Modify: `src/gateway/builtin-tools.ts` — rename tools, add worker-agent tools, and make `ensure_worker_agent` persist/reuse worker bindings.
- Modify: `src/herdr/orchestrator.ts` — use worker binding store for ensure semantics and update status/health best-effort.
- Modify: `src/herdr/socket-client.ts` — add `subscribeEvents()` or an equivalent async event stream over Herdr `events.subscribe`.
- Modify: `src/herdr/progress-subscriptions.ts` — rebuild subscription loop around `events.subscribe` and update worker binding status from Herdr events.
- Modify: `src/delivery/fanout.ts` — deliver `assistant.message`, `user.message`, and approval events only; do not normal-fanout `pi.turn.*`, `pi.tool.*`, `worker_agent.*`, or `herdr.progress`.
- Modify: `src/platforms/runtime.ts` — expose `runtimeDelivery` keyed by `piTurnId` and Slack transient tool progress.
- Modify: `src/platforms/slack/delivery.ts` — render `assistant.message`, generic stream keys, and Pi user-message delivery prefixes.
- Modify: `src/gateway/context.ts` — keep only audit/recovery/admin formatting; do not inject summaries into normal Pi turns.
- Modify: `packages/shepherd-pi/src/index.ts` — new `pi.*` RPC flow, current `piTurnId` hidden context, revised Shepherd boundary prompt, tool lifecycle mirroring, and no legacy RPC calls.
- Modify: `packages/shepherd-pi/skills/shepherd/SKILL.md` — optional documentation updated to the new boundary wording; hidden context remains the authoritative always-on guidance.
- Modify: `README.md` — remove provider config instructions, document DB reset during development, and describe Pi/Herdr/Gateway split at a high level.
- Test: `test/unit/config-schema.test.ts`, `test/unit/config-loader.test.ts` — provider config removal.
- Test: `test/integration/gateway-runtime.test.ts` — Pi runtime creation without provider runner.
- Test: `test/integration/gateway-rpc.test.ts` — `pi.*` RPCs, owner priority, terminal conflicts, and no legacy RPCs.
- Test: `test/integration/builtin-tools.test.ts` — renamed tool surface and worker binding behavior.
- Test: `test/integration/herdr-progress.test.ts` — `events.subscribe` progress manager behavior.
- Test: `test/unit/shepherd-pi-extension.test.ts` — hidden context text, tool registration names, and `/shepherd` command compatibility.
- Delete: `src/gateway/runner.ts`, `src/gateway/provider-factory.ts`, `src/gateway/provider-overrides.ts`, `src/gateway/ai-sdk-provider.ts`, `src/gateway/codex-provider.ts`, and provider-runner-only tests.
- Delete: `src/gateway/summary.ts` automatic updater; keep `src/db/session-summary.ts`.

## Core Interfaces

### DB Tables

Use these exact table names in the new baseline:

```text
working_contexts
sessions
actors
events
session_bindings
pi_turns
logical_tool_calls
delivery_receipts
herdr_bindings
worker_agent_bindings
session_summaries
```

`pi_turns` columns:

```text
id text primary key
session_id text not null references sessions(id) on delete cascade
triggering_event_id integer references events(id) on delete set null
owner_id text
owner_kind text check in ('headless_pi','tui_pi')
pi_session_id text
pi_session_file text
status text not null check in ('queued','running','completed','failed','recovery_required')
source text check in ('extension','interactive','rpc')
input_event_ids_json text
recovery_json text
started_at integer timestamp_ms
completed_at integer timestamp_ms
created_at integer timestamp_ms not null
updated_at integer timestamp_ms not null
```

`logical_tool_calls` changes:

```text
pi_turn_id text not null references pi_turns(id) on delete cascade
session_id text not null references sessions(id) on delete cascade
unique(pi_turn_id, idempotency_key)
```

`worker_agent_bindings` columns:

```text
id text primary key
session_id text not null references sessions(id) on delete cascade
herdr_session_name text not null
workspace_id text not null
agent_name text not null
agent_profile text not null
role text not null check in ('implementation','review','research','test','general')
description text
last_task text
pane_id text not null
tab_id text
agent_status text not null check in ('idle','working','blocked','done','unknown')
binding_health text not null check in ('starting','present','missing','error')
metadata_json text
created_at integer timestamp_ms not null
updated_at integer timestamp_ms not null
last_seen_at integer timestamp_ms
unique(session_id, workspace_id, agent_name)
```

`herdr_bindings` remains the workspace binding table, with `metadata_json.tabs` holding the standard tab role map.

### Event Names

Persist these event names:

```text
user.message
assistant.message
pi.turn.queued
pi.turn.started
pi.turn.completed
pi.turn.failed
pi.turn.recovery_required
pi.turn.terminal_conflict
pi.tool.started
pi.tool.completed
pi.tool.failed
worker_agent.bound
worker_agent.status_changed
herdr.progress
approval.requested
approval.responded
summary.updated
recovery.note
session.renamed
```

Do not persist `pi.stream.delta` token events.

### Persistent Event Payload Notes

`pi.turn.recovery_required` payload:

```ts
type PiTurnRecoveryRequiredPayload = {
  message: string;
  ownerId: string;
  previousStatus: "running";
  recoveredAt: string;
  piTurnId: string;
};
```

`worker_agent.status_changed` payload:

```ts
type WorkerAgentStatusChangedPayload = {
  agentName: string;
  agentStatus?: "idle" | "working" | "blocked" | "done" | "unknown";
  bindingHealth?: "starting" | "present" | "missing" | "error";
  herdrSessionName: string;
  lastSeenAt: string;
  paneId?: string;
  sessionId: string;
  workspaceId: string;
};
```

Emit `worker_agent.status_changed` only when the cached worker binding state changes. Do not emit it for every raw Herdr event if the derived state is identical.

### Pi RPC Methods

Expose these RPC methods from `ShepherdGatewayServer`:

```text
pi.handshake
pi.attach
pi.heartbeat
pi.ensure_session
pi.claim_next_turn
pi.start_turn
pi.mirror_user_message
pi.stream_delta
pi.stream_finish
pi.stream_segment_break
pi.record_tool_progress
pi.complete_turn
pi.fail_turn
```

Remove these legacy RPC methods:

```text
gateway.claim_next_run
gateway.start_run
gateway.stream_delta
gateway.stream_finish
gateway.stream_segment_break
gateway.stream_tool_progress
gateway.complete_run
gateway.fail_run
```

### Tool Names

Pi-visible names are `shepherd_${internalName}`. Use these internal names:

High-level tools:

```text
session_read
workspace_discovery
resolve_working_context
ensure_workspace
attach_workspace
ensure_worker_agent
list_worker_agents
get_worker_agent
```

Low-level Herdr tools:

```text
herdr_read
herdr_open_pane
herdr_run_pane_command
herdr_read_pane
herdr_send_pane_text
herdr_send_agent_message
herdr_read_agent
herdr_wait_for_agent
herdr_wait_for_event
```

Remove aliases and old names:

```text
ensure_herdr_workspace
attach_herdr_workspace
herdr_start_agent
open_pane
run_pane_command
read_pane
send_pane_text
wait_for_agent
wait_for_herdr_event
start_agent
send_agent_message
read_agent_output
ensure_agent_pane
```

### Hidden Shepherd Context

`packages/shepherd-pi` should inject only identity and rules:

```text
[SHEPHERD ATTACHED CONTEXT]
Shepherd session id: <sessionId>
Current Pi turn id: <piTurnId if any>
Pi owner kind: <headless_pi|tui_pi>

Shepherd is the session, delivery, queue, and Herdr orchestration gateway. Pi owns the model conversation and coordination. Herdr owns terminal execution surfaces.

Choose the execution surface that fits the work. Use Pi directly for quick reasoning, small edits, and short checks. Use Shepherd/Herdr when a visible terminal surface, parallel worker agents, long-running commands, resumable execution, or inspection by the user or another Pi owner would help.

Use Shepherd logical tools for Shepherd session inspection and Shepherd-managed Herdr orchestration. Use shepherd_herdr_read for normal read-only Herdr inspection. Do not mutate Herdr state through raw Herdr commands for Shepherd-managed work. Treat Shepherd session ids, Pi turn ids, socket paths, and owner ids as internal unless the user asks.
```

Do not include worker binding lists, Herdr workspace state, recent events, or session summaries in hidden context.

## Tasks

### Task 1: Reset DB Schema and Migration Baseline

**Objective:** Replace the old Gateway-run/provider-era schema with a clean Pi-turn baseline.

**Files:**
- Modify: `src/db/schema.ts`
- Create/Modify: `src/db/pi-turns.ts`
- Create: `src/db/worker-agent-bindings.ts`
- Delete: `src/gateway/turn-queue.ts`
- Modify: `drizzle/`
- Test: `test/integration/pi-turn-store.test.ts`
- Test: `test/integration/worker-agent-bindings.test.ts`
- Test: update existing DB-dependent tests that still reference `gateway_runs`

**Interfaces:**
- Produces `PiTurnStore`, `WorkerAgentBindingStore`, and a new `drizzle/0000_*.sql` baseline.
- Consumes no previous task output.

- [x] **Step 1: Write failing Pi turn store tests**

Create `test/integration/pi-turn-store.test.ts` with these cases:

1. `createQueuedTurn({ sessionId, triggeringEventId })` returns a `queued` record and appends no event by itself.
2. `claimNextQueuedTurn(sessionId)` returns the oldest queued turn only when no turn for that session is `running`.
3. `markRunning(id, owner)` sets `status = 'running'`, `ownerId`, `ownerKind`, `piSessionId`, `piSessionFile`, `source`, `inputEventIds`, and `startedAt`.
4. `createRunningTurn()` inserts a direct Pi turn that did not come from the queue, sets `status = 'running'`, owner/Pi metadata, `source`, `inputEventIds`, and `startedAt`.
5. `markCompletedIfRunning(id)` changes `queued` or `running` to `completed`, sets `completedAt`, and returns `{ changed: true }`.
6. `markFailedIfRunning(id, error)` changes `queued` or `running` to `failed`, stores `recovery.message`, and returns `{ changed: true }`.
7. Calling a terminal transition on an already terminal turn returns `{ changed: false }` and does not overwrite `status` or `completedAt`.
8. `markRecoveryRequiredForRunning(sessionId, ownerId, message)` only affects the current running turn for that owner/session.

- [x] **Step 2: Write failing worker binding store tests**

Create `test/integration/worker-agent-bindings.test.ts` with these cases:

1. `upsertBinding()` inserts a worker with `agentStatus: 'unknown'`, `bindingHealth: 'starting'` or supplied values, and role `implementation | review | research | test | general`.
2. Re-upserting the same `(sessionId, workspaceId, agentName)` updates `paneId`, `tabId`, `description`, `lastTask`, `agentStatus`, `bindingHealth`, `updatedAt`, and `lastSeenAt` without creating a duplicate.
3. `listForSession(sessionId)` orders by `updatedAt desc`.
4. `getByAgentName({ sessionId, workspaceId, agentName })` throws `Worker agent binding not found` when absent.
5. Invalid role/status/health is rejected by TypeScript callers or by explicit runtime validation in the store.

- [x] **Step 3: Run tests to verify failure**

Run:

```bash
pnpm test test/integration/pi-turn-store.test.ts test/integration/worker-agent-bindings.test.ts
```

Expected: tests fail because stores and schema do not exist.

- [x] **Step 4: Rewrite `src/db/schema.ts`**

Implement the table list from **Core Interfaces / DB Tables**. Remove `gatewayRuns`. Keep `sessionSummaries` unchanged except for imports/order.

Define Drizzle exports with names:

```ts
export const piTurns = sqliteTable("pi_turns", { ... });
export const workerAgentBindings = sqliteTable("worker_agent_bindings", { ... });
```

For `logicalToolCalls`, replace the old unique index:

```ts
uniqueIndex("logical_tool_calls_pi_turn_idempotency_idx").on(table.piTurnId, table.idempotencyKey)
```

Do not keep `events_session_idempotency_key_idx` if it allows duplicate `NULL` values differently; keep current behavior if tests depend on it.

- [x] **Step 5: Implement `PiTurnStore`**

Create `src/db/pi-turns.ts` exporting:

```ts
export type PiTurnStatus = "completed" | "failed" | "queued" | "recovery_required" | "running";
export type PiOwnerKind = "headless_pi" | "tui_pi";
export type PiTurnSource = "extension" | "interactive" | "rpc";

export type PiTurnRecord = {
  completedAt: Date | null;
  createdAt: Date;
  id: string;
  inputEventIds: number[];
  ownerId: string | null;
  ownerKind: PiOwnerKind | null;
  piSessionFile: string | null;
  piSessionId: string | null;
  recovery: unknown;
  sessionId: string;
  source: PiTurnSource | null;
  startedAt: Date | null;
  status: PiTurnStatus;
  triggeringEventId: number | null;
  updatedAt: Date;
};
```

Implement methods:

```ts
createQueuedTurn(input: { id?: string; sessionId: string; triggeringEventId?: number }): PiTurnRecord;
createRunningTurn(input: { id: string; inputEventIds: number[]; ownerId: string; ownerKind: PiOwnerKind; piSessionFile: string; piSessionId: string; sessionId: string; source: PiTurnSource; triggeringEventId?: number }): PiTurnRecord;
claimNextQueuedTurn(sessionId: string): PiTurnRecord | undefined;
markRunning(input: { id: string; ownerId: string; ownerKind: PiOwnerKind; piSessionFile: string; piSessionId: string; source: PiTurnSource; inputEventIds: number[] }): PiTurnRecord;
markCompletedIfRunning(id: string): { changed: boolean; turn: PiTurnRecord };
markFailedIfRunning(id: string, error: unknown): { changed: boolean; turn: PiTurnRecord };
markRecoveryRequiredForRunning(input: { message: string; ownerId: string; sessionId: string }): PiTurnRecord | undefined;
getTurn(id: string): PiTurnRecord;
findRunningTurn(sessionId: string): PiTurnRecord | undefined;
listTurns(sessionId: string): PiTurnRecord[];
listRecoverableTurns(): PiTurnRecord[];
```

Use `status in ('queued','running')` in terminal transition `where` clauses so terminal state is first-terminal-wins.

- [x] **Step 6: Implement `WorkerAgentBindingStore`**

Create `src/db/worker-agent-bindings.ts` exporting:

```ts
export type WorkerAgentRole = "general" | "implementation" | "research" | "review" | "test";
export type WorkerAgentStatus = "blocked" | "done" | "idle" | "unknown" | "working";
export type WorkerBindingHealth = "error" | "missing" | "present" | "starting";
```

Add `WorkerAgentBindingRecord` with the DB columns from Core Interfaces.

Implement methods:

```ts
upsertBinding(input: UpsertWorkerAgentBindingInput): WorkerAgentBindingRecord;
getById(id: string): WorkerAgentBindingRecord;
getByAgentName(input: { agentName: string; sessionId: string; workspaceId: string }): WorkerAgentBindingRecord;
listForSession(sessionId: string): WorkerAgentBindingRecord[];
updateObservedState(input: { agentName: string; sessionId: string; workspaceId: string; agentStatus?: WorkerAgentStatus; bindingHealth?: WorkerBindingHealth; metadata?: unknown }): WorkerAgentBindingRecord;
```

Validate enum inputs before SQL and throw messages like `Invalid worker agent role: <value>`.

- [x] **Step 7: Reset migration files**

Delete old files under `drizzle/` and generate a new baseline:

```bash
rm -f drizzle/*.sql drizzle/meta/*.json
pnpm db:generate
```

Expected: one new SQL file under `drizzle/` and new Drizzle meta snapshots.

Because compatibility is not required, do not write data migration SQL.

- [x] **Step 8: Run store tests**

Run:

```bash
pnpm test test/integration/pi-turn-store.test.ts test/integration/worker-agent-bindings.test.ts
```

Expected: all tests pass.

- [x] **Step 9: Commit**

```bash
git add src/db/schema.ts src/db/pi-turns.ts src/db/worker-agent-bindings.ts drizzle test/integration/pi-turn-store.test.ts test/integration/worker-agent-bindings.test.ts
git commit -m "db: reset schema around pi turns"
```

### Task 2: Remove Legacy Provider Runtime and Config Surface

**Objective:** Delete Shepherd-owned provider/model execution and leave Pi as the only runtime owner.

**Files:**
- Modify: `src/config/schema.ts`
- Modify: `src/config/runtime.ts`
- Modify: `src/gateway/runtime.ts`
- Modify: `src/gateway/service.ts`
- Delete: `src/gateway/runner.ts`
- Delete: `src/gateway/provider-factory.ts`
- Delete: `src/gateway/provider-overrides.ts`
- Delete: `src/gateway/ai-sdk-provider.ts`
- Delete: `src/gateway/codex-provider.ts`
- Delete: `src/gateway/summary.ts`
- Test: `test/unit/config-schema.test.ts`
- Test: `test/unit/config-loader.test.ts`
- Test: `test/integration/gateway-runtime.test.ts`
- Delete/update provider-runner tests.

**Interfaces:**
- Consumes Task 1 `PiTurnStore`.
- Produces provider-free config and runtime wiring.

- [x] **Step 1: Write failing config tests**

Update `test/unit/config-schema.test.ts` and `test/unit/config-loader.test.ts`:

1. Minimal valid config includes `agents`, `default_agent`, `gateway.pi`, optional `context`, optional `platforms`, and optional `runtime`.
2. Config with top-level `providers` fails validation with `additionalProperties`.
3. Config with `gateway.default_provider`, `gateway.model`, or `gateway.provider_overrides` fails validation with `additionalProperties`.
4. `gateway.pi.idle_timeout_ms` and `gateway.pi.readiness_timeout_ms` remain valid positive integers.

- [x] **Step 2: Write failing runtime tests**

Update `test/integration/gateway-runtime.test.ts`:

1. `createGatewayRuntime()` returns exactly `{ close, herdrProgress, tools, turns }` when config is valid.
2. No test imports `GatewayRunner` or provider factory types.
3. Runtime uses configured `agents` for `ensure_worker_agent` and no provider/model fields.

- [x] **Step 3: Run tests to verify failure**

Run:

```bash
pnpm test test/unit/config-schema.test.ts test/unit/config-loader.test.ts test/integration/gateway-runtime.test.ts
```

Expected: failures because provider config is still accepted and runtime still imports provider runner code.

- [x] **Step 4: Shrink config schema**

In `src/config/schema.ts`:

- Delete `codexProviderSchema`, `apiKeyProviderSchema`, `gatewayProviderSchema`, and `providerOverrideSchema`.
- Delete `providers` top-level field.
- Delete `gateway.default_provider`, `gateway.model`, and `gateway.provider_overrides`.
- Delete `invalidProviderOverridePaths()` and provider validation branches.
- Keep `agents`, `default_agent`, `gateway.pi`, `platforms`, `context`, and `runtime`.

- [x] **Step 5: Rewrite runtime wiring**

In `src/gateway/runtime.ts`:

- Remove provider router/runner/summary imports.
- Create `EventStore`, `PiTurnStore`, `LogicalToolRunner`, `HerdrOrchestrator`, and `HerdrProgressSubscriptionManager` only.
- Return a shape like:

```ts
export type GatewayRuntime = {
  close(): Promise<void>;
  herdrProgress: HerdrProgressSubscriptionManager;
  tools: LogicalToolRunner;
  turns: PiTurnQueue;
};
```

Do not include a `runner` field.

In `src/gateway/service.ts`:

- Always use Pi turn queue when `config` exists.
- Keep `HeadlessPiSupervisor` creation with `config.gateway.pi?.idle_timeout_ms ?? 600_000`.
- Remove `providerOverrides` option passed to `ShepherdGatewayServer`.
- Remove `summaries` from the normal wake path and from `ShepherdGatewayServer` constructor options. Keep `SessionSummaryStore` as a standalone DB store with its existing integration test, but do not instantiate it in `runGatewayService()`.

- [x] **Step 6: Delete legacy provider files and tests**

Delete source files:

```text
src/gateway/runner.ts
src/gateway/provider-factory.ts
src/gateway/provider-overrides.ts
src/gateway/ai-sdk-provider.ts
src/gateway/codex-provider.ts
src/gateway/summary.ts
```

Delete tests that only validate deleted code:

```text
test/integration/gateway-runner.test.ts
test/integration/ai-sdk-provider.test.ts
test/integration/gateway-summary.test.ts
test/unit/gateway-provider-factory.test.ts
test/unit/gateway-provider-overrides.test.ts
test/unit/codex-provider.test.ts
```

Do not keep empty re-export files.

- [x] **Step 7: Remove provider dependencies**

Update `package.json` dependencies by removing these provider-runner-only packages after deleting the imports listed in Step 6:

```text
@ai-sdk/anthropic
@ai-sdk/openai
@openrouter/ai-sdk-provider
ai
ai-sdk-provider-codex-cli
```

Run:

```bash
rg -n "@ai-sdk|openrouter|ai-sdk-provider-codex-cli|from \"ai\"|GatewayRunner|GatewayProvider|provider_overrides|default_provider|providers:" src test package.json README.md
```

Expected after cleanup: no active source/test references except README examples that are being updated in Task 11. If `ai` is still used by Pi/package tooling, do not remove it; otherwise remove it.

- [x] **Step 8: Run focused tests**

Run:

```bash
pnpm test test/unit/config-schema.test.ts test/unit/config-loader.test.ts test/integration/gateway-runtime.test.ts
```

Expected: tests pass.

- [x] **Step 9: Commit**

```bash
git add package.json pnpm-lock.yaml src/config/schema.ts src/config/runtime.ts src/gateway/runtime.ts src/gateway/service.ts src/gateway test/unit/config-schema.test.ts test/unit/config-loader.test.ts test/integration/gateway-runtime.test.ts
git commit -m "gateway: remove legacy provider runtime"
```

### Task 3: Rename Gateway Run Queue to Pi Turn Queue

**Objective:** Replace `gateway_runs`/`gatewayRunId` naming in queue, events, RPC responses, and recovery with `pi_turns`/`piTurnId`.

**Files:**
- Create/Modify: `src/gateway/pi-turn-queue.ts`
- Modify: `src/gateway/server.ts`
- Modify: `src/gateway/recovery.ts`
- Modify: `src/gateway/pi-supervisor.ts` if naming leaks there
- Modify: `src/tui/client.ts` if wire types mention gateway runs
- Test: `test/integration/gateway-rpc.test.ts`
- Test: `test/unit/herdr-session-lifecycle.test.ts` if session lifecycle expects run events

**Interfaces:**
- Consumes `PiTurnStore` from Task 1.
- Produces `PiTurnQueue` with queued/claimed/start/recovery events.

- [x] **Step 1: Write failing queue/RPC tests**

In `test/integration/gateway-rpc.test.ts`, add or update cases:

1. `session.user_message` appends `user.message`, then `pi.turn.queued` with payload `{ piTurnId, triggeringEventId, piSessionFile, piSessionId }`.
2. Subscribed Pi owner receives `pi.turn.queued` and claims via `pi.claim_next_turn`.
3. `pi.claim_next_turn` returns `{ turn: { id, piTurnId, userText, triggeringEventId, actorId, presentation, piSessionFile, piSessionId } }`.
4. `pi.start_turn` for a queued turn marks the existing turn running and appends `pi.turn.started` once.
5. `pi.start_turn` for a direct interactive/RPC turn with no existing DB row creates a running `pi_turns` row with the supplied `piTurnId` and appends `pi.turn.started` once.
6. TUI owner priority is preserved: headless owner cannot claim when a TUI owner is attached and idle/running according to existing owner-priority logic.
7. Stale running owner marks the current running turn `recovery_required` and appends `recovery.note` with `piTurnId`.
8. Calls to `gateway.claim_next_run` and `gateway.start_run` return unknown method errors.

- [x] **Step 2: Run tests to verify failure**

Run:

```bash
pnpm test test/integration/gateway-rpc.test.ts
```

Expected: failures because server still exposes run terminology and queue classes.

- [x] **Step 3: Implement `PiTurnQueue`**

Create `src/gateway/pi-turn-queue.ts` exporting:

```ts
export type PiQueuedTurn = { event: EventRecord; turn: PiTurnRecord };
export type PiClaimedTurn = {
  actorId: string | null;
  id: string;
  piSessionFile?: string;
  piSessionId?: string;
  presentation: unknown;
  triggeringEventId: number | null;
  userText: string;
};

export class PiTurnQueue {
  queueTurn(input: { sessionId: string; triggeringEventId: number }): PiQueuedTurn;
  claimNextTurn(input: { ownerId: string; sessionId: string }): { event: EventRecord; turn: PiClaimedTurn } | undefined;
  startTurn(input: { inputEventIds: number[]; ownerId: string; ownerKind: PiOwnerKind; piSessionFile: string; piSessionId: string; piTurnId: string; sessionId: string; source: PiTurnSource; triggeringEventId?: number }): { events: EventRecord[]; turn: PiTurnRecord };
  completeTurnFromPi(input: { ownerId: string; piTurnId: string }): { events: EventRecord[]; turn: PiTurnRecord };
  failTurnFromPi(input: { message: string; ownerId: string; piTurnId: string }): { events: EventRecord[]; turn: PiTurnRecord };
  markRunningTurnRecoveryRequired(input: { message: string; ownerId: string; sessionId: string }): { events: EventRecord[]; turn: PiTurnRecord } | undefined;
}
```

Use `PiSessionMetadataStore.ensureForSession()` to populate `piSessionFile`/`piSessionId` on queued events. `startTurn()` must first try `PiTurnStore.getTurn(piTurnId)`; if the turn does not exist, create it with `createRunningTurn()` for direct interactive/RPC Pi work. Keep event type names `pi.turn.queued`, `pi.turn.started`, `pi.turn.completed`, `pi.turn.failed`, and `pi.turn.recovery_required`.

- [x] **Step 4: Wire server to Pi turn queue**

In `src/gateway/server.ts`:

- Replace `#gatewayRuns` with `#piTurns`.
- Replace `#wakeGatewayForUserMessage()` with `#queuePiTurnForUserMessage()`.
- Rename `#startHeadlessPiForQueuedRun()` to `#startHeadlessPiForQueuedTurn()` and read `piSessionFile` from `pi.turn.queued` payload.
- Replace dispatch branch `gateway.claim_next_run` with `pi.claim_next_turn`.
- Replace `gateway.start_run` with `pi.start_turn`; if Task 5 also uses `pi.start_turn` for direct turns, keep one method that handles both queued and direct turns.
- Publish events after appending in user-visible order: `user.message`, `pi.turn.queued`.

- [x] **Step 5: Update recovery**

In `src/gateway/recovery.ts`, replace `GatewayRunStore` usage with `PiTurnStore`. On startup:

- `queued` turns remain queued.
- `running` turns become `recovery_required` with a recovery note.
- No attempt is made to replay old provider turns.

- [x] **Step 6: Remove run terminology from active source**

Run:

```bash
rg -n "gatewayRun|GatewayRun|gateway\.run|gateway_runs|claim_next_run|start_run" src packages test README.md docs/plans -g '!docs/plans/archived/**'
```

Expected: no matches after this task, except changelog-like references in this new plan's historical sections. If this plan itself appears, ignore it.

- [x] **Step 7: Run focused tests**

Run:

```bash
pnpm test test/integration/gateway-rpc.test.ts test/unit/herdr-session-lifecycle.test.ts
```

Expected: tests pass.

- [x] **Step 8: Commit**

```bash
git add src/gateway/pi-turn-queue.ts src/gateway/server.ts src/gateway/recovery.ts src/gateway/service.ts src/tui/client.ts packages/shepherd-pi/src/index.ts test/integration/gateway-rpc.test.ts test/unit/herdr-session-lifecycle.test.ts
git commit -m "gateway: queue work as pi turns"
```

### Task 4: Implement Pi Runtime Event RPCs and Assistant Messages

**Objective:** Replace legacy completion/stream RPCs with `pi.*` RPC methods, persist `assistant.message`, and keep streaming deltas transient.

**Files:**
- Create: `src/gateway/pi-runtime-events.ts`
- Modify: `src/gateway/server.ts`
- Modify: `src/platforms/runtime.ts`
- Modify: `src/platforms/slack/delivery.ts`
- Modify: `src/platforms/slack/tool-progress.ts`
- Modify: `src/delivery/fanout.ts`
- Test: `test/unit/pi-runtime-events.test.ts`
- Test: `test/unit/slack-delivery.test.ts`
- Test: `test/integration/delivery-fanout.test.ts`
- Test: `test/integration/gateway-rpc.test.ts`

**Interfaces:**
- Consumes `PiTurnQueue` from Task 3.
- Produces final user/assistant/tool/lifecycle persistence and Slack delivery behavior.

- [x] **Step 1: Write failing helper tests**

Create `test/unit/pi-runtime-events.test.ts` with cases:

1. `sanitizePiPreviewText()` redacts `Authorization: Bearer abc`, `token=abc`, `password=abc`, `secret=abc`, and `api_key=abc`.
2. Sanitizer truncates to 240 chars by default and appends `...`.
3. `piTurnIdempotencyKey("turn-1", "assistant")` returns `pi:turn:turn-1:assistant`.
4. `piToolIdempotencyKey("turn-1", "tool-1", "completed")` returns `pi:turn:turn-1:tool:tool-1:completed`.
5. Param parsers reject missing `sessionId`, `ownerId`, `piTurnId`, invalid owner kind, and invalid tool status with explicit messages.

- [x] **Step 2: Implement runtime helper module**

Create `src/gateway/pi-runtime-events.ts` exporting:

```ts
export type PiOwnerKind = "headless_pi" | "tui_pi";
export type PiInputSource = "extension" | "interactive" | "rpc";
export type PiInputDelivery = "followUp" | "immediate" | "steer";
export type PiToolStatus = "completed" | "failed" | "started";
export type PiTerminalStatus = "completed" | "failed";

export function sanitizePiPreviewText(value: unknown, options?: { maxLength?: number }): string;
export function piTurnIdempotencyKey(piTurnId: string, suffix: "assistant" | "completed" | "failed" | "started"): string;
export function piToolIdempotencyKey(piTurnId: string, toolCallId: string, status: PiToolStatus): string;
export function parsePiMirrorUserMessageParams(value: unknown): PiMirrorUserMessageParams;
export function parsePiStartTurnParams(value: unknown): PiStartTurnParams;
export function parsePiRecordToolProgressParams(value: unknown): PiRecordToolProgressParams;
export function parsePiCompleteTurnParams(value: unknown): PiCompleteTurnParams;
export function parsePiFailTurnParams(value: unknown): PiFailTurnParams;
export function parsePiStreamDeltaParams(value: unknown): PiStreamDeltaParams;
export function parsePiStreamFinishParams(value: unknown): PiStreamFinishParams;
export function parsePiStreamSegmentBreakParams(value: unknown): PiStreamSegmentBreakParams;
```

Use parser return types that match the archived bidirectional sync plan, but replace `gatewayRunId` with optional `piTurnId` links only where needed. Do not include `gatewayRunId` in new params.

- [x] **Step 3: Write failing Slack/fanout tests**

Update tests:

1. `src/delivery/fanout.ts` delivers `assistant.message`, `user.message`, `approval.requested`, and `approval.responded` only.
2. `assistant.message` with `payload.deliveredByStream === true` is skipped by Slack normal delivery.
3. `user.message` with `presentation.sourcePlatform: "pi"` delivers to Slack bindings; Slack-originated user messages still skip echo.
4. `pi.turn.*`, `pi.tool.*`, `worker_agent.*`, and `herdr.progress` do not normal-fanout.
5. `SlackStreamDelivery` is keyed by generic `streamId` / `piTurnId`.

- [x] **Step 4: Implement `assistant.message` delivery**

In `src/delivery/fanout.ts`, replace `gateway.message` with `assistant.message` in `deliverableEventTypes`.

In `src/platforms/slack/delivery.ts`:

- Render `assistant.message.payload.text` like old `gateway.message`.
- Preserve skip behavior when `payload.deliveredByStream === true`.
- Render `user.message` prefixes:
  - `delivery: "steer"` → `↪ Steer: <text>`
  - `delivery: "followUp"` → `⏭ Follow-up: <text>`
  - otherwise `<text>`

- [x] **Step 5: Implement transient runtime delivery**

In `src/platforms/runtime.ts`, expose:

```ts
export type PiRuntimeDelivery = {
  completeToolProgress(input: { piTurnId: string; sessionId: string }): Promise<void>;
  delta(input: { delta: string; sessionId: string; streamId: string }): Promise<void>;
  failToolProgress(input: { message: string; piTurnId: string; sessionId: string }): Promise<void>;
  finish(input: { finalText?: string; streamId: string }): Promise<void>;
  hasFinished(streamId: string): boolean;
  recordToolProgress(input: { durationMs?: number; preview?: string; sessionId: string; status: "completed" | "failed" | "started"; text: string; toolName: string; piTurnId: string }): Promise<void>;
  segmentBreak?(input: { sessionId: string; streamId: string }): Promise<void>;
};
```

Wire Slack stream delivery and `SlackToolProgressDelivery` to every Slack binding for a session.

- [x] **Step 6: Implement `pi.*` server handlers**

In `src/gateway/server.ts`, add handlers:

```ts
pi.mirror_user_message
pi.start_turn
pi.stream_delta
pi.stream_finish
pi.stream_segment_break
pi.record_tool_progress
pi.complete_turn
pi.fail_turn
```

Behavior:

- `pi.mirror_user_message`: append `user.message`, publish, fanout, never queue another turn.
- `pi.start_turn`: validate owner/session and append idempotent `pi.turn.started` or mark queued turn running when the turn was queued.
- `pi.stream_delta`: when `runtimeDelivery` exists, call `runtimeDelivery.delta({ streamId: piTurnId, ... })` and return `{ streamed: true }`; when absent, persist nothing and return `{ streamed: false, reason: "runtime_delivery_unavailable" }`.
- `pi.stream_finish`: when `runtimeDelivery` exists, call `runtimeDelivery.finish({ streamId: piTurnId, finalText })` and return `{ streamed: true }`; when absent, persist nothing and return `{ streamed: false, reason: "runtime_delivery_unavailable" }`.
- `pi.stream_segment_break`: call delivery if supported; otherwise return `{ streamed: false, reason: "segment_break_not_supported" }`. If `runtimeDelivery` is absent, return `{ streamed: false, reason: "runtime_delivery_unavailable" }`.
- `pi.record_tool_progress`: append `pi.tool.started/completed/failed` and publish it even when `runtimeDelivery` is absent. If delivery exists, update transient Slack progress; if delivery is absent, skip progress delivery and still return the persisted event.
- `pi.complete_turn`: first-terminal-wins; append `assistant.message`, append `pi.turn.completed`, mark `pi_turns` completed, publish `assistant.message` before lifecycle event, and call `runtimeDelivery.completeToolProgress()` only when delivery exists.
- `pi.fail_turn`: first-terminal-wins; append `pi.turn.failed`, mark `pi_turns` failed, call `runtimeDelivery.failToolProgress()` only when delivery exists, and do not fabricate `assistant.message`.

Terminal conflict behavior:

- If existing terminal is same, return idempotent success.
- If existing terminal differs, append `pi.turn.terminal_conflict` and return `{ ignored: true, conflict: true }`.
- Detect terminal state with idempotency-key lookups, not limited event scans.

- [x] **Step 7: Remove legacy RPC handlers**

Delete dispatch and method implementations for:

```text
gateway.stream_delta
gateway.stream_finish
gateway.stream_segment_break
gateway.stream_tool_progress
gateway.complete_run
gateway.fail_run
```

Tests should assert these now return unknown method errors.

- [x] **Step 8: Run focused tests**

Run:

```bash
pnpm test test/unit/pi-runtime-events.test.ts test/unit/slack-delivery.test.ts test/integration/delivery-fanout.test.ts test/integration/gateway-rpc.test.ts
```

Expected: all tests pass.

- [x] **Step 9: Commit**

```bash
git add src/gateway/pi-runtime-events.ts src/gateway/server.ts src/platforms/runtime.ts src/platforms/slack/delivery.ts src/platforms/slack/tool-progress.ts src/delivery/fanout.ts test/unit/pi-runtime-events.test.ts test/unit/slack-delivery.test.ts test/integration/delivery-fanout.test.ts test/integration/gateway-rpc.test.ts
git commit -m "gateway: persist pi turns and assistant messages"
```

### Task 5: Update Shepherd Pi Extension for Pi Turns

**Objective:** Make `shepherd-pi` use the new `pi.*` turn protocol, mirror attached Pi conversation, and inject the revised minimal hidden context.

**Files:**
- Modify: `packages/shepherd-pi/src/index.ts`
- Modify: `packages/shepherd-pi/skills/shepherd/SKILL.md`
- Test: `test/unit/shepherd-pi-extension.test.ts`

**Interfaces:**
- Consumes Task 4 RPCs.
- Produces Pi-side mirroring, streaming, tool progress, and terminal state.

- [x] **Step 1: Write failing extension tests**

Extend `test/unit/shepherd-pi-extension.test.ts` or add a new test harness around exported helpers so it verifies:

1. Hidden context contains `Current Pi turn id:` when active and does not mention Gateway run ids.
2. Hidden context contains the exact execution-surface guidance from Global Constraints.
3. Hidden context says `Use shepherd_herdr_read for normal read-only Herdr inspection`.
4. Gateway response map no longer includes legacy `gateway.stream_*` or `gateway.complete_run` calls in compiled TypeScript checks.
5. Registered tool names still use `shepherd_${tool.name}`.

Export a pure `buildShepherdHiddenContext(state)` helper from `packages/shepherd-pi/src/index.ts` and test it directly. Cover lifecycle RPC behavior through TypeScript checks plus `test/integration/gateway-rpc.test.ts`; do not build a full fake Pi runtime harness in this task.

- [x] **Step 2: Update extension state and RPC map**

In `packages/shepherd-pi/src/index.ts`:

- Rename `currentRun` to `currentTurn`.
- Store `activePiTurnId`, `activeInputEventIds`, `activeSource`, `pendingImmediate`, `pendingFollowUps`, and `toolStartTimes`.
- Replace `ShepherdRun` type with `ShepherdTurn` carrying `id`, `userText`, `triggeringEventId`, `actorId`, `presentation`, `piSessionFile`, and `piSessionId`.
- Replace response map methods:
  - `gateway.claim_next_run` → `pi.claim_next_turn`
  - `gateway.start_run` → `pi.start_turn`
  - remove legacy completion/stream methods
  - add `pi.mirror_user_message`, `pi.stream_delta`, `pi.stream_finish`, `pi.stream_segment_break`, `pi.record_tool_progress`, `pi.complete_turn`, and `pi.fail_turn`.

- [x] **Step 3: Implement Pi input mirroring**

Add `pi.on("input", ...)`:

- If unattached, return continue.
- If `source === "extension"`, do not mirror; this is Shepherd-injected input from queued Slack/user work.
- For `source === "interactive" | "rpc"`, create or reuse a `piTurnId` according to delivery:
  - immediate: new pending turn
  - steer: current active turn if present, otherwise new pending turn
  - followUp: new pending follow-up turn
- Call `pi.mirror_user_message` with `delivery`, `displayName`, `ownerId`, `ownerKind`, `piSessionFile`, `piSessionId`, `piTurnId`, `sessionId`, `source`, and `text`.
- Store returned event id in pending input state.

- [x] **Step 4: Start turns through `pi.start_turn`**

Add or update `pi.on("agent_start", ...)`:

- For a queued Shepherd turn, use the claimed `piTurnId` and `triggeringEventId`.
- For direct Pi input, use the pending immediate/follow-up turn and its mirrored event id.
- For unexpected agent start, create a new `piTurnId` with no input event ids.
- Set `activePiTurnId` before the model runs so hidden context can show it.
- Call `pi.start_turn` with `source`, `inputEventIds`, owner/session/Pi metadata.

- [x] **Step 5: Stream assistant output**

Update `message_update` handling:

- Compute deltas as current implementation does.
- Call `pi.stream_delta` with `piTurnId`; do not call legacy Gateway stream RPCs.
- Keep `message_end` storing `lastAssistantText`.

Update `agent_end`:

- Call `pi.stream_finish` first.
- Call `pi.complete_turn` with final text and active turn metadata.
- Clear active turn state and claim the next queued turn.
- On finalization error, call `pi.fail_turn` once with a short message.

- [x] **Step 6: Record Pi tool lifecycle**

Use Pi hooks `tool_execution_start`, `tool_execution_update`, and `tool_execution_end`. Register `tool_execution_update` as a no-op handler so mid-stream tool updates are not persisted in this rebuild.

Start:

- Store start time and sanitized preview.
- Call `pi.record_tool_progress` with `status: "started"`.

End:

- Compute duration.
- Call `pi.record_tool_progress` with `status: "completed"` or `"failed"`.
- Do not send raw args/result.

- [x] **Step 7: Update claim-next flow**

Replace `claimNext()` internals:

- Request `pi.claim_next_turn`.
- If no turn, return.
- Set `currentTurn`.
- Do not call `pi.mirror_user_message`; the queued Slack/user message already exists as `user.message`.
- Call `pi.sendUserMessage(turn.userText)`.

- [x] **Step 8: Update hidden context and skill doc**

Change `before_agent_start` hidden context to exactly the form in **Core Interfaces / Hidden Shepherd Context**. Replace `Gateway run id` with `Current Pi turn id`.

Update `packages/shepherd-pi/skills/shepherd/SKILL.md` as optional reference only. It should say normal attached sessions rely on hidden context and dynamic tool descriptions.

- [x] **Step 9: Run validation**

Run:

```bash
pnpm test test/unit/shepherd-pi-extension.test.ts
pnpm pi-package:check
```

Expected: tests and package validation pass.

- [x] **Step 10: Commit**

```bash
git add packages/shepherd-pi/src/index.ts packages/shepherd-pi/skills/shepherd/SKILL.md test/unit/shepherd-pi-extension.test.ts
git commit -m "pi: drive shepherd turns through pi runtime rpc"
```

### Task 6: Rename and Extend Shepherd Logical Tools

**Objective:** Implement the two-layer tool surface, rename old tools without aliases, and add worker binding read/ensure tools.

**Files:**
- Modify: `src/gateway/tools.ts`
- Modify: `src/gateway/builtin-tools.ts`
- Modify: `src/herdr/orchestrator.ts`
- Modify: `src/tui/client.ts` if tool wire types change
- Test: `test/integration/builtin-tools.test.ts`
- Test: `test/integration/gateway-rpc.test.ts` for `tool.run` context

**Interfaces:**
- Consumes `WorkerAgentBindingStore` and `PiTurnStore` from Task 1.
- Produces renamed tools and worker binding behavior.

- [x] **Step 1: Write failing built-in tool tests**

Update `test/integration/builtin-tools.test.ts`:

1. Registry exposes exactly these internal tool names:

```ts
[
  "attach_workspace",
  "ensure_workspace",
  "ensure_worker_agent",
  "get_worker_agent",
  "herdr_open_pane",
  "herdr_read",
  "herdr_read_agent",
  "herdr_read_pane",
  "herdr_run_pane_command",
  "herdr_send_agent_message",
  "herdr_send_pane_text",
  "herdr_wait_for_agent",
  "herdr_wait_for_event",
  "list_worker_agents",
  "resolve_working_context",
  "session_read",
  "workspace_discovery"
]
```

2. Old names listed in **Core Interfaces / Tool Names** are absent.
3. `ensure_worker_agent` with an existing `(sessionId, workspaceId, agentName)` binding returns the existing binding and does not call `HerdrSocketClient.startAgent` again.
4. `ensure_worker_agent` creates a binding with `role`, `description`, and `lastTask` when absent.
5. `list_worker_agents` and `get_worker_agent` read DB binding state without Herdr calls.
6. Low-level tools use `herdr_` internal names.
7. Every tool has `promptSnippet`; boundary tools have `promptGuidelines` naming the visible `shepherd_*` tool.

- [x] **Step 2: Run tests to verify failure**

Run:

```bash
pnpm test test/integration/builtin-tools.test.ts
```

Expected: failures because names and worker tools are not implemented.

- [x] **Step 3: Add `piTurnId` to logical tool context**

In `src/gateway/tools.ts`:

- Change `LogicalToolContext` to include `piTurnId: string`.
- Change `LogicalToolCallStore.begin()` to require `piTurnId`.
- Change idempotency lookup from `(sessionId, idempotencyKey)` to `(piTurnId, idempotencyKey)`.
- Emit timeline events with event types `pi.tool.started`, `pi.tool.completed`, `pi.tool.failed` and payload `{ toolCallId, toolName, piTurnId, status }`.
- Keep `logical_tool_calls.result_json` as the detailed result source.

If a tool is run outside a Pi turn from a CLI/admin path, require callers to pass a synthetic `piTurnId` such as `manual:<uuid>` and create a corresponding `pi_turns` record first; do not allow missing `piTurnId` silently.

- [x] **Step 4: Rename tool registrations**

In `src/gateway/builtin-tools.ts`, rename registrations according to **Core Interfaces / Tool Names**.

Update prompt guidance:

- `ensure_workspace`: high-level Shepherd workspace ensure, no `herdr_`.
- `attach_workspace`: only when user explicitly asks to attach an existing non-Shepherd Herdr workspace.
- `ensure_worker_agent`: high-level worker ensure/reuse with `role`, `description`, `lastTask`.
- `herdr_read`: normal read-only Herdr inspection.
- `herdr_*` mutation tools: only inside Shepherd-managed Herdr resources.

- [x] **Step 5: Implement worker tools**

Add input schemas:

`ensure_worker_agent`:

```ts
{
  agentName: string;
  agentProfile: string;
  description?: string;
  lastTask?: string;
  role: "implementation" | "review" | "research" | "test" | "general";
  taskSlug: string;
  workingContextSlug: string;
  workingDirectory: string;
}
```

Behavior:

1. Ensure workspace.
2. If worker binding exists for `(sessionId, workspaceId, agentName)`, return it and do not start a new Herdr agent.
3. If absent, start Herdr agent through orchestrator, upsert worker binding with `bindingHealth: "present"`, `agentStatus: "unknown"`, and emit `worker_agent.bound`.

`list_worker_agents`:

```ts
{ sessionScope?: "current" }
```

Return all worker bindings for `context.sessionId`.

`get_worker_agent`:

```ts
{ agentName: string; workspaceId?: string }
```

If `workspaceId` is omitted and exactly one worker with `agentName` exists in session, return it. If multiple exist, throw `workspaceId is required because multiple worker agents match`.

- [x] **Step 6: Run tests**

Run:

```bash
pnpm test test/integration/builtin-tools.test.ts test/integration/gateway-rpc.test.ts
```

Expected: tests pass.

- [x] **Step 7: Commit**

```bash
git add src/gateway/tools.ts src/gateway/builtin-tools.ts src/herdr/orchestrator.ts src/tui/client.ts test/integration/builtin-tools.test.ts test/integration/gateway-rpc.test.ts
git commit -m "tools: split shepherd and herdr tool surface"
```

### Task 7: Rebuild Herdr Progress on `events.subscribe`

**Objective:** Replace broken `events.wait` progress polling with long-lived Herdr `events.subscribe` streams and update worker binding status best-effort.

**Files:**
- Modify: `src/herdr/socket-client.ts`
- Modify: `src/herdr/progress-subscriptions.ts`
- Modify: `src/herdr/orchestrator.ts` if subscription starts on workspace binding
- Test: `test/integration/herdr-progress.test.ts`
- Test: `test/integration/herdr-socket-client.test.ts`

**Interfaces:**
- Consumes `WorkerAgentBindingStore`.
- Produces internal `herdr.progress` events and best-effort `worker_agent.status_changed` events.

- [x] **Step 1: Write failing socket client tests**

In `test/integration/herdr-socket-client.test.ts`, add a fake Herdr socket server that responds to `events.subscribe` by streaming JSON Lines notifications. Test:

1. `subscribeEvents({ workspace_id: "w1" })` sends method `events.subscribe`.
2. The returned async iterator yields notification frames with no response id.
3. Calling `return()` or aborting closes/destroys the subscription socket without closing unrelated request clients.
4. `waitForEvent()` is no longer used by progress subscriptions. Keep `waitForEvent()` only if low-level `herdr_wait_for_event` still needs a compatibility wrapper; do not use it for automatic progress.

- [x] **Step 2: Write failing progress manager tests**

In `test/integration/herdr-progress.test.ts`, update tests:

1. Manager subscribes once per `(sessionId, herdrSessionName, workspaceId)`.
2. Incoming `pane.agent_status_changed` events append `herdr.progress` through `receiveProgress`.
3. Agent status events update `WorkerAgentBindingStore.updateObservedState()` when `agentName` or pane target can be matched.
4. A subscription stream error calls `onError`, waits `retryDelayMs`, and reconnects.
5. `close()` aborts active subscriptions.

- [x] **Step 3: Run tests to verify failure**

Run:

```bash
pnpm test test/integration/herdr-socket-client.test.ts test/integration/herdr-progress.test.ts
```

Expected: failures because current code uses `events.wait`.

- [x] **Step 4: Implement Herdr event subscription client**

In `src/herdr/socket-client.ts`, add:

```ts
subscribeEvents(params: { workspace_id?: string; event_types?: string[] }, options?: { signal?: AbortSignal }): AsyncIterable<unknown>
```

Implementation requirements:

- Use a dedicated socket connection for the subscription.
- Send JSON Lines request `{ id, method: "events.subscribe", params }`.
- Resolve initial subscription only after a response with matching id and no error.
- Yield subsequent notification frames. Accept both shapes `{ method, params }` and raw event objects; normalize only enough to pass raw event through.
- Abort/destroy socket when `signal` aborts or iterator returns.

- [x] **Step 5: Rewrite progress manager**

In `src/herdr/progress-subscriptions.ts`:

- Replace `HerdrEventSource.waitForEvent()` dependency with `source.subscribeEvents()`.
- Subscribe to Herdr event types that exist in Herdr 0.7.0, including `pane.agent_status_changed` and `pane.output_matched` if the API accepts filters. If filtering causes an error, retry with no filter and filter client-side.
- For every raw event, call `receiveProgress({ sessionId, herdrSessionName, workspaceId, rawEvent })`.
- Update worker binding store when event type and payload identify an agent target/pane.
- Treat status as best-effort: set `agentStatus`, `bindingHealth: "present"`, and `lastSeenAt` on observed status; set `bindingHealth: "error"` only for explicit error observations.

- [x] **Step 6: Wire subscription on workspace binding**

In `src/gateway/runtime.ts` or `src/herdr/orchestrator.ts`, keep existing `onWorkspaceBound` style but ensure it calls the new subscription manager. The call should happen for both `ensure_workspace` and `attach_workspace`.

- [x] **Step 7: Run tests**

Run:

```bash
pnpm test test/integration/herdr-socket-client.test.ts test/integration/herdr-progress.test.ts
```

Expected: tests pass.

- [x] **Step 8: Commit**

```bash
git add src/herdr/socket-client.ts src/herdr/progress-subscriptions.ts src/herdr/orchestrator.ts src/gateway/runtime.ts test/integration/herdr-socket-client.test.ts test/integration/herdr-progress.test.ts
git commit -m "herdr: subscribe to progress events"
```

### Task 8: Update Gateway Context, Summary, and Recovery Boundaries

**Objective:** Keep Shepherd event context useful for audit/recovery/admin while ensuring normal Pi turns do not use Shepherd summary or reconstructed LLM context.

**Files:**
- Modify: `src/gateway/context.ts`
- Modify: `src/db/session-summary.ts` only if types need event-name updates
- Modify: `src/gateway/server.ts` if summary wiring remains
- Delete: provider-backed summary updater tests
- Test: `test/unit/gateway-context.test.ts`
- Test: `test/integration/session-summary.test.ts`

**Interfaces:**
- Consumes event names from Task 4.
- Produces context formatter for admin/recovery only.

- [x] **Step 1: Write failing context tests**

Update `test/unit/gateway-context.test.ts`:

1. `assistant.message` becomes assistant role with text.
2. Pi-originated `user.message` formats as `Pi: <text>` or `Pi RPC: <text>`.
3. `delivery: "steer"` formats as `Pi steer: <text>`.
4. `delivery: "followUp"` formats as `Pi follow-up: <text>`.
5. `pi.tool.completed` and `pi.tool.failed` become system role with sanitized compact text.
6. `pi.tool.started`, `pi.turn.*`, `worker_agent.*`, and `herdr.progress` are omitted from normal context formatter unless a new explicit `includeInternal` option is true.
7. Passing a `summary` option still prepends a system message, but no production path calls it for normal Pi turns.

- [x] **Step 2: Run tests to verify failure**

Run:

```bash
pnpm test test/unit/gateway-context.test.ts test/integration/session-summary.test.ts
```

Expected: context tests fail on old `gateway.message` behavior; session summary store tests should still pass.

- [x] **Step 3: Update context formatter**

In `src/gateway/context.ts`:

- Replace `gateway.message` handling with `assistant.message`.
- Add Pi source/delivery formatting.
- Add `pi.tool.completed`/`pi.tool.failed` compact system entries.
- Keep summary injection only as an explicit function option for admin/recovery callers.

- [x] **Step 4: Remove automatic summary updater path**

Ensure no production code imports `GatewaySummaryUpdater` or calls `maybeUpdate()`.

Run:

```bash
rg -n "GatewaySummaryUpdater|maybeUpdate\(|summaryUpdater" src test
```

Expected: no matches for deleted updater code. `summary.updated` may remain as an event type for future/manual updates.

- [x] **Step 5: Run tests**

Run:

```bash
pnpm test test/unit/gateway-context.test.ts test/integration/session-summary.test.ts
```

Expected: tests pass.

- [x] **Step 6: Commit**

```bash
git add src/gateway/context.ts src/db/session-summary.ts src/gateway/server.ts test/unit/gateway-context.test.ts test/integration/session-summary.test.ts
git commit -m "gateway: keep summaries out of pi turns"
```

### Task 9: Update Service Wiring and Pi Readiness

**Objective:** Make the daemon/service start provider-free Pi runtime wiring, wake headless Pi by queued Pi turns, and keep TUI owner priority/recovery behavior.

**Files:**
- Modify: `src/gateway/service.ts`
- Modify: `src/gateway/pi-supervisor.ts`
- Modify: `src/gateway/pi-readiness.ts` if readiness command args change
- Modify: `src/cli/shepherd.ts` if config validation output changes
- Test: `test/integration/gateway-rpc.test.ts`
- Test: `test/unit/pi-readiness.test.ts`
- Test: `test/unit/cli.test.ts`

**Interfaces:**
- Consumes Tasks 2-4.
- Produces service startup path with Pi turn queue and no provider fallback.

- [x] **Step 1: Write failing service wiring tests**

Add/update tests:

1. Starting gateway with valid config and no provider fields creates `HeadlessPiSupervisor` and Pi turn queue.
2. `session.user_message` queues `pi.turn.queued` and starts headless Pi with `piSessionFile` from the queued event.
3. If a TUI owner is attached, headless owner does not claim while TUI owner is active according to existing owner priority rules.
4. If TUI owner disconnects idle, headless can resume.
5. If TUI owner disappears while running, the turn becomes `recovery_required` and no automatic replay occurs.

- [x] **Step 2: Run tests to verify failure**

Run:

```bash
pnpm test test/integration/gateway-rpc.test.ts test/unit/pi-readiness.test.ts
```

Expected: failures until service/server names are updated.

- [x] **Step 3: Update service wiring**

In `src/gateway/service.ts`:

- Remove conditional `gatewayRuntime.runner` checks.
- Always pass `piTurns: gatewayRuntime.turns` to `ShepherdGatewayServer` when config exists.
- Pass `runtimeDelivery: platformRuntime.runtimeDelivery`.
- Keep `checkPiReadiness()` when config exists and Pi runtime is enabled.
- Apply `config.gateway.pi?.idle_timeout_ms ?? 600_000` and `readiness_timeout_ms ?? 10_000`.

- [x] **Step 4: Update headless Pi startup event parsing**

Replace any helper reading `gatewayRunId` with one reading queued Pi turn payload:

```ts
function getQueuedTurnPiSessionFile(payload: unknown): string | undefined
```

It should read `payload.piSessionFile`.

- [x] **Step 5: Run tests**

Run:

```bash
pnpm test test/integration/gateway-rpc.test.ts test/unit/pi-readiness.test.ts
```

Expected: tests pass.

- [x] **Step 6: Commit**

```bash
git add src/gateway/service.ts src/gateway/pi-supervisor.ts src/gateway/pi-readiness.ts src/cli/shepherd.ts test/integration/gateway-rpc.test.ts test/unit/pi-readiness.test.ts
git commit -m "gateway: run pi runtime without provider fallback"
```

### Task 10: Update README and Active Documentation

**Objective:** Document the new Pi/Herdr/Gateway split and remove active provider-runner instructions.

**Files:**
- Modify: `README.md`
- Modify: `docs/plans/2026-06-30-pi-runtime-gateway-rebuild.md` if implementation discovers a mismatch in this plan's active references
- Do not rewrite archived plans except this plan already supersedes them.

**Interfaces:**
- Consumes completed code behavior from previous tasks.
- Produces user-facing documentation aligned with current config and runtime.

- [x] **Step 1: Search stale active docs**

Run:

```bash
rg -n "provider|default_provider|gateway\.message|gateway\.run|GatewayRunner|gatewayRunId|gateway\.stream_|gateway\.complete_run|gateway_runs" README.md docs/plans -g '!docs/plans/archived/**'
```

Expected before docs update: matches in README and this plan's historical sections. Only README content that describes current behavior must be changed.

- [x] **Step 2: Update README config example**

Remove provider config examples. The minimal config should include:

```yaml
default_agent: claude
agents:
  claude:
    command: claude
    args: ["--dangerously-skip-permissions"]
gateway:
  pi:
    idle_timeout_ms: 600000
    readiness_timeout_ms: 10000
```

Keep Slack config examples for `platforms.slack.allowed_users`, tokens, channel allowlists, and `streaming.tool_progress` because those fields remain in `src/config/schema.ts`.

- [x] **Step 3: Update architecture prose**

Add a short section:

```text
Pi owns model/provider/session conversation state.
Herdr owns terminal execution surfaces.
Shepherd Gateway owns platform sessions, delivery, Pi turn queueing, logical tool policy/idempotency, Herdr bindings, and recovery events.
```

Mention that DB reset is acceptable during development if old migrations conflict.

- [x] **Step 4: Update tool naming docs**

If README lists tools, update to the new `shepherd_ensure_worker_agent`, `shepherd_herdr_*`, `shepherd_list_worker_agents`, and `shepherd_get_worker_agent` names.

- [x] **Step 5: Run docs-adjacent checks**

Run:

```bash
pnpm test test/unit/config-loader.test.ts test/unit/config-schema.test.ts
pnpm lint
```

Expected: tests and Biome pass.

- [x] **Step 6: Commit**

```bash
git add README.md docs/plans/2026-06-30-pi-runtime-gateway-rebuild.md
git commit -m "docs: describe pi runtime gateway architecture"
```

### Task 11: Final Cleanup and Full Validation

**Objective:** Remove stale active references, validate the full repo, and ensure the build output resolves imports.

**Files:**
- Modify/delete any active source/test/doc files found by searches.
- No archived plan rewrites unless they block tooling.

**Interfaces:**
- Consumes all previous tasks.
- Produces a clean provider-free Pi runtime gateway implementation.

- [x] **Step 1: Search legacy provider/runtime names**

Run:

```bash
rg -n "GatewayRunner|GatewayProvider|provider_overrides|default_provider|gateway\.model|providers:|gatewayRunId|gateway_runs|gateway\.run|gateway\.message|gateway\.stream_|gateway\.complete_run|gateway\.fail_run" src packages test README.md docs/plans -g '!docs/plans/archived/**'
```

Expected: no active source/test/README matches. This plan may contain historical search terms; do not treat this plan's own historical checklist as a failure.

- [x] **Step 2: Search new names**

Run:

```bash
rg -n "pi_turns|pi\.turn|assistant\.message|ensure_worker_agent|worker_agent_bindings|events\.subscribe|shepherd_herdr_read" src packages test README.md docs/plans/2026-06-30-pi-runtime-gateway-rebuild.md
```

Expected: implementation, tests, README, and this plan reference the new names.

- [x] **Step 3: Run DB check and migration apply on a fresh home**

Run:

```bash
pnpm db:check
SHEPHERD_HOME=/tmp/shepherd-pi-runtime-rebuild pnpm db:migrate
```

Expected: Drizzle check passes and migration applies to a fresh SQLite DB.

- [x] **Step 4: Run full validation**

Run:

```bash
pnpm check
```

Expected: typecheck, tests, Biome lint, format check, Drizzle check, and Pi package check pass.

- [x] **Step 5: Run build validation**

Run:

```bash
pnpm build
```

Expected: TypeScript build and alias rewriting complete successfully.

- [x] **Step 6: Commit**

```bash
git add src packages test README.md drizzle docs/plans/2026-06-30-pi-runtime-gateway-rebuild.md
git commit -m "chore: validate pi runtime gateway rebuild"
```

## Validation

- `pnpm test test/integration/pi-turn-store.test.ts test/integration/worker-agent-bindings.test.ts` — DB stores pass.
- `pnpm test test/unit/config-schema.test.ts test/unit/config-loader.test.ts` — provider-free config validates correctly.
- `pnpm test test/integration/gateway-runtime.test.ts` — runtime wiring is provider-free.
- `pnpm test test/unit/pi-runtime-events.test.ts` — Pi payload helpers, parsers, idempotency, and sanitizer pass.
- `pnpm test test/unit/slack-delivery.test.ts` — generic stream keys, `assistant.message`, and tool progress pass.
- `pnpm test test/integration/delivery-fanout.test.ts` — Pi user messages deliver, Slack echo prevention remains, and internal events do not normal-fanout.
- `pnpm test test/integration/gateway-rpc.test.ts` — Pi turn queue/RPC/terminal conflict behavior passes.
- `pnpm test test/integration/builtin-tools.test.ts` — renamed tools and worker bindings pass.
- `pnpm test test/integration/herdr-socket-client.test.ts test/integration/herdr-progress.test.ts` — `events.subscribe` progress path passes.
- `pnpm test test/unit/shepherd-pi-extension.test.ts` — extension hidden context/tool registration tests pass.
- `pnpm pi-package:check` — package validation passes.
- `pnpm db:check` — Drizzle schema/migration state passes.
- `SHEPHERD_HOME=/tmp/shepherd-pi-runtime-rebuild pnpm db:migrate` — fresh DB migration succeeds.
- `pnpm check` — repository validation passes.
- `pnpm build` — compiled output resolves imports.

## Risks, Tradeoffs, and Open Questions

- DB compatibility is intentionally dropped. Developers must reset old `$SHEPHERD_HOME` state when testing this rebuild.
- Headless Pi uses normal Pi configuration. If that configuration exposes raw Herdr mutation tools, Shepherd relies on prompt guidance rather than Gateway interception.
- `worker_agent_bindings.agentStatus` and `bindingHealth` are best-effort cache fields. Strict current state must be confirmed with `shepherd_herdr_read` or a direct Herdr read when Shepherd tools are insufficient.
- `events.subscribe` behavior should be verified against the installed Herdr version during implementation. If Herdr rejects filtered subscriptions, subscribe broadly and filter client-side.
- This plan keeps `session_summaries` storage but removes automatic updating. If summary updates are needed later, design a Pi-runtime summary job instead of reintroducing provider config.
- The plan uses `assistant.message` even though the archived runtime-events plan used `gateway.message`; implementation must update Slack delivery, context formatting, and tests together to avoid mixed naming.
- `pi.stream_segment_break` may initially return `{ streamed: false, reason: "segment_break_not_supported" }` if Slack stream segmentation is not implemented in the same task. Do not persist a fake event for segment breaks.
- Tool progress compact/verbose output remains sanitized. Do not add raw args/result display to Slack verbose mode.
