# shepherd-pi Reconnecting Client, Orchestrator Commands, Notification Context, and UI Plan

> **For implementers:** Execute this plan task-by-task. Complete each checkbox step, run the listed validation, and commit after each task.

**Status:** Planned

**Goal:** Let users control and inspect the current Pi terminal's orchestrator role, survive daemon and Pi session replacement, and keep existing telemetry/hidden context behavior while consuming pushed updates only as owner.

**Architecture:** Extract a reconnecting JSONL daemon client from the extension entrypoint. On every connection, the extension registers current Pi subscriber metadata plus Herdr launch identity; the daemon returns authoritative terminal/scope/role and owner-only pending events. The `/shepherd orchestrator` command uses connection-bound RPC, role stream updates drive footer/transient UI, and every context/telemetry request uses daemon-refreshed in-memory scope rather than immutable launch environment after a pane move.

**Tech Stack:** TypeScript, Node `net`, Pi extension lifecycle/command/UI API, Vitest, temporary Unix socket servers.

## Global Constraints

- Inherit all parent constraints and final daemon RPC contracts.
- The extension activates orchestrator functionality only when `HERDR_ENV=1` and all of `HERDR_SOCKET_PATH`, `HERDR_WORKSPACE_ID`, and `HERDR_PANE_ID` are non-empty.
- The launch environment seeds the first registration, not permanent truth. After registration/get/change responses, overwrite in-memory `herdrSessionName`, `workspaceId`, `paneId`, and `terminalId` with daemon-authoritative presence; reconnects in the same extension instance send the latest in-memory pane/workspace so a moved terminal does not regress to stale env.
- Do not persist role state in Pi custom entries or project files. Re-register after every fresh `session_start`.
- A command must fail visibly when registration has not succeeded; it must not queue an unbound role mutation.
- Daemon connection/registration failures must not throw from Pi event handlers or block agent turns. Clear the owner footer, set a concise Shepherd connection status, and let the client reconnect.
- Footer key is `shepherd-orchestrator`; value is exactly `Shepherd: orchestrator` for owner and `undefined` otherwise.
- Existing unread key remains `shepherd`. Role UI must not overwrite it.
- Old owner notification text names the new pane when present. Do not notify every non-owner on unrelated claims.
- Bare `/shepherd` without `orchestrator` and unknown arguments report exact usage: `Usage: /shepherd orchestrator [on|off|status]`.
- `/shepherd orchestrator` is an alias of status.
- `autoResume` behavior remains controlled by `ExtensionOptions.autoResume`; no new user setting is added.

## Current Context

- `packages/shepherd-pi/src/index.ts` contains contracts, extension lifecycle, formatting helpers, event handling, and a non-reconnecting socket client in one file.
- `test/unit/shepherd-pi-extension.test.ts` uses `clientFactory` and a fake client; preserve this seam with the new client interface.
- Pi 0.80.3 command handlers receive `(args, ctx)` and use `ctx.ui.notify()`; session replacement tears down the old extension and starts a fresh instance.
- Pi package typecheck includes `packages/shepherd-pi/src/**/*.ts`; `npm pack` follows package manifest paths.

## File Structure

- Create: `packages/shepherd-pi/src/daemon-client.ts` — reconnecting JSONL transport and typed stream callbacks.
- Modify: `packages/shepherd-pi/src/index.ts` — registration, command, role/presence state, telemetry/context integration.
- Create: `test/integration/shepherd-pi-daemon-client.test.ts` — reconnect/backoff/request/stream behavior with real sockets.
- Modify: `test/unit/shepherd-pi-extension.test.ts` — registration, commands, role UI, session replacement, owner-only pending context.
- Modify: `packages/shepherd-pi/package.json` only if dry-run proves source inclusion needs an explicit manifest adjustment; otherwise leave it unchanged.

## Interfaces

Client interface exported from `daemon-client.ts`:

