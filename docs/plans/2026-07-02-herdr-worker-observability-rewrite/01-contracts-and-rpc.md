# Contracts and RPC Schemas

Parent: [2026-07-02-herdr-worker-observability-rewrite.md](../2026-07-02-herdr-worker-observability-rewrite.md)

## Status

Done.

## Progress

- Done — Task 1 implemented `src/observability/contracts.ts`, `src/observability/schemas.ts`, and `test/unit/observability-contracts.test.ts`; focused test passes.

## Next steps

- Continue with [02-persistence.md](02-persistence.md).

## Objective

Define the worker-observability contracts and RPC schemas.

## Scope

Task 1.

## Core Interfaces

### `src/observability/contracts.ts`

Create the file with these exported types. Implementation tasks may extend metadata fields, but must keep these names stable.

```ts
export type ObservedWorkspaceStatus = "active" | "ambiguous" | "missing";
export type WorkerStatus = "blocked" | "done" | "idle" | "unknown" | "working";
export type WorkerEventType =
  | "worker.blocked"
  | "worker.completed"
  | "worker.needs_input"
  | "worker.status.changed"
  | "worker.summary.updated"
  | "worker.tool.failed";

export type AgentSessionRef = {
  agent: string;
  kind: "id" | "path";
  source: string;
  value: string;
};

export type WorkerIdentity =
  | { key: string; kind: "agent_session"; session: AgentSessionRef }
  | {
      fallback: {
        herdrSessionName?: string;
        paneId: string;
        socketPath?: string;
        workspaceId: string;
      };
      key: string;
      kind: "live_pane";
    };

export type ObservedWorkspaceRecord = {
  createdAt: Date;
  herdrSessionName: string | null;
  id: string;
  lastResolvedAt: Date | null;
  liveWorkspaceId: string | null;
  metadata: ObservedWorkspaceMetadata;
  socketPath: string | null;
  status: ObservedWorkspaceStatus;
  updatedAt: Date;
};

export type ObservedWorkspaceMetadata = {
  label?: string;
  workspaceCwd?: string;
  worktree?: {
    checkoutPath: string;
    isLinkedWorktree: boolean;
    repoKey: string;
    repoName: string;
    repoRoot: string;
  };
};

export type WorkerEvidence = {
  excerpt?: string;
  ref?: string;
  source: "herdr" | "pi" | "transcript" | "rule";
  timestamp?: string;
};

export type WorkerSnapshot = {
  agent: string | null;
  blockedReason: string | null;
  completion: string | null;
  confidence: "high" | "low" | "medium";
  currentWork: string | null;
  evidence: WorkerEvidence[];
  id: string;
  lastActivityAt: string | null;
  lastMessageExcerpt: string | null;
  lastTool: WorkerToolSummary | null;
  needsInput: boolean;
  observedWorkspaceId: string;
  pane: { paneId: string; tabId: string | null; workspaceId: string | null } | null;
  recommendedAction: string | null;
  sessionRef: AgentSessionRef | null;
  status: WorkerStatus;
  summary: string | null;
};

export type WorkerToolSummary = {
  durationMs?: number;
  errorExcerpt?: string;
  inputPreview?: string;
  isError: boolean;
  name: string;
  outputExcerpt?: string;
  toolCallId: string;
};

export type WorkerTelemetryEvent =
  | WorkerToolTelemetryEvent
  | WorkerMessageFinalTelemetryEvent
  | WorkerLifecycleTelemetryEvent;

export type WorkerToolTelemetryEvent = {
  artifactRefs: string[];
  durationMs?: number;
  errorExcerpt?: string;
  inputPreview?: string;
  isError: boolean;
  occurredAt: string;
  outputExcerpt?: string;
  redactionApplied: boolean;
  runtime: "pi" | string;
  sessionRef: AgentSessionRef | null;
  toolCallId: string;
  toolName: string;
  turnId: string;
  type: "worker.tool.completed";
  workerKey: string | null;
};

export type WorkerMessageFinalTelemetryEvent = {
  blockedHint?: string;
  completionHint?: string;
  evidenceRefs: string[];
  needsInputHint?: string;
  occurredAt: string;
  redactionApplied: boolean;
  runtime: "pi" | string;
  sessionRef: AgentSessionRef | null;
  stopReason: "aborted" | "error" | "length" | "stop" | "toolUse" | string;
  textExcerpt: string;
  turnId: string;
  type: "worker.message.final";
  workerKey: string | null;
};

export type WorkerLifecycleTelemetryEvent = {
  occurredAt: string;
  runtime: "pi" | string;
  sessionRef: AgentSessionRef | null;
  status: WorkerStatus;
  type: "worker.lifecycle";
  workerKey: string | null;
};

export type WorkerEventWireRecord = {
  createdAt: string;
  id: number;
  observedWorkspaceId: string;
  payload: unknown;
  type: WorkerEventType;
  workerId: string | null;
};

export type HerdrControlClientWithSnapshot = {
  agentRead(params: { lines?: number; source?: "detection" | "recent" | "recent-unwrapped" | "visible"; target: string }): Promise<unknown>;
  agentSend(params: { target: string; text: string }): Promise<unknown>;
  agentStart(params: { argv: string[]; cwd?: string; env?: Record<string, string>; name: string; tab_id?: string; workspace_id?: string }): Promise<unknown>;
  close(): void;
  listAgents(): Promise<unknown>;
  sessionSnapshot(): Promise<unknown>;
  subscribeEvents(params: { paneIds: string[]; workspaceId: string }, options?: { signal?: AbortSignal }): AsyncIterable<unknown>;
};
```

