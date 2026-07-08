# RPC and CLI: `shepherd agent list/get/read` Plan

> **For implementers:** Execute this plan task-by-task. Complete each checkbox step, run the listed validation, and commit after each task.

**Goal:** Replace old context/snapshot/worker CLI and RPC surface with Herdr-aligned `shepherd agent list/get/read` backed by the daemon DB/cache.

**Architecture:** CLI remains a thin JSON Lines RPC client. It parses Herdr environment variables to set default scope, sends agent RPC requests to the daemon, and formats human/JSON output. The daemon resolves targets from indexed agents and uses `AgentHistoryService` for compact history and recent messages.

**Tech Stack:** TypeScript CLI, JSON Lines RPC, TypeBox/Ajv, Vitest.

## Global Constraints

- CLI requires daemon; if unavailable, tell the user to run `shepherd daemon start`.
- Do not auto-start daemon.
- Remove old external CLI commands: `context`, `snapshot`, `events`, `notifications`, `ack`, `message-worker`, `wait-worker`.
- Keep daemon management command: `shepherd daemon [start|stop|restart|status]`.
- Add:
  - `shepherd agent list [--all] [--workspace <id>] [--session <name>] [--json]`
  - `shepherd agent get <target> [--workspace <id>] [--session <name>] [--json]`
  - `shepherd agent read <target> [--limit N] [--workspace <id>] [--session <name>] [--json]`
- Default scope is current Herdr workspace when `HERDR_ENV=1`, using `HERDR_WORKSPACE_ID`. If available, pass Herdr session identity from daemon index via workspace id; do not require users to know session names.
- `--all` is valid for `agent list` only.
- Scope combinations are explicit:
  - no explicit scope inside Herdr: current `HERDR_WORKSPACE_ID`.
  - `--workspace <id>`: that workspace across running sessions; if multiple Herdr sessions contain the same workspace id, return an ambiguity error asking for `--session <name>`.
  - `--workspace <id> --session <name>`: that workspace in that Herdr session.
  - `--session <name>` without `--workspace`: all workspaces in that Herdr session for `agent list`; target resolution across that Herdr session for `agent get/read`, with ambiguity errors when needed.
  - `--all`: all running Herdr sessions/workspaces for `agent list`; `--all --session <name>` means all workspaces in that Herdr session.
- Target resolution is within selected workspace/session by default. If ambiguous, error with candidate pane ids, terminal ids, agent names, workspace ids, and Herdr session names.
- `agent list` returns compact history without `lastToolResult`.
- `agent get` returns metadata + compact history including `lastToolResult`.
- `agent read` returns recent messages including compact `tool_result`.

## Current Context

- `src/cli/shepherd.ts` currently parses old commands and builds `context` by composing `workspace.observe`, `workspace.snapshot`, and notification subscribe.
- `src/daemon/observability-server.ts` currently dispatches old methods.
- `test/unit/cli.test.ts` currently expects old help and context output.

## File Structure

- Modify: `src/daemon/observability-server.ts` — dispatch `agent.list`, `agent.get`, `agent.read`, `agent.events`, `agent.notifications.subscribe`, `agent.notifications.ack`, `agent.telemetry`.
- Modify: `src/observability/schemas.ts` — ensure agent RPC schemas are used in server dispatch.
- Modify: `src/cli/shepherd.ts` — parse and render `agent` subcommands only plus daemon/help.
- Modify: `test/unit/cli.test.ts` — replace old command tests.
- Modify: `test/integration/observability-rpc.test.ts` — test agent RPC methods.

## Interfaces

Daemon RPC methods:

```ts
agent.list params: {
  all?: boolean;
  herdrSessionName?: string;
  workspaceId?: string;
}
result: { agents: AgentListItem[] }
allowed scopes: current workspace from CLI, workspace, session, all, or session+all.

agent.get params: {
  herdrSessionName?: string;
  target: string;
  workspaceId?: string;
}
result: { agent: AgentGetResult }
allowed scopes: workspace, session, or workspace+session. A session-only target must be unique within that Herdr session.

agent.read params: {
  herdrSessionName?: string;
  limit?: number;
  target: string;
  workspaceId?: string;
}
result: { agent: AgentReadResult }
allowed scopes: same as agent.get. `limit` defaults to 20 and must be 1..500.

agent.events params: {
  afterEventId?: number;
  herdrSessionName?: string;
  limit?: number;
  workspaceId?: string;
}
result: { events: AgentEventRecord[] }
allowed scopes: workspace, session, workspace+session, or all when neither field is present. `limit` defaults to 100 and must be 1..500.

agent.notifications.subscribe params: {
  autoResume?: boolean;
  herdrSessionName?: string;
  subscriberId: string;
  subscriberKind: string;
  workspaceId?: string;
}
result: { subscription: AgentNotificationSubscriptionRecord; events: AgentEventRecord[] }
allowed scopes: workspace, session, or workspace+session. Pi extension must pass current workspace id.

agent.notifications.ack params: {
  eventId: number;
  subscriptionId: string;
}
result: { acknowledged: true }

agent.telemetry params: {
  event: AgentTelemetryEvent;
  workspaceId: string;
}
result: { accepted: true }
```

## Tasks

### Task 1: Add daemon agent RPC methods

**Objective:** Expose agent list/get/read/events/notifications over JSON Lines RPC.

**Files:**
- Modify: `src/daemon/observability-server.ts`
- Modify: `src/observability/schemas.ts`
- Test: `test/integration/observability-rpc.test.ts`

**Interfaces:**
- Consumes: stores from child plan 01, `AgentHistoryService` from child plan 02.
- Produces: RPC methods listed above.

- [x] **Step 1: Write the failing tests**

In `test/integration/observability-rpc.test.ts`, add cases:

1. `agent.list` scoped by `{ herdrSessionName: "default", workspaceId: "wB" }` returns only agents in that workspace and each item includes `lastUserMessage` and `lastAssistantMessage` but not `lastToolResult`.
2. `agent.list` with `{ all: true }` returns agents across two Herdr sessions.
3. `agent.list` with `{ herdrSessionName: "default" }` returns all agents in that Herdr session.
4. `agent.get` resolves `target: "claude"` within workspace and returns `history.lastToolResult`.
5. `agent.get` with `{ herdrSessionName: "default", target: "claude" }` resolves only if `claude` is unique in that session.
6. `agent.get` with ambiguous `target: "pi"` returns an error containing both candidate pane ids.
7. `agent.read` returns messages limited by `limit` and includes `tool_result.compaction`.
8. `agent.events` filters by workspace and supports `afterEventId`.
9. `agent.notifications.subscribe` and `agent.notifications.ack` work with agent events.
10. Old methods `workspace.snapshot`, `worker.events`, `runtime.telemetry` with worker event type, and `notification.subscribe` return `Unknown method`.

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm test test/integration/observability-rpc.test.ts`

Expected: New agent RPC tests fail because methods are missing.

- [x] **Step 3: Write minimal implementation**

In server dispatch:

- `agent.list`: query `AgentStore.list(scope)`, attach compact history for each agent using `AgentHistoryService.getCompactHistory()`, map to `AgentListItem` without `lastToolResult`.
- `agent.get`: resolve target with `AgentStore.resolveTarget(scope, target)`, attach full compact history.
- `agent.read`: resolve target, call `AgentHistoryService.read({ limit })`, return metadata + messages.
- `agent.events`: query `AgentEventStore.listAfter(scope)`.
- `agent.notifications.subscribe`: create subscription in `AgentNotificationService`, return pending events for scope.
- `agent.notifications.ack`: ack event id.
- `agent.telemetry`: accept renamed Pi telemetry in child plan 05.

Implement a helper:

```ts
function scopeFromParams(params: { all?: boolean; herdrSessionName?: string; workspaceId?: string }): AgentQueryScope
```

Rules:

- If `all === true` and `herdrSessionName` is unset, list all running sessions/workspaces.
- If `all === true` and `herdrSessionName` is set, list all workspaces in that Herdr session.
- If `workspaceId` is set without `herdrSessionName`, match all sessions containing that workspace id. If multiple sessions match, return an ambiguity error asking for `--session <name>`.
- If `workspaceId` and `herdrSessionName` are both set, scope to that exact workspace in that Herdr session.
- If only `herdrSessionName` is set, scope to all workspaces in that Herdr session. `agent get/read` must then require a target that is unique in that Herdr session.
- If none of `all`, `workspaceId`, or `herdrSessionName` is set, return an error: `agent scope requires current Herdr workspace, --workspace, --session, or --all`.

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm test test/integration/observability-rpc.test.ts`