```ts
export type DaemonStreamMessage =
  | { method: "agent.event"; params: { event: AgentEventWireRecord } }
  | {
      method: "agent.orchestrator.changed";
      params: { change: AgentOrchestratorChanged };
    };

export type ReconnectingDaemonClientOptions = {
  reconnectDelaysMs?: readonly number[];
  socketPath: string;
};

export class ReconnectingDaemonClient {
  constructor(options: ReconnectingDaemonClientOptions);
  onConnected: (() => void | Promise<void>) | undefined;
  onDisconnected: ((error: Error) => void) | undefined;
  onStreamMessage: ((message: DaemonStreamMessage) => void) | undefined;
  close(): void;
  request(method: string, params: unknown): Promise<unknown>;
}
```

Default delays:

```ts
const DEFAULT_RECONNECT_DELAYS_MS = [100, 250, 500, 1_000] as const;
```

After the final entry, repeat 1,000ms until close. Only explicit `close()` stops reconnect.

Extension state must include:

```ts
type ShepherdState = {
  client: ShepherdDaemonClient | undefined;
  connected: boolean;
  currentScope: {
    herdrSessionName: string;
    paneId: string;
    terminalId: string;
    workspaceId: string;
  } | undefined;
  isOrchestrator: boolean;
  pendingEvents: AgentEventWireRecord[];
  registrationInFlight: Promise<void> | undefined;
  roleMutationInFlight: boolean;
  sessionRef: AgentSessionRef | undefined;
  subscriberId: string | undefined;
  toolStartTimes: Map<string, ToolStart>;
};
```

## Tasks

### Task 1: Extract and Test Reconnecting JSONL Client

**Objective:** Recover daemon connectivity automatically without coupling transport retries to Pi lifecycle code.

**Files:**
- Create: `packages/shepherd-pi/src/daemon-client.ts`
- Create: `test/integration/shepherd-pi-daemon-client.test.ts`
- Modify: `packages/shepherd-pi/src/index.ts` imports only enough to keep compilation after extraction.

**Interfaces:**
- Produces: `ReconnectingDaemonClient` API above.
- Consumes: newline-delimited JSON protocol.

- [ ] **Step 1: Write failing transport tests**

Use a temporary Unix socket path and real `net.createServer()` to test:

1. Client created before server exists retries and fires `onConnected` after server starts.
2. A request resolves its matching response by string/number id.
3. `agent.event` and `agent.orchestrator.changed` invoke `onStreamMessage` and do not consume pending request ids.
4. Server-side socket close rejects in-flight requests, fires `onDisconnected`, reconnects, and permits a later request.
5. Backoff sequence uses injected `[1, 2, 3]` delays then repeats 3ms; fake timers avoid sleeps.
6. Explicit `close()` cancels reconnect and rejects later request with `Shepherd daemon client is closed`.
7. Malformed JSON does not crash the process; it disconnects/retries with a parse error.
8. Multiple `error`/`close` emissions schedule only one reconnect attempt.

- [ ] **Step 2: Run test to verify red**

Run: `pnpm test test/integration/shepherd-pi-daemon-client.test.ts`

Expected: module/import failure because the client does not exist.

- [ ] **Step 3: Implement the transport state machine**

Implementation requirements:

- Keep socket state `idle | connecting | connected | closed`.
- Create a fresh decoder/buffer and socket per connection.
- Increment request ids monotonically across reconnects.
- Reject all in-flight requests exactly once on disconnect.
- Call `onConnected` after the socket `connect` event; catch rejected async callback and route it to `onDisconnected` without crashing.
- Parse stream methods before response ids.
- Guard all timer/socket callbacks with a connection generation number so stale callbacks cannot affect a newer socket.
- `close()` marks terminal state before destroying the socket.

- [ ] **Step 4: Run client tests and package typecheck**

Run: `pnpm test test/integration/shepherd-pi-daemon-client.test.ts && pnpm --dir packages/shepherd-pi typecheck`

Expected: all reconnect tests and package typecheck pass.

- [ ] **Step 5: Commit**