### Public RPC methods

The daemon JSONL RPC uses these method names:

```text
workspace.observe
workspace.snapshot
worker.events
worker.message
worker.wait_state
worker.start
notification.subscribe
notification.ack
runtime.telemetry
```

`worker.start` is semantic, not a general Herdr proxy. It starts an agent and immediately observes it as a worker. Low-level `pane.split`, `pane.read`, `tab.create`, and raw Herdr resource reads are not exposed as Shepherd public API in the MVP.

### CLI commands

Replace old session commands with:

```text
shepherd daemon [start|stop|restart|status]
shepherd observe --herdr-session <name> --workspace <workspace-id> [--json]
shepherd observe-current [--json]
shepherd snapshot <observed-workspace-id> [--json]
shepherd events <observed-workspace-id> [--after EVENT_ID] [--json]
shepherd notifications <observed-workspace-id> --subscriber <id> [--auto-resume] [--json]
shepherd ack --subscription <id> --event <event-id> [--json]
shepherd message-worker <worker-id> <text>
shepherd wait-worker <worker-id> --state <blocked|done|idle|unknown|working> [--timeout-ms N]
```

The command `shepherd observe-current` requires `HERDR_ENV=1`, `HERDR_SOCKET_PATH`, and `HERDR_WORKSPACE_ID`; otherwise it exits with code `2` and prints `observe-current requires a Herdr-managed pane`.

## Tasks

### Task 1: Define Observability Contracts and RPC Schemas

**Objective:** Introduce runtime-neutral types and schema validation without changing runtime behavior.

**Files:**
- Create: `src/observability/contracts.ts`
- Create: `src/observability/schemas.ts`
- Test: `test/unit/observability-contracts.test.ts`

**Interfaces:**
- Consumes: no new code.
- Produces: shared types and TypeBox schemas used by DB stores, pipeline, RPC server, CLI, and Pi extension.

- [x] **Step 1: Write the failing tests**

Create `test/unit/observability-contracts.test.ts` with tests for:

1. `workerIdentityKey()` returns `session:herdr:pi:pi:path:/tmp/session.jsonl` for an agent session.
2. `workerIdentityKey()` returns `pane:herdr-main:w1:w1:p1` for fallback live pane identity.
3. `observeWorkspaceInputSchema` accepts `{ herdrSessionName: "main", workspaceId: "w1" }`.
4. `observeWorkspaceInputSchema` rejects input without both a Herdr selector and workspace selector.
5. `runtimeTelemetryInputSchema` accepts `worker.tool.completed` payload with bounded excerpts.

Use this test skeleton:

```ts
import { Value } from "@sinclair/typebox/value";
import { describe, expect, test } from "vitest";
import { workerIdentityKey } from "@/observability/contracts.js";
import { observeWorkspaceInputSchema, runtimeTelemetryInputSchema } from "@/observability/schemas.js";

describe("observability contracts", () => {
  test("builds stable worker keys", () => {
    expect(
      workerIdentityKey({
        kind: "agent_session",
        session: { source: "herdr:pi", agent: "pi", kind: "path", value: "/tmp/session.jsonl" },
      }),
    ).toBe("session:herdr:pi:pi:path:/tmp/session.jsonl");

    expect(
      workerIdentityKey({
        kind: "live_pane",
        fallback: { herdrSessionName: "herdr-main", workspaceId: "w1", paneId: "w1:p1" },
      }),
    ).toBe("pane:herdr-main:w1:w1:p1");
  });

  test("validates observe workspace input", () => {
    expect(Value.Check(observeWorkspaceInputSchema, { herdrSessionName: "main", workspaceId: "w1" })).toBe(true);
    expect(Value.Check(observeWorkspaceInputSchema, { workspaceId: "w1" })).toBe(false);
  });

  test("validates runtime telemetry input", () => {
    expect(
      Value.Check(runtimeTelemetryInputSchema, {
        event: {
          artifactRefs: ["pi-session:/tmp/session.jsonl#entry=a1b2c3d4"],
          isError: false,
          occurredAt: "2026-07-02T00:00:00.000Z",
          redactionApplied: true,
          runtime: "pi",
          sessionRef: { source: "herdr:pi", agent: "pi", kind: "path", value: "/tmp/session.jsonl" },
          toolCallId: "tool-1",
          toolName: "bash",
          turnId: "turn-1",
          type: "worker.tool.completed",
          workerKey: null,
        },
      }),
    ).toBe(true);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm test test/unit/observability-contracts.test.ts`

Expected: TypeScript/Vitest fails because `@/observability/contracts.js` and `@/observability/schemas.js` do not exist.

- [x] **Step 3: Write minimal implementation**

Create `src/observability/contracts.ts` with the Core Interfaces types above and add:

```ts
export type WorkerIdentityInput =
  | { kind: "agent_session"; session: AgentSessionRef }
  | {
      fallback: {
        herdrSessionName?: string;
        paneId: string;
        socketPath?: string;
        workspaceId: string;
      };
      kind: "live_pane";
    };

export function workerIdentityKey(input: WorkerIdentityInput): string {
  if (input.kind === "agent_session") {
    const session = input.session;
    return `session:${session.source}:${session.agent}:${session.kind}:${session.value}`;
  }

  const scope = input.fallback.herdrSessionName ?? input.fallback.socketPath ?? "unknown-herdr";
  return `pane:${scope}:${input.fallback.workspaceId}:${input.fallback.paneId}`;
}
```

Create `src/observability/schemas.ts` with TypeBox schemas matching the public RPC methods:

