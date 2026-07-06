# Pi Extension and Herdr Plugin

Parent: [2026-07-02-herdr-worker-observability-rewrite.md](../2026-07-02-herdr-worker-observability-rewrite.md)

## Status

Done.

## Progress

- Done — Task 12 and Task 13.

## Next steps

- No remaining implementation steps. Final validation passed with `pnpm check` and `pnpm build`.

## Objective

Rewrite the Pi extension as a telemetry/notification bridge and add the Herdr companion plugin.

## Scope

Task 12 and Task 13.

### Task 12: Rewrite Pi Extension as Runtime Adapter and Notification Consumer

**Objective:** Make Pi send bounded worker telemetry, receive non-invasive notifications, inject hidden context on next turn, and optionally autoResume.

**Files:**
- Modify: `packages/shepherd-pi/src/index.ts`
- Modify: `packages/shepherd-pi/package.json` if description changes
- Test: `test/unit/shepherd-pi-extension.test.ts`

**Interfaces:**
- Consumes: daemon RPC methods `runtime.telemetry`, `notification.subscribe`, `notification.ack`, `workspace.observe`, `workspace.snapshot`.
- Produces: Pi runtime telemetry and orchestrator notification UX.

- [x] **Step 1: Write failing extension tests**

Test with fake Pi API:

1. On `session_start` inside Herdr env, extension calls `workspace.observe` with current Herdr context.
2. On `tool_result`, extension sends `runtime.telemetry` with bounded output excerpt and artifact ref.
3. On assistant `message_end`, extension sends `worker.message.final` telemetry.
4. On notification event, extension calls `ctx.ui.setStatus` or `ctx.ui.setWidget` and appends local state.
5. On next `before_agent_start`, extension injects hidden context for unacked notifications.
6. After injection, extension calls `notification.ack` only after successful hidden-context handoff.
7. With `autoResume: true`, extension calls `pi.sendUserMessage` with extension-origin content when idle.

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm test test/unit/shepherd-pi-extension.test.ts`

Expected: old session/Gateway extension behavior fails.

- [x] **Step 3: Rewrite extension state**

Use state fields:

```ts
import type { AgentSessionRef, WorkerEventWireRecord } from "@/observability/contracts.js";

type ShepherdState = {
  client?: ShepherdDaemonClient;
  currentObservedWorkspaceId?: string;
  currentSubscriptionId?: string;
  heartbeatTimer?: ReturnType<typeof setInterval>;
  lastAssistantText: string;
  pendingNotifications: WorkerEventWireRecord[];
  sessionRef?: AgentSessionRef;
  toolStartTimes: Map<string, { inputPreview?: string; startedAt: number; toolName: string }>;
};
```

Remove old session attach, Pi turn queue, user message mirroring, and old tool registry logic.

- [x] **Step 4: Implement telemetry hooks**

Use Pi extension events:

- `tool_execution_start` stores input preview and start time
- `tool_result` captures `content`, `details`, and `isError`
- `tool_execution_end` can fill missing duration and error state
- `message_end` for assistant final text

Always send bounded telemetry through `runtime.telemetry`.

- [x] **Step 5: Implement notification behavior**

Default mode:

- UI status/widget indicates unread worker events
- extension stores pending event ids through `pi.appendEntry`
- `before_agent_start` injects hidden context:

```text
[SHEPHERD WORKER NOTIFICATIONS]
- worker.completed impl: completed tests. Evidence: pi-session:/path#entry=a2
- worker.blocked reviewer: needs input on API shape. Evidence: event 42
Use shepherd_worker_snapshot if details are needed.
```

Optional autoResume mode:

- when idle and event type is `worker.completed`, `worker.blocked`, or `worker.needs_input`, call `pi.sendUserMessage` with concise extension-origin message
- do not autoResume for `worker.summary.updated` or `worker.status.changed`

- [x] **Step 6: Run tests**

Run: `pnpm test test/unit/shepherd-pi-extension.test.ts`

Expected: extension tests pass.

- [x] **Step 7: Commit**

```bash
git add packages/shepherd-pi/src/index.ts packages/shepherd-pi/package.json test/unit/shepherd-pi-extension.test.ts
git commit -m "feat(pi): bridge worker telemetry and notifications"
```

### Task 13: Add Herdr Plugin Companion

**Objective:** Provide Herdr-native observe action and dashboard pane without making plugin the event-stream core.

**Files:**
- Create: `packages/shepherd-herdr-plugin/herdr-plugin.toml`
- Create: `packages/shepherd-herdr-plugin/package.json`
- Create: `packages/shepherd-herdr-plugin/tsconfig.json`
- Create: `packages/shepherd-herdr-plugin/src/index.ts`
- Test: `test/unit/herdr-plugin-package.test.ts`

**Interfaces:**
- Consumes: CLI JSON commands and Herdr plugin env vars.
- Produces: installable Herdr plugin package.

- [x] **Step 1: Write failing tests**

Assert:

1. manifest has plugin id `shepherd.observability`.
2. manifest declares action `observe-workspace` with context `workspace`.
3. manifest declares pane `dashboard`.
4. plugin command runs inside Herdr context and calls `shepherd observe-current --json`, which forwards `HERDR_SOCKET_PATH` and `HERDR_WORKSPACE_ID` to the daemon.
5. dashboard command calls `shepherd snapshot <observedWorkspaceId> --json` and renders worker rows.

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm test test/unit/herdr-plugin-package.test.ts`

Expected: package missing.

- [x] **Step 3: Create manifest**

`packages/shepherd-herdr-plugin/herdr-plugin.toml`:

```toml
id = "shepherd.observability"
name = "Shepherd Observability"
version = "0.1.0"
min_herdr_version = "0.7.0"
description = "Observe Herdr workers through Shepherd snapshots and notifications."
platforms = ["linux", "macos", "windows"]

[[actions]]
id = "observe-workspace"
title = "Observe workspace with Shepherd"
contexts = ["workspace"]
command = ["node", "dist/index.js", "observe-workspace"]

[[panes]]
id = "dashboard"
title = "Shepherd Workers"
placement = "split"
command = ["node", "dist/index.js", "dashboard"]
```

- [x] **Step 4: Implement plugin command**

`observe-workspace` behavior:

- require `HERDR_ENV=1`, `HERDR_SOCKET_PATH`, and `HERDR_WORKSPACE_ID`
- call local `shepherd observe-current --json`
- print observed workspace id
- exit with code `2` and print `observe-workspace requires a Herdr-managed pane` when the Herdr env vars are missing

`dashboard` behavior:

- read observed workspace id from `SHEPHERD_OBSERVED_WORKSPACE_ID`, or call `observe-workspace` first
- call `shepherd snapshot <id> --json`
- render compact rows: `status agent summary recommendedAction`
- refresh every 5 seconds until process exits

- [x] **Step 5: Run tests**

Run: `pnpm test test/unit/herdr-plugin-package.test.ts`

Expected: plugin package tests pass.

- [x] **Step 6: Commit**

```bash
git add packages/shepherd-herdr-plugin test/unit/herdr-plugin-package.test.ts
git commit -m "feat(herdr): add Shepherd plugin companion"
```

