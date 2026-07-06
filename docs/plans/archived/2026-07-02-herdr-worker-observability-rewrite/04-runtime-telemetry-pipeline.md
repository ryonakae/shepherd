# Runtime Telemetry Pipeline

Parent: [2026-07-02-herdr-worker-observability-rewrite.md](../2026-07-02-herdr-worker-observability-rewrite.md)

## Status

Done.

## Progress

- Done — Task 5 through Task 8.

## Next steps

- No remaining implementation steps. Final validation passed with `pnpm check` and `pnpm build`.

## Objective

Implement runtime-neutral adapters, Pi telemetry/transcript ingestion, deterministic rules, and WorkerStatePipeline.

## Scope

Task 5 through Task 8.

### Task 5: Implement Runtime-Neutral Transcript Adapters with Pi First

**Objective:** Define adapter interfaces and implement Pi session JSONL transcript backfill.

**Files:**
- Create: `src/observability/runtime-adapter.ts`
- Create: `src/observability/pi-transcript-adapter.ts`
- Test: `test/unit/pi-transcript-adapter.test.ts`

**Interfaces:**
- Consumes: `AgentSessionRef` and Pi session format.
- Produces: transcript summaries and evidence for pipeline backfill.

- [x] **Step 1: Write failing tests**

Create fixture JSONL in test code with:

```json
{"type":"session","version":3,"id":"pi-session","timestamp":"2026-07-02T00:00:00.000Z","cwd":"/repo"}
{"type":"message","id":"u1","parentId":null,"timestamp":"2026-07-02T00:00:01.000Z","message":{"role":"user","content":"implement feature"}}
{"type":"message","id":"a1","parentId":"u1","timestamp":"2026-07-02T00:00:02.000Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"tool-1","name":"bash","arguments":{"command":"pnpm test"}}],"stopReason":"toolUse"}}
{"type":"message","id":"t1","parentId":"a1","timestamp":"2026-07-02T00:00:03.000Z","message":{"role":"toolResult","toolCallId":"tool-1","toolName":"bash","content":[{"type":"text","text":"failed: expected true to be false"}],"isError":true}}
{"type":"message","id":"a2","parentId":"t1","timestamp":"2026-07-02T00:00:04.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Blocked: tests fail because fixture is outdated."}],"stopReason":"stop"}}
```

Assert adapter returns:

- latest assistant excerpt
- last tool summary with `isError: true`
- blocked hint from final assistant text
- evidence refs containing session file path and entry ids

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm test test/unit/pi-transcript-adapter.test.ts`

Expected: module missing.

- [x] **Step 3: Define interfaces**

Create `src/observability/runtime-adapter.ts`:

```ts
import type { AgentSessionRef, WorkerSnapshot, WorkerTelemetryEvent } from "./contracts.js";

export type TranscriptBackfill = {
  evidence: WorkerSnapshot["evidence"];
  lastMessageExcerpt: string | null;
  lastTool: WorkerSnapshot["lastTool"];
  statusHints: {
    blockedReason?: string;
    completion?: string;
    needsInput?: boolean;
  };
};

export interface TranscriptAdapter {
  canRead(session: AgentSessionRef): boolean;
  read(session: AgentSessionRef): Promise<TranscriptBackfill>;
}