```ts
import { Type } from "@sinclair/typebox";

const agentSessionRefSchema = Type.Object(
  {
    agent: Type.String({ minLength: 1 }),
    kind: Type.Union([Type.Literal("id"), Type.Literal("path")]),
    source: Type.String({ minLength: 1 }),
    value: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

const observeWorkspaceBySessionSchema = Type.Object(
  {
    herdrSessionName: Type.String({ minLength: 1 }),
    label: Type.Optional(Type.String({ minLength: 1 })),
    socketPath: Type.Optional(Type.String({ minLength: 1 })),
    workspaceId: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

const observeWorkspaceBySocketSchema = Type.Object(
  {
    herdrSessionName: Type.Optional(Type.String({ minLength: 1 })),
    label: Type.Optional(Type.String({ minLength: 1 })),
    socketPath: Type.String({ minLength: 1 }),
    workspaceId: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const observeWorkspaceInputSchema = Type.Union([
  observeWorkspaceBySessionSchema,
  observeWorkspaceBySocketSchema,
]);

const workerToolTelemetryEventSchema = Type.Object(
  {
    artifactRefs: Type.Array(Type.String()),
    durationMs: Type.Optional(Type.Integer({ minimum: 0 })),
    errorExcerpt: Type.Optional(Type.String({ maxLength: 4096 })),
    inputPreview: Type.Optional(Type.String({ maxLength: 4096 })),
    isError: Type.Boolean(),
    occurredAt: Type.String({ minLength: 1 }),
    outputExcerpt: Type.Optional(Type.String({ maxLength: 4096 })),
    redactionApplied: Type.Boolean(),
    runtime: Type.String({ minLength: 1 }),
    sessionRef: Type.Union([agentSessionRefSchema, Type.Null()]),
    toolCallId: Type.String({ minLength: 1 }),
    toolName: Type.String({ minLength: 1 }),
    turnId: Type.String({ minLength: 1 }),
    type: Type.Literal("worker.tool.completed"),
    workerKey: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  },
  { additionalProperties: false },
);

const workerMessageFinalTelemetryEventSchema = Type.Object(
  {
    blockedHint: Type.Optional(Type.String({ maxLength: 4096 })),
    completionHint: Type.Optional(Type.String({ maxLength: 4096 })),
    evidenceRefs: Type.Array(Type.String()),
    needsInputHint: Type.Optional(Type.String({ maxLength: 4096 })),
    occurredAt: Type.String({ minLength: 1 }),
    redactionApplied: Type.Boolean(),
    runtime: Type.String({ minLength: 1 }),
    sessionRef: Type.Union([agentSessionRefSchema, Type.Null()]),
    stopReason: Type.String({ minLength: 1 }),
    textExcerpt: Type.String({ maxLength: 4096 }),
    turnId: Type.String({ minLength: 1 }),
    type: Type.Literal("worker.message.final"),
    workerKey: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  },
  { additionalProperties: false },
);

const workerLifecycleTelemetryEventSchema = Type.Object(
  {
    occurredAt: Type.String({ minLength: 1 }),
    runtime: Type.String({ minLength: 1 }),
    sessionRef: Type.Union([agentSessionRefSchema, Type.Null()]),
    status: Type.Union([
      Type.Literal("blocked"),
      Type.Literal("done"),
      Type.Literal("idle"),
      Type.Literal("unknown"),
      Type.Literal("working"),
    ]),
    type: Type.Literal("worker.lifecycle"),
    workerKey: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  },
  { additionalProperties: false },
);

export const runtimeTelemetryInputSchema = Type.Object(
  {
    event: Type.Union([
      workerToolTelemetryEventSchema,
      workerMessageFinalTelemetryEventSchema,
      workerLifecycleTelemetryEventSchema,
    ]),
    observedWorkspaceId: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

export const workspaceSnapshotInputSchema = Type.Object(
  { observedWorkspaceId: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);

export const workerEventsInputSchema = Type.Object(
  {
    afterEventId: Type.Optional(Type.Integer({ minimum: 0 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
    observedWorkspaceId: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const workerMessageInputSchema = Type.Object(
  {
    text: Type.String({ minLength: 1 }),
    workerId: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const workerWaitStateInputSchema = Type.Object(
  {
    state: Type.Union([
      Type.Literal("blocked"),
      Type.Literal("done"),
      Type.Literal("idle"),
      Type.Literal("unknown"),
      Type.Literal("working"),
    ]),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
    workerId: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const workerStartInputSchema = Type.Object(
  {
    argv: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    cwd: Type.Optional(Type.String({ minLength: 1 })),
    env: Type.Optional(Type.Record(Type.String({ minLength: 1 }), Type.String())),
    name: Type.String({ minLength: 1 }),
    observedWorkspaceId: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const notificationSubscribeInputSchema = Type.Object(
  {
    autoResume: Type.Optional(Type.Boolean()),
    observedWorkspaceId: Type.String({ minLength: 1 }),
    subscriberId: Type.String({ minLength: 1 }),
    subscriberKind: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const notificationAckInputSchema = Type.Object(
  {
    eventId: Type.Integer({ minimum: 1 }),
    subscriptionId: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
```

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm test test/unit/observability-contracts.test.ts`

Expected: all tests in `observability-contracts.test.ts` pass.

- [ ] **Step 5: Commit**

```bash
git add src/observability/contracts.ts src/observability/schemas.ts test/unit/observability-contracts.test.ts
git commit -m "feat(observability): define worker contracts"
```
