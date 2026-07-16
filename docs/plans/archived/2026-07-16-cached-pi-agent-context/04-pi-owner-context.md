# Owner-Only Pi Local Context, Ephemeral Injection, Run Pinning, and Wake Separation Plan

> **For implementers:** Execute this plan task-by-task. Complete each checkbox step, run the listed validation, and commit after each task.

**Status:** Completed

**Goal:** Replace prompt-time daemon pulls with an owner-only local context mirror that Pi injects synchronously and ephemerally, while preserving independent auto-wake and acknowledgement behavior.

**Architecture:** The reconnecting daemon client receives context in owner connection-state responses and `agent.context.changed` streams. The extension clears context on role/scope loss, pins the latest local snapshot once at agent-run start, and uses Pi's `context` hook to filter legacy persisted Shepherd context and append one ephemeral current message. Normal user runs never consume pending outcomes; Shepherd-triggered wake runs use only their existing wake context.

**Tech Stack:** TypeScript Pi extension, Pi >= 0.80.6 event API, Node Unix-socket JSON Lines client, Vitest fake client/fake timers.

## Global Constraints

- Inherit every constraint from the parent plan and children 01–03.
- The extension sends no daemon request from `before_agent_start`, `agent_start`, or `context`.
- Remove the `before_agent_start` handler entirely after pending-update delivery and `agent.list` pull are removed.
- Keep the existing socket connection and presence registration for owner transitions/reconnects.
- Only an owner may store/use `latestContext`. Any non-owner response, role loss, disconnect, shutdown, or scope change clears latest and pinned context.
- Ignore context streams whose `(herdrSessionName, workspaceId)` do not match current scope or when this Pi is not owner.
- `agent_start` pins at most once until `agent_settled`; repeated low-level starts/retries do not replace the pin.
- The `context` hook is synchronous and performs only in-memory filtering/formatting.
- Legacy persisted messages with `customType === "shepherd-agent-context"` or marker `[SHEPHERD AGENT CONTEXT]` are removed from provider context before appending the current ephemeral message.
- Do not filter `shepherd-wake-context`, visible `shepherd-wake`, or prior assistant wake responses.
- If the pinned snapshot is absent, return only the legacy-filtered messages.
- If a delivered batch is Shepherd-triggered, do not pin normal context for that run.
- Pending outcomes arriving before/during a normal run stay pending. Busy deferral starts one independent wake after normal `agent_settled`.
- Keep wake settle, outcome projection, failure suppression, owner replacement, self-event filtering, ack-after-successful-settle, and visible renderer behavior unchanged.
- The normal context formatter remains bounded and keeps the existing marker/fields. It now receives daemon-cached agents and is not itself responsible for freshness.

## Current Context

- `ReconnectingDaemonClient` handles `agent.event` and `agent.orchestrator.changed` stream methods only.
- `packages/shepherd-pi/src/index.ts` stores connection/role/pending/wake state in one extension-local object.
- `applyConnectionStateResponse()` is the central owner/non-owner transition path used by register/get/set/reconnect.
- `before_agent_start` currently refreshes owner state, calls `agent.list`, creates a delivered batch for a normal user turn, formats normal/update context, and cancels a scheduled wake.
- `agent_settled` owns wake acknowledgement and later-wake scheduling.
- `createFakePi()` currently stores one handler per event and does not model provider context; it can be extended without a separate test harness.
- Pi's `context` event receives cloned `AgentMessage[]` and returns `{ messages }`; returned-only messages are not appended to the session.

## File Structure

- Modify: `packages/shepherd-pi/src/daemon-client.ts` — context snapshot types and stream union.
- Modify: `test/integration/shepherd-pi-daemon-client.test.ts` — decode `agent.context.changed` alongside existing streams.
- Modify: `packages/shepherd-pi/src/index.ts` — registration session ref, local/pinned context state, owner gating, context hook, removal of prompt pull, wake separation.
- Modify: `test/unit/shepherd-pi-extension.test.ts` — fake context event support, owner/off behavior, pinning, cache miss, scope/reconnect clearing, wake separation, zero prompt RPC.
- Modify: `test/unit/shepherd-pi-agent-update-ui.test.ts` only if message detail types move; visual card behavior must not change.