```bash
git add packages/shepherd-pi/src/daemon-client.ts packages/shepherd-pi/src/index.ts test/integration/shepherd-pi-daemon-client.test.ts
git commit -m "feat(pi): reconnect shepherd daemon client"
```

### Task 2: Register Authoritative Pi Presence on Every Connection

**Objective:** Rebind the same Herdr terminal after daemon restart and Pi session replacement.

**Files:**
- Modify: `packages/shepherd-pi/src/index.ts`
- Modify: `test/unit/shepherd-pi-extension.test.ts`

**Interfaces:**
- Consumes: `agent.orchestrator.register`.
- Produces: authoritative `currentScope`, `isOrchestrator`, and owner-only pending events.

- [ ] **Step 1: Replace old subscription expectations with failing registration tests**

Test `session_start` in a complete Herdr env:

```ts
expect(client.calls).toContainEqual([
  "agent.orchestrator.register",
  {
    autoResume: false,
    herdrSocketPath: "/tmp/herdr.sock",
    paneId: "wB:p1",
    subscriberId: "pi-session",
    subscriberKind: "pi",
    workspaceId: "wB",
  },
]);
```

Add cases:

- non-Herdr session creates no client/register call;
- missing socket/pane/workspace env disables registration and sets no footer;
- registration response updates scope from daemon, including a pane/workspace changed from env;
- owner response sets footer and accepts pending events;
- non-owner response clears footer and ignores an unexpected `events` array defensively;
- reconnect invokes register again with the current Pi subscriber id and latest authoritative in-memory pane/workspace;
- registration failure is caught, clears role status, and does not reject `session_start`;
- fresh extension instance with a different Pi session id but same Herdr pane registers normally and restores owner from daemon response.

Update test env helpers to include `HERDR_SOCKET_PATH` and `HERDR_PANE_ID` and restore them after each test.

- [ ] **Step 2: Run red test**

Run: `pnpm test test/unit/shepherd-pi-extension.test.ts`

Expected: extension still calls `agent.notifications.subscribe` and lacks role UI/state.

- [ ] **Step 3: Implement connection registration**

On `session_start`:

- set `subscriberId` and `sessionRef` from the current `ctx.sessionManager`;
- validate Herdr env and save it as initial registration identity;
- create client and install callbacks before starting requests;
- `onConnected` calls one deduplicated `registerPresence(ctx)` promise, using `state.currentScope?.paneId/workspaceId` when available and launch env only before the first authoritative response;
- apply response presence before state/pending events;
- set `isOrchestrator` by comparing response owner terminal to response presence terminal;
- use `setStatus("shepherd-orchestrator", "Shepherd: orchestrator")` only when true;
- clear connection error status after successful register.

On `session_shutdown`, call explicit client `close()`. The daemon handles terminal grace and replacement matching.

- [ ] **Step 4: Run extension tests**

Run: `pnpm test test/unit/shepherd-pi-extension.test.ts`

Expected: registration/lifecycle tests pass; command tests may still be absent.

- [ ] **Step 5: Commit**

```bash
git add packages/shepherd-pi/src/index.ts test/unit/shepherd-pi-extension.test.ts
git commit -m "feat(pi): register orchestrator presence"
```

### Task 3: Add `/shepherd orchestrator` Command and Role UI

**Objective:** Provide the exact on/off/status UX decided in the design session.

**Files:**
- Modify: `packages/shepherd-pi/src/index.ts`
- Modify: `test/unit/shepherd-pi-extension.test.ts`

**Interfaces:**
- Consumes: `agent.orchestrator.get` and `agent.orchestrator.set`.
- Produces: Pi command `shepherd`.

- [ ] **Step 1: Write failing command tests**

Capture `registerCommand("shepherd", options)` and invoke its handler. Assert:

1. `orchestrator`, `orchestrator status`, and whitespace-normalized variants call get.
2. `orchestrator on` calls set `{ enabled: true }`.
3. `orchestrator off` calls set `{ enabled: false }`.
4. Bare/unknown args notify warning with exact usage.
5. Before successful registration, on/off/status notify error `Shepherd orchestrator is unavailable until this Pi reconnects to the daemon` and make no RPC call.
6. On success, response state/presence updates local scope/footer and merges owner-only `events` into local pending state.
7. Non-owner off response with `changed: false` notifies `This Pi is not the Shepherd orchestrator` and does not clear another owner's displayed status data.
8. Status with no owner says `No Shepherd orchestrator is set for <session>/<workspace>`.
9. Status with another owner includes its pane id.
10. Owner status says `This Pi is the Shepherd orchestrator for <session>/<workspace> (<pane>)`.
11. Owner-initiated `off` produces one command completion notification, not a second transient role-change notification.

- [ ] **Step 2: Run red test**

Run: `pnpm test test/unit/shepherd-pi-extension.test.ts`

Expected: no `shepherd` command is registered.

- [ ] **Step 3: Implement strict parser and response application**

Register once during extension factory execution:

```ts
pi.registerCommand?.("shepherd", {
  description: "Manage the Shepherd orchestrator for this Herdr workspace",
  getArgumentCompletions(prefix: string) {
    const values = ["orchestrator", "orchestrator on", "orchestrator off", "orchestrator status"];
    return values
      .filter((value) => value.startsWith(prefix))
      .map((value) => ({ label: value, value }));
  },
  handler: async (args: string, ctx: PiContext) => {
    // parse exact tokens and call get/set
  },
});
```

Use one `applyConnectionStateResponse()` helper for register/get/set. It applies presence/state and dedupes returned `events` by id when self is owner. Never infer success from the requested action; use returned owner terminal. Wrap set RPC in `state.roleMutationInFlight = true` with `finally` reset so the initiating connection can suppress duplicate transient stream feedback while still applying stream state.

- [ ] **Step 4: Handle role stream UI**

For `agent.orchestrator.changed`:

- apply authoritative scope/owner if the current terminal appears in previous or current state;
- set owner footer only when current owner terminal equals self;
- if self becomes current owner from a stream change (for example after pane movement), immediately call `agent.orchestrator.get` and apply its pending `events` so shared unread state transfers without reconnect;
- if self was previous owner and is no longer owner, clear footer and, unless `roleMutationInFlight` is true, call:

```ts
ctx.ui.notify(
  change.current.owner
    ? `Shepherd orchestrator moved to ${change.current.owner.paneId}`
    : "Shepherd orchestrator is now off for this workspace",
  "info",
);
```

Do not notify a Pi that was neither previous nor current owner. Role stream data never enters LLM context or `appendEntry`.

- [ ] **Step 5: Run command/UI tests**

Run: `pnpm test test/unit/shepherd-pi-extension.test.ts`