Expected: All agent RPC tests pass and old method tests return `Unknown method`.

- [x] **Step 5: Commit**

```bash
git add src/daemon/observability-server.ts src/observability/schemas.ts test/integration/observability-rpc.test.ts
git commit -m "rpc: expose agent history methods"
```

### Task 2: Parse `shepherd agent` CLI commands

**Objective:** Replace old CLI commands with Herdr-aligned agent subcommands.

**Files:**
- Modify: `src/cli/shepherd.ts`
- Test: `test/unit/cli.test.ts`

**Interfaces:**
- Consumes: RPC methods from Task 1.
- Produces: `CliCommand` variants for `agent-list`, `agent-get`, `agent-read` or nested `command: "agent"` variants.

- [x] **Step 1: Write the failing tests**

Update `test/unit/cli.test.ts` with parse cases:

1. `parseCliArgs(["agent", "list"], HERDR_ENV vars)` returns list command with `workspaceId` from `HERDR_WORKSPACE_ID`.
2. `agent list --all --json` sets `all: true`, `json: true`, and no workspace requirement.
3. `agent list --workspace wB --session default` sets explicit scope.
4. `agent list --session default` is valid and sets session-only scope.
5. `agent get claude --json` uses current workspace when in Herdr env.
6. `agent get claude --session default --json` is valid and sets session-only scope.
7. `agent read wB:p2 --limit 20 --json` sets `limit: 20`.
8. `agent read wB:p2 --limit 0` throws an error containing `--limit must be between 1 and 500`.
9. Old commands `context`, `snapshot`, `events`, `notifications`, `message-worker`, and `wait-worker` throw `Unknown command`.
10. Help contains only daemon/help and `agent list/get/read` user commands.

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm test test/unit/cli.test.ts`

Expected: Tests fail because parser still supports old commands and not agent subcommands.

- [x] **Step 3: Write minimal implementation**

Parser rules:

```text
shepherd agent list [--all] [--workspace <id>] [--session <name>] [--json]
shepherd agent get <target> [--workspace <id>] [--session <name>] [--json]
shepherd agent read <target> [--limit N] [--workspace <id>] [--session <name>] [--json]
```

Use current Herdr workspace only when `HERDR_ENV=1` and `HERDR_WORKSPACE_ID` exists. `HERDR_SOCKET_PATH` is not needed by CLI because daemon already indexes running sessions. Error if no current workspace and no `--workspace`/`--all`:

```text
agent list requires HERDR_ENV=1 with HERDR_WORKSPACE_ID, --workspace <id>, or --all
```

Do not parse `--observed-workspace`.

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm test test/unit/cli.test.ts`

Expected: CLI parse/help tests pass.

- [x] **Step 5: Commit**

```bash
git add src/cli/shepherd.ts test/unit/cli.test.ts
git commit -m "cli: add shepherd agent commands"
```

### Task 3: Dispatch CLI to agent RPC and format output

**Objective:** Make `shepherd agent list/get/read` call the daemon and render useful human/JSON output.