## Interfaces

Add to `packages/shepherd-pi/src/daemon-client.ts`:

```ts
export type AgentContextListItem = {
  agent?: string | null;
  agentStatus?: string;
  history?: CompactAgentHistory;
  paneId?: string;
  terminalId?: string | null;
};

export type AgentWorkspaceContextSnapshot = {
  agents: AgentContextListItem[];
  herdrSessionName: string;
  updatedAt: string;
  workspaceId: string;
};
```

Extend `DaemonStreamMessage`:

```ts
| {
    method: "agent.context.changed";
    params: {
      context: AgentWorkspaceContextSnapshot | null;
      herdrSessionName: string;
      workspaceId: string;
    };
  }
```

Extend the extension's connection response type:

```ts
type ConnectionStateResponse = {
  context: AgentWorkspaceContextSnapshot | null;
  events: AgentEventWireRecord[];
  presence: PiPresence;
  state: AgentOrchestratorWireState | null;
  changed?: boolean;
};
```

Add a local structural message type so the plan does not depend on an unexported Pi core type:

```ts
type PiAgentMessage = {
  content?: unknown;
  customType?: string;
  role?: string;
  [key: string]: unknown;
};
```

Add extension state:

```ts
latestContext: AgentWorkspaceContextSnapshot | undefined;
pinnedContext: AgentWorkspaceContextSnapshot | undefined;
runActive: boolean;
```

## Tasks

### Task 1: Receive Owner Context and Register Exact Pi Session Identity

**Objective:** Keep the latest daemon snapshot only while this Pi owns the current scope and restore it through claim/reconnect/movement responses.

**Files:**
- Modify: `packages/shepherd-pi/src/daemon-client.ts`
- Modify: `test/integration/shepherd-pi-daemon-client.test.ts`
- Modify: `packages/shepherd-pi/src/index.ts`
- Modify: `test/unit/shepherd-pi-extension.test.ts`

**Interfaces:**
- Consumes: child 03 response/stream protocol.
- Produces: `state.latestContext` and strict presence session ref.

- [x] **Step 1: Write failing daemon-client stream test**

In the fake JSONL server, write:

```ts
socket.write(
  `${JSON.stringify({
    method: "agent.context.changed",
    params: {
      context: {
        agents: [],
        herdrSessionName: "default",
        updatedAt: "2026-07-16T00:00:00.000Z",
        workspaceId: "wB",
      },
      herdrSessionName: "default",
      workspaceId: "wB",
    },
  })}\n`,
);
```

Assert `onStreamMessage` receives it as the typed third stream method without disconnecting.

- [x] **Step 2: Write failing extension owner-state tests**

Extend `connectionResponse()` with `context?: AgentWorkspaceContextSnapshot | null`. Add tests proving:

1. Registration sends:

```ts
{
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
}
```

2. Owner registration stores returned context.
3. Non-owner registration ignores/clears context even if a malformed fake response includes one.
4. Matching non-null `agent.context.changed` replaces owner latest context.
5. Matching `context: null` clears owner latest context; an already pinned active run remains stable until settle, and the next run injects nothing.
6. Off Pi ignores stream context.
7. `/shepherd on` stores context from set response; `/shepherd off` clears it immediately.
8. Owner replacement/disconnect/scope move/session shutdown clear latest and pinned context.
9. Reconnect registration restores current owner context.

Expose latest context only through context-hook behavior in tests; do not add a production debug getter.

- [x] **Step 3: Run client/extension tests to verify red**

Run: `pnpm test test/integration/shepherd-pi-daemon-client.test.ts test/unit/shepherd-pi-extension.test.ts`

Expected: context stream is ignored and registration lacks `sessionRef`.

- [x] **Step 4: Implement wire decoding and owner-local state transitions**

Update the daemon client's stream-method condition to include `agent.context.changed`. In `registerPresence()`, send `state.sessionRef` and fail registration if session start did not provide a file path.

Add helpers:

```ts
const clearAgentContext = () => {
  state.latestContext = undefined;
  state.pinnedContext = undefined;
  state.runActive = false;
};

const applyOwnerContext = (response: ConnectionStateResponse) => {
  state.latestContext = isLocalOwner(response) ? response.context ?? undefined : undefined;
};
```