Expected: all command aliases, no-op off, footer, and transient notification tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/shepherd-pi/src/index.ts test/unit/shepherd-pi-extension.test.ts
git commit -m "feat(pi): manage orchestrator role"
```

### Task 4: Migrate Agent Updates, Ack, Context, Telemetry, and Auto-Resume

**Objective:** Remove subscriber semantics while preserving all non-notification behavior for every Pi.

**Files:**
- Modify: `packages/shepherd-pi/src/index.ts`
- Modify: `test/unit/shepherd-pi-extension.test.ts`

**Interfaces:**
- Consumes: owner-only `agent.event`, connection-bound `agent.notifications.ack`, authoritative current scope.
- Produces: existing hidden context and telemetry behavior under new routing.

- [ ] **Step 1: Write failing behavior matrix tests**

Add tests for:

- owner receives stream event, increments unread UI, appends event entry, optionally auto-resumes, injects updates, and acks `{ eventId }` without subscription id;
- non-owner receives role changes but no event in normal server integration; unit-level defensive event receipt is ignored when `isOrchestrator === false`;
- owner self-terminal event is ignored defensively even though daemon filters it;
- pending events returned during registration appear in next hidden update and are acked in ascending id order;
- role switch before ack clears old local pending events so they transfer/replay to the new owner rather than being acked by the old owner;
- ownerless/non-owner `before_agent_start` still calls `agent.list` and injects `[SHEPHERD AGENT CONTEXT]` with no update section;
- telemetry is sent by owner and non-owner alike using authoritative moved `workspaceId`;
- `before_agent_start` refreshes status with `agent.orchestrator.get` before `agent.list` when the connection is registered, so a non-owner moved pane receives current scope on its next turn;
- daemon failure during get/list/ack returns `{}` or context already prepared without throwing into Pi;
- successful injection clears unread status/widget after acks;
- `autoResume` triggers only for owner `agent.done|agent.blocked|agent.idle` events.

- [ ] **Step 2: Run red test**

Run: `pnpm test test/unit/shepherd-pi-extension.test.ts`

Expected: old subscription id ack and unconditional event handling fail the new matrix.

- [ ] **Step 3: Implement owner-only local event handling**

- Route stream messages through one discriminated handler.
- Before adding an event, require `state.isOrchestrator` and `event.terminalId !== state.currentScope.terminalId` when terminal id is present.
- On any role loss, clear local pending events without ack; the shared daemon cursor keeps them pending.
- Sort/dedupe pending events by id to handle reconnect replay.
- In `before_agent_start`, apply get response, request `agent.list` for authoritative scope, build context, then ack each injected event in ascending order with `{ eventId }`.
- Keep `formatHiddenAgentContext()` and `formatHiddenAgentUpdates()` public outputs unchanged.

- [ ] **Step 4: Use authoritative scope everywhere**

Replace direct post-start use of `process.env.HERDR_WORKSPACE_ID` with `state.currentScope.workspaceId` for:

- `agent.list`;
- `agent.telemetry` tool result;
- `agent.telemetry` final message;
- hidden context workspace label.

Environment values remain only the initial registration input.

- [ ] **Step 5: Remove old subscription symbols**

Run:

```bash
rg "currentSubscriptionId|agent\.notifications\.subscribe|subscriptionId" packages/shepherd-pi test/unit/shepherd-pi-extension.test.ts -n
```

Expected: no matches.

- [ ] **Step 6: Run Pi focused tests**

Run: `pnpm test test/unit/shepherd-pi-extension.test.ts test/integration/shepherd-pi-daemon-client.test.ts && pnpm --dir packages/shepherd-pi typecheck`

Expected: all tests/typecheck pass.

- [ ] **Step 7: Verify package contents**

Run: `(cd packages/shepherd-pi && npm pack --dry-run --json)`

Expected: output includes `src/index.ts`, `src/daemon-client.ts`, `skills/shepherd/SKILL.md`, and excludes `dist/`, `node_modules/`, and SQLite files.

- [ ] **Step 8: Commit**

```bash
git add packages/shepherd-pi/src/index.ts packages/shepherd-pi/src/daemon-client.ts test/unit/shepherd-pi-extension.test.ts test/integration/shepherd-pi-daemon-client.test.ts
git commit -m "fix(pi): deliver updates only to orchestrator"
```

## Validation

- `pnpm test test/integration/shepherd-pi-daemon-client.test.ts`
- `pnpm test test/unit/shepherd-pi-extension.test.ts`
- `pnpm --dir packages/shepherd-pi typecheck`
- `(cd packages/shepherd-pi && npm pack --dry-run --json)`
- `rg "agent\.notifications\.subscribe|currentSubscriptionId|subscriptionId" packages/shepherd-pi test/unit/shepherd-pi-extension.test.ts -n` returns no matches.

## Risks, Tradeoffs, and Open Questions

- Pi command handlers outlive old runtime state during replacement flows only when they initiate replacement. This command does not initiate replacement; session shutdown closes the old client and the new extension instance re-registers.
- Local pending events are intentionally discarded without ack on role loss. The new owner receives them from the shared daemon cursor.
- The client retries forever at a 1-second ceiling. Explicit `session_shutdown` is required to stop timers and avoid keeping Pi alive.
- No product questions remain for this child plan.

## Next Steps

After package tests and dry-run pass, continue with [documentation and validation](05-docs-validation.md).