export interface WorkerRuntimeAdapter {
  readonly runtime: string;
  readonly transcript?: TranscriptAdapter;
  normalizeTelemetry(input: unknown): WorkerTelemetryEvent;
}
```

- [x] **Step 4: Implement Pi transcript adapter**

Create `PiTranscriptAdapter` that:

- supports `session.source === "herdr:pi" && session.agent === "pi" && session.kind === "path"`
- reads JSONL from `session.value`
- ignores malformed lines instead of throwing unless the file itself cannot be read
- extracts last assistant text from text content blocks
- extracts last toolResult with text content, `toolCallId`, `toolName`, `isError`
- redacts and truncates excerpts to 4096 characters
- sets blocked hint when final assistant text matches `/\b(blocked|ブロック|確認が必要|cannot proceed|need input)\b/i`
- sets completion hint when final assistant text matches `/\b(done|completed|完了|実装しました|修正しました)\b/i`

- [x] **Step 5: Run tests**

Run: `pnpm test test/unit/pi-transcript-adapter.test.ts`

Expected: all tests pass.

- [x] **Step 6: Commit**

```bash
git add src/observability/runtime-adapter.ts src/observability/pi-transcript-adapter.ts test/unit/pi-transcript-adapter.test.ts
git commit -m "feat(observability): add Pi transcript adapter"
```

### Task 6: Implement Pi Live Telemetry Normalization

**Objective:** Convert Pi extension live events into bounded runtime-neutral telemetry.

**Files:**
- Create: `src/observability/pi-telemetry.ts`
- Test: `test/unit/pi-telemetry.test.ts`

**Interfaces:**
- Consumes: `WorkerTelemetryEvent`.
- Produces: sanitizer and parser used by daemon RPC and Pi extension tests.

- [x] **Step 1: Write failing tests**

Assert:

1. secret-like values are redacted: `Authorization: Bearer abc`, `token=abc`, `password=abc`, `secret=abc`, `api_key=abc`.
2. excerpts are truncated to 4096 characters by default.
3. `normalizePiToolTelemetry()` emits `worker.tool.completed` with `artifactRefs` and `redactionApplied`.
4. `normalizePiMessageFinalTelemetry()` emits completion/blocked/needsInput hints from final text.
5. idempotency key format is `telemetry:pi:<turnId>:tool:<toolCallId>:completed` for tool events and `telemetry:pi:<turnId>:message:final` for final message.

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm test test/unit/pi-telemetry.test.ts`

Expected: module missing.

- [x] **Step 3: Implement helper functions**

Create:

```ts
export function sanitizeTelemetryExcerpt(value: unknown, options: { maxLength?: number } = {}): {
  redacted: boolean;
  text: string;
};

export function piTelemetryIdempotencyKey(event: WorkerTelemetryEvent): string;

export function normalizePiToolTelemetry(input: {
  artifactRefs?: string[];
  durationMs?: number;
  inputPreview?: unknown;
  isError: boolean;
  occurredAt?: string;
  output?: unknown;
  runtime?: string;
  sessionRef: AgentSessionRef | null;
  toolCallId: string;
  toolName: string;
  turnId: string;
  workerKey?: string | null;
}): WorkerToolTelemetryEvent;

export function normalizePiMessageFinalTelemetry(input: {
  evidenceRefs?: string[];
  occurredAt?: string;
  runtime?: string;
  sessionRef: AgentSessionRef | null;
  stopReason: string;
  text: unknown;
  turnId: string;
  workerKey?: string | null;
}): WorkerMessageFinalTelemetryEvent;
```

- [x] **Step 4: Run tests**

Run: `pnpm test test/unit/pi-telemetry.test.ts`

Expected: all tests pass.

- [x] **Step 5: Commit**

```bash
git add src/observability/pi-telemetry.ts test/unit/pi-telemetry.test.ts
git commit -m "feat(observability): normalize Pi telemetry"
```

### Task 7: Implement Worker State Rules

**Objective:** Deterministically convert Herdr state, telemetry, and transcript hints into snapshots and enriched worker events.

**Files:**
- Create: `src/observability/rules.ts`
- Test: `test/unit/worker-state-rules.test.ts`

**Interfaces:**
- Consumes: Herdr AgentInfo-like records, transcript backfill, telemetry events.
- Produces: `WorkerSnapshot` and `WorkerEventType` decisions.

- [x] **Step 1: Write failing tests**

Test cases:

1. Herdr status `blocked` with `custom_status` emits `worker.blocked` with high confidence.
2. Pi final text containing `Blocked:` emits `worker.blocked` with medium confidence when Herdr status is idle/done.
3. Tool telemetry with `isError: true` emits `worker.tool.failed`.
4. Final text containing `completed` and Herdr status `idle` or `done` emits `worker.completed` with medium confidence.
5. Final text asking for confirmation emits `worker.needs_input`.
6. Status changes emit `worker.status.changed` only when status changed from previous snapshot.
7. Evidence array contains at most five entries and each excerpt is bounded.

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm test test/unit/worker-state-rules.test.ts`

Expected: module missing.

- [x] **Step 3: Implement rule engine**

Export:

```ts
export type WorkerRuleInput = {
  agentInfo?: unknown;
  previousSnapshot?: WorkerSnapshot;
  telemetry?: WorkerTelemetryEvent;
  transcript?: TranscriptBackfill;
  worker: { agentName: string | null; id: string; observedWorkspaceId: string; sessionRef: AgentSessionRef | null };
};

export type WorkerRuleOutput = {
  events: Array<{ idempotencyKey: string; payload: unknown; type: WorkerEventType }>;
  snapshot: WorkerSnapshot;
};

export function evaluateWorkerState(input: WorkerRuleInput): WorkerRuleOutput;
```

Rules must be deterministic and must not call an LLM.

- [x] **Step 4: Run tests**

Run: `pnpm test test/unit/worker-state-rules.test.ts`

Expected: all rule tests pass.

- [x] **Step 5: Commit**

```bash
git add src/observability/rules.ts test/unit/worker-state-rules.test.ts
git commit -m "feat(observability): add worker state rules"
```

### Task 8: Implement WorkerStatePipeline

**Objective:** Merge Herdr events, runtime telemetry, and transcript backfill into persisted snapshots and enriched events.

**Files:**
- Create: `src/observability/worker-state-pipeline.ts`
- Test: `test/integration/worker-state-pipeline.test.ts`

**Interfaces:**
- Consumes: stores, Herdr client, resolver, transcript adapters, rules.
- Produces: update methods used by daemon RPC and Herdr subscriptions.

- [x] **Step 1: Write failing tests**

Test end-to-end scenarios:

1. `refreshWorkspace()` reads `session.snapshot`, discovers two agents in workspace, creates two workers, and stores two snapshots.
2. `handleHerdrEvent(pane.agent_status_changed)` updates matching worker status and appends `worker.status.changed`.
3. `handleTelemetry(worker.tool.completed isError=true)` links by agent session and appends `worker.tool.failed`.
4. `handleTelemetry(worker.message.final completionHint)` appends `worker.completed` and updates snapshot completion.
5. Pipeline dedupes repeated telemetry by idempotency key.
6. Pipeline marks workspace `missing` when snapshot cannot resolve it.

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm test test/integration/worker-state-pipeline.test.ts`

Expected: module missing.

- [x] **Step 3: Implement pipeline class**

Constructor dependencies:

```ts
import type { HerdrControlClientWithSnapshot, ObservedWorkspaceRecord } from "./contracts.js";

export class WorkerStatePipeline {
  constructor(options: {
    herdrClientForWorkspace(input: ObservedWorkspaceRecord): HerdrControlClientWithSnapshot;
    observedWorkspaces: ObservedWorkspaceStore;
    snapshots: WorkerSnapshotStore;
    transcriptAdapters: TranscriptAdapter[];
    workerEvents: WorkerEventStore;
    workers: WorkerStore;
  });

  refreshWorkspace(observedWorkspaceId: string): Promise<WorkerSnapshot[]>;
  handleHerdrEvent(input: { event: unknown; observedWorkspaceId: string }): Promise<void>;
  handleTelemetry(input: { event: WorkerTelemetryEvent; observedWorkspaceId?: string }): Promise<void>;
}
```

`handleTelemetry()` must resolve target worker by:

1. `event.workerKey` if present
2. `event.sessionRef` converted to worker identity key
3. no-op with a `worker.summary.updated` event only if no worker exists is forbidden; instead append no event and return

- [x] **Step 4: Run tests**

Run: `pnpm test test/integration/worker-state-pipeline.test.ts`

Expected: all pipeline tests pass.

- [x] **Step 5: Commit**

```bash
git add src/observability/worker-state-pipeline.ts test/integration/worker-state-pipeline.test.ts
git commit -m "feat(observability): build worker state pipeline"
```