Call `clearAgentContext()` from role loss, scope reset, disconnect, and shutdown. Apply response context only after scope/owner resolution. Handle context streams only when owner and the explicit `herdrSessionName/workspaceId` params match current scope. Replace `latestContext` for non-null payloads and clear only `latestContext` for a matching null payload. Role/scope loss still clears both latest and pinned state.

- [x] **Step 5: Run tests to verify green**

Run: `pnpm test test/integration/shepherd-pi-daemon-client.test.ts test/unit/shepherd-pi-extension.test.ts`

Expected: stream, registration, owner gating, and clearing tests pass.

- [x] **Step 6: Commit**

```bash
git add packages/shepherd-pi/src/daemon-client.ts packages/shepherd-pi/src/index.ts test/integration/shepherd-pi-daemon-client.test.ts test/unit/shepherd-pi-extension.test.ts
git commit -m "feat(pi): mirror owner agent context from daemon"
```

### Task 2: Inject One Ephemeral, Run-Pinned Context

**Objective:** Give normal owner runs a stable cached snapshot without persistent duplicate messages or prompt-time I/O.

**Files:**
- Modify: `packages/shepherd-pi/src/index.ts`
- Modify: `test/unit/shepherd-pi-extension.test.ts`

**Interfaces:**
- Consumes: Task 1 `latestContext`.
- Produces: synchronous `agent_start` pin and `context` transformation.

- [x] **Step 1: Extend the fake Pi context harness**

Add a helper that chains handler output for `context` events:

```ts
async emitContext(messages: unknown[], ctx: ReturnType<typeof fakeCtx>) {
  return (
    (await handlers.get("context")?.({ messages, type: "context" }, ctx)) as
      | { messages?: unknown[] }
      | undefined
  )?.messages ?? messages;
}
```

Keep the generic `emit()` helper for lifecycle events.

- [x] **Step 2: Write failing cache-miss/filter/injection tests**

Cover:

1. Off Pi returns messages unchanged except removal of legacy Shepherd context.
2. Owner with `context: null` injects nothing and makes zero client calls.
3. Owner with a snapshot receives one final custom message with:

```ts
{
  role: "custom",
  customType: "shepherd-agent-context",
  content: expect.stringContaining("[SHEPHERD AGENT CONTEXT]"),
  display: false,
  timestamp: expect.any(Number),
}
```

4. Existing messages with `customType: "shepherd-agent-context"` are removed.
5. Legacy user/custom content containing `[SHEPHERD AGENT CONTEXT]` is removed defensively.
6. `shepherd-wake-context` and unrelated custom messages remain.
7. A snapshot stream update after `agent_start` does not change the pinned context on later context calls in the same run.
8. A repeated `agent_start` before `agent_settled` does not repin.
9. After `agent_settled`, the next `agent_start` pins the newer snapshot.
10. Context with only the owner absent/empty injects nothing.
11. The context hook invocation adds no entry to `pi.customMessages`, `pi.hiddenMessages`, or extension entries.
12. `client.calls` before/after `agent_start` plus two context calls are identical.

- [x] **Step 3: Run extension tests to verify red**

Run: `pnpm test test/unit/shepherd-pi-extension.test.ts`

Expected: no context hook/pinning behavior exists.

- [x] **Step 4: Implement run pinning**

Register:

```ts
pi.on("agent_start", () => {
  if (state.runActive) return;
  state.runActive = true;
  state.pinnedContext =
    state.isOrchestrator && !state.deliveredBatch?.shepherdTriggered
      ? state.latestContext
      : undefined;
});
```

At the beginning of `agent_settled`, clear `runActive` and `pinnedContext` while retaining all existing batch/ack logic.

- [x] **Step 5: Implement the synchronous context transformer**

Use a non-async handler:

```ts
pi.on("context", (event: { messages: PiAgentMessage[] }) => {
  const messages = event.messages.filter((message) => !isNormalShepherdContext(message));
  const snapshot = state.pinnedContext;
  if (!snapshot || snapshot.agents.length === 0) return { messages };
  return {
    messages: [
      ...messages,
      {
        role: "custom",
        customType: "shepherd-agent-context",
        content: formatHiddenAgentContext({
          agents: snapshot.agents,
          workspaceId: snapshot.workspaceId,
        }),
        display: false,
        timestamp: Date.now(),
      },
    ],
  };
});
```