**Files:**
- Modify: `src/cli/shepherd.ts`
- Test: `test/unit/cli.test.ts`

**Interfaces:**
- Consumes: parse variants from Task 2.
- Produces: human and JSON rendering.

- [x] **Step 1: Write the failing tests**

Add run command tests:

1. `agent list --json` calls `agent.list` and prints raw JSON with `agents` array.
2. `agent get claude --json` calls `agent.get` with target and scope.
3. `agent read claude --limit 10 --json` calls `agent.read` with target, limit, and scope.
4. Human `agent list` prints a table header: `status	agent	pane	last user	last assistant	updated`.
5. Human `agent get` prints metadata lines plus compact history and last tool if present.
6. Human `agent read` prints each message as `timestamp role tool text`, truncating each text cell to a human-readable width.
7. Socket connection errors produce: `Run \`shepherd daemon start\` before using Shepherd commands.`

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm test test/unit/cli.test.ts`

Expected: Dispatch/format tests fail.

- [x] **Step 3: Write minimal implementation**

Map commands:

- list -> `client.request("agent.list", scope)`.
- get -> `client.request("agent.get", { ...scope, target })`.
- read -> `client.request("agent.read", { ...scope, target, limit })`.

Human formatting rules:

- `agent list`: one line per agent, sorted as returned by daemon. Use `history.lastUserMessage?.text ?? ""` and `history.lastAssistantMessage?.text ?? ""`.
- `agent get`: include `agent`, `status`, `pane`, `terminal`, `workspace`, `Herdr session`, `cwd`, `agent_session`, last user, last assistant, last tool.
- `agent read`: include user/assistant/tool_result messages in chronological order. Tool messages must show compaction mode.

Keep JSON output exactly `JSON.stringify(result)`.

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm test test/unit/cli.test.ts`

Expected: All CLI tests pass.

- [x] **Step 5: Commit**

```bash
git add src/cli/shepherd.ts test/unit/cli.test.ts
git commit -m "cli: read agent history via daemon"
```

### Task 4: Ensure daemon-required behavior is explicit

**Objective:** Make daemon dependency simple and predictable.

**Files:**
- Modify: `src/cli/shepherd.ts`
- Test: `test/unit/cli.test.ts`

**Interfaces:**
- Consumes: existing `formatCliError()`.
- Produces: daemon-required error text.

- [x] **Step 1: Write the failing tests**

Tests:

1. When `connect()` rejects with `ECONNREFUSED`, output contains `Run \`shepherd daemon start\``.
2. When socket path is missing (`ENOENT`), output contains same guidance.
3. CLI does not call `startDaemonProcess()` for agent commands.
4. `shepherd daemon start` behavior remains handled by `main()` and existing daemon tests still pass.

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm test test/unit/cli.test.ts test/unit/daemon-process-manager.test.ts`

Expected: Any missing daemon-required behavior fails.

- [x] **Step 3: Write minimal implementation**

Keep existing daemon command handling. Ensure agent commands go through `ObservabilityRpcClient` and do not call daemon start. Update `formatCliError()` message from observability wording to Shepherd daemon wording if needed.

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm test test/unit/cli.test.ts test/unit/daemon-process-manager.test.ts`

Expected: Tests pass.

- [x] **Step 5: Commit**

```bash
git add src/cli/shepherd.ts test/unit/cli.test.ts test/unit/daemon-process-manager.test.ts
git commit -m "cli: require shepherd daemon for agent reads"
```

## Validation

- `pnpm test test/integration/observability-rpc.test.ts`
- `pnpm test test/unit/cli.test.ts`
- `pnpm test test/unit/daemon-process-manager.test.ts`

## Risks, Tradeoffs, and Open Questions

- `workspaceId` may not be globally unique across Herdr named sessions. RPC must detect ambiguity and ask for `--session`.
- `--all` output can be large. Keep compact history bounded and omit `lastToolResult` from list.
- This child plan does not update Pi extension or docs; child plan 05 handles those.