`isNormalShepherdContext()` matches `customType` first and the stable marker as a fallback across string/block content. It must not match `shepherd-wake-context` merely because both start with “SHEPHERD”.

- [x] **Step 6: Remove prompt-time pull and persistent normal context**

Delete the entire `before_agent_start` handler, including:

- `agent.orchestrator.get`
- `agent.list`
- normal-turn delivered-batch creation
- normal-turn pending outcome formatting
- timer cancellation caused by normal prompt start
- returned persistent `shepherd-agent-context` message

Keep `formatHiddenAgentContext()` because the `context` hook now uses it.

- [x] **Step 7: Run extension tests to verify green**

Run: `pnpm test test/unit/shepherd-pi-extension.test.ts`

Expected: local ephemeral context, pinning, legacy filtering, and zero-RPC assertions pass.

- [x] **Step 8: Commit**

```bash
git add packages/shepherd-pi/src/index.ts test/unit/shepherd-pi-extension.test.ts
git commit -m "perf(pi): inject cached context without prompt RPC"
```

### Task 3: Keep Pending Updates Out of Normal User Runs

**Objective:** Replace “normal turn consumes pending updates” with independent post-settle wake behavior.

**Files:**
- Modify: `packages/shepherd-pi/src/index.ts` only if wake scheduling needs a small adjustment
- Modify: `test/unit/shepherd-pi-extension.test.ts`

**Interfaces:**
- Consumes: existing `scheduleWake()`, `wakeDeferredUntilSettled`, and `agent_settled` behavior.
- Produces: deterministic user-run/wake separation.

- [x] **Step 1: Replace the obsolete normal-turn test**

Delete `lets a normal user turn consume pending updates before the timer fires` and add a fake-timer test with this sequence:

```ts
client.emitStream({ method: "agent.event", params: { event: event(101, "term_agent") } });
await vi.advanceTimersByTimeAsync(250);
ctx.setIdle(false);
await pi.emit("agent_start", {}, ctx);
const normalContext = await pi.emitContext([], ctx);
await vi.advanceTimersByTimeAsync(250);
```

Assert at 500 ms:

- no wake custom message was sent;
- normal context contains `[SHEPHERD AGENT CONTEXT]` if a cached snapshot exists;
- normal context does **not** contain `[SHEPHERD AGENT UPDATES]`;
- no ack was sent.

Then finish the normal run:

```ts
await pi.emit("message_end", assistantMessage("stop"), ctx);
ctx.setIdle(true);
await pi.emit("agent_settled", {}, ctx);
await vi.advanceTimersByTimeAsync(500);
```

Assert one independent wake appears. Simulate its `agent_start`, verify provider context contains the persisted `shepherd-wake-context` but no normal `[SHEPHERD AGENT CONTEXT]`, finish with successful assistant/settled events, and only then expect `agent.notifications.ack` for event 101.

- [x] **Step 2: Update wake tests that manually emitted `before_agent_start`**

Replace manual `before_agent_start` calls in delivered-wake tests with `agent_start` only where run-pinning behavior is under test. A delivered batch is already created by `scheduleWake()` before `sendMessage`; tests must not depend on a removed prompt hook to mark delivery.

Keep coverage for:

- later events during a delivered batch;
- failed/aborted final responses;
- partial/full ack failure;
- sent-but-not-started reconnect;
- replacement owner wake;
- role loss aborting only Shepherd-triggered work.

- [x] **Step 3: Run the focused wake suite to verify red/green**

Run before any implementation adjustment: `pnpm test test/unit/shepherd-pi-extension.test.ts`

Expected red condition: normal-turn timer behavior may schedule too early in the fake harness or tests still reference `before_agent_start`.

If production adjustment is required, limit it to checking `ctx.isIdle()`/`wakeDeferredUntilSettled`; do not reintroduce normal-turn event delivery. Run the same command again.

Expected green condition: pending outcomes wake independently after normal settle and ack only after wake settle.

- [x] **Step 4: Commit**

```bash
git add packages/shepherd-pi/src/index.ts test/unit/shepherd-pi-extension.test.ts
git commit -m "fix(pi): defer pending updates past normal user runs"
```

### Task 4: Verify Owner/Scope/Reconnect Context Lifecycle

**Objective:** Prove cached context follows the same stable terminal ownership lifecycle as wake routing.

**Files:**
- Modify: `test/unit/shepherd-pi-extension.test.ts`
- Modify: `test/integration/shepherd-pi-daemon-client.test.ts` only if an additional reconnect stream assertion is needed

**Interfaces:**
- Consumes: completed owner mirror and context hook.
- Produces: regression coverage for current ownership guarantees.

- [x] **Step 1: Add lifecycle regression cases**

Prove:

1. Non-owner/off Pi receives no normal context even when another owner exists in the same workspace.
2. Claiming with `/shepherd on` makes context available on the next run without restart.
3. Direct replacement clears the previous owner's local/pinned context before its next provider context call.
4. `/shepherd off` clears context but keeps the socket usable for a later `/shepherd on`.
5. Same-terminal `/reload`/new extension instance restores owner context from registration.
6. Cross-workspace move clears the old snapshot, injects nothing during the gap, then uses destination snapshot after `agent.orchestrator.get` response.
7. Disconnect clears context and shows reconnecting UI; reconnect restores context only if the daemon still reports this terminal as owner.
8. Shutdown clears context/status and sends no late wake/context messages.
9. Another Pi in the owner workspace remains in context; the owner terminal is absent.

- [x] **Step 2: Run owner lifecycle tests**

Run: `pnpm test test/unit/shepherd-pi-extension.test.ts test/integration/shepherd-pi-daemon-client.test.ts`

Expected: all owner/context/wake/reconnect tests pass.

- [x] **Step 3: Run Pi package type/package checks**

Run: `pnpm --dir packages/shepherd-pi typecheck && pnpm pi-package:check`

Expected: extension types compile and npm dry-run includes only declared source/package files.

- [x] **Step 4: Commit**

```bash
git add test/unit/shepherd-pi-extension.test.ts test/integration/shepherd-pi-daemon-client.test.ts
git commit -m "test(pi): cover cached context ownership lifecycle"
```

## Progress

- [x] Presence/context stream mirror completed
- [x] Ephemeral run-pinned context completed
- [x] Pending-wake separation and lifecycle regressions completed

## Next Steps

No implementation work remains.

## Completion Evidence

- Exact presence identity, owner mirror, synchronous ephemeral context, run pinning, scope clearing, and wake separation shipped in `8e6f228`.
- Pi client/extension/UI/wake suites, Pi typecheck, and package dry-run passed.

## Validation

- `pnpm test test/integration/shepherd-pi-daemon-client.test.ts` — context stream and reconnect decoding pass.
- `pnpm test test/unit/shepherd-pi-extension.test.ts` — owner mirror, ephemeral injection, pinning, cache miss, wake separation, and lifecycle pass.
- `pnpm test test/unit/shepherd-pi-agent-update-ui.test.ts test/unit/shepherd-pi-wake.test.ts` — visual outcome projection is unchanged.
- `pnpm --dir packages/shepherd-pi typecheck` — final extension event/wire types compile.
- `pnpm pi-package:check` — package contents remain valid.

## Risks, Tradeoffs, and Open Questions

- **Pi event granularity:** repeated low-level `agent_start` events can occur during retries. `runActive` prevents repinning until `agent_settled`.
- **Asynchronous cache updates:** stream updates during a run replace only `latestContext`; `pinnedContext` remains immutable until settle.
- **Legacy session history:** the context hook strips previously persisted normal Shepherd context so upgrading does not duplicate stale snapshots. Wake history remains intentionally visible to later turns.
- **Cache gaps:** owner claim/move/reconnect can briefly have no snapshot. The context hook injects nothing rather than waiting.
- **Normal-turn pending events:** separating wake can produce a visible follow-up after the user's run. This is the accepted `/dig` decision and preserves prompt responsiveness/scope separation.
- **No unresolved questions remain in this child.**
