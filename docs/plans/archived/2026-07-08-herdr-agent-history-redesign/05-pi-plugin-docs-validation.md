# Pi Extension, Herdr Plugin, Docs, Cleanup, and Dogfooding Plan

> **For implementers:** Execute this plan task-by-task. Complete each checkbox step, run the listed validation, and commit after each task.

**Goal:** Update runtime integrations and docs to the new agent history surface, remove old worker/context/snapshot commands, and verify Shepherd in a real Herdr workspace.

**Architecture:** Pi extension uses daemon agent RPCs for current-workspace pull hidden context and unread push agent events. Herdr plugin exposes agent list/read actions instead of context/dashboard worker views. Documentation points agents to `shepherd agent list/get/read` and daemon requirement.

**Tech Stack:** TypeScript, Pi extension package, Herdr plugin package, Vitest, npm pack dry-run, Herdr CLI.

## Global Constraints

- Pi hidden context is current workspace only.
- Push hidden context contains event + compact history.
- Pull hidden context uses same compact contract as `shepherd agent list`.
- Remove old `worker`, `context`, `snapshot` wording from non-plan docs/code/tests.
- Do not mention `shepherd context` or `shepherd snapshot` as normal user commands.
- `shepherd-pi` should use `agent.notifications.subscribe`, `agent.notifications.ack`, and `agent.telemetry`.
- Herdr plugin should not expose old `context` action or `Workers` dashboard.
- Full validation must include `pnpm check` and `pnpm build`.

## Current Context

- `packages/shepherd-pi/src/index.ts` currently sends `workspace.observe`, `notification.subscribe`, and `runtime.telemetry`, listens for `worker.event`, and formats `[SHEPHERD WORKER NOTIFICATIONS]`.
- `packages/shepherd-pi/skills/shepherd/SKILL.md` currently instructs agents to run `shepherd context --json`.
- `packages/shepherd-herdr-plugin/index.mjs` currently exposes `context` and `dashboard` using `workspace.snapshot` and worker rows.
- `packages/shepherd-herdr-plugin/herdr-plugin.toml` currently has action id `context` and pane id `dashboard` titled `Shepherd Workers`.
- README/package descriptions still describe worker observability.

## File Structure

- Modify: `packages/shepherd-pi/src/index.ts` — agent notifications and hidden context.
- Modify: `test/unit/shepherd-pi-extension.test.ts` — new event names/context text.
- Modify: `packages/shepherd-pi/skills/shepherd/SKILL.md` — agent list/get/read instructions.
- Modify: `packages/shepherd-pi/README.md` — new behavior.
- Modify: `packages/shepherd-herdr-plugin/index.mjs` — agent actions/pane output.
- Modify: `packages/shepherd-herdr-plugin/herdr-plugin.toml` — action/pane ids/titles.
- Modify: `packages/shepherd-herdr-plugin/README.md` — new plugin docs.
- Modify: `test/unit/herdr-plugin-package.test.ts` — new plugin behavior.
- Modify: `README.md`, `README.ja.md`, `SKILL.md`, `package.json`, package descriptions — new public messaging.
- Delete or update tests that mention old worker/context/snapshot commands.

## Interfaces

Pi extension daemon calls:

```ts
agent.notifications.subscribe params: {
  autoResume: boolean;
  subscriberId: string;
  subscriberKind: "pi";
  workspaceId: string;
}

agent.notifications.ack params: {
  eventId: number;
  subscriptionId: string;
}

agent.list params: {
  workspaceId: string;
}

agent.telemetry params: {
  event: AgentTelemetryEvent;
  workspaceId: string;
}
```

Hidden context shape:

```text
[SHEPHERD AGENT CONTEXT]
Current Herdr workspace: wB
- pi wB:p1 idle
  last user: ...
  last assistant: ...
- claude wB:p2 done
  last user: ...
  last assistant: ...

[SHEPHERD AGENT UPDATES]
- agent.done claude wB:p2
  last assistant: ...
  event: 42
```

## Tasks

### Task 1: Update Pi extension to agent notifications and pull context

**Objective:** Make Pi receive current workspace compact agent context and unread agent updates without old worker events.

**Files:**
- Modify: `packages/shepherd-pi/src/index.ts`
- Modify: `test/unit/shepherd-pi-extension.test.ts`

**Interfaces:**
- Consumes: `agent.list`, `agent.notifications.subscribe`, `agent.notifications.ack`, `agent.telemetry`, streamed `agent.event`.
- Produces: `formatHiddenAgentContext()` and `formatHiddenAgentUpdates()`.

- [x] **Step 1: Write the failing tests**

Update tests:

1. On `session_start`, extension calls `agent.notifications.subscribe` with `workspaceId: HERDR_WORKSPACE_ID`, `subscriberKind: "pi"`, and no observed workspace id.
2. On `before_agent_start`, extension calls `agent.list` for current workspace and returns `[SHEPHERD AGENT CONTEXT]` even when there are no unread events.
3. When pending agent events exist, hidden context includes `[SHEPHERD AGENT UPDATES]` and each event's compact history.
4. `before_agent_start` acks pending events via `agent.notifications.ack` after preparing hidden context.
5. Streamed `agent.event` increments UI status/widget and appends `shepherd.agent_event` entry.
6. Tool result telemetry sends `agent.telemetry` with type `agent.tool.completed` and compact/redacted excerpt fields.
7. Final message telemetry sends `agent.telemetry` with type `agent.message.final`.
8. No output string contains `worker`, `snapshot`, or `[SHEPHERD WORKER NOTIFICATIONS]`.

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm test test/unit/shepherd-pi-extension.test.ts`

Expected: Tests fail because extension still uses worker methods and worker text.

- [x] **Step 3: Write minimal implementation**

Implementation rules:

- Keep daemon socket connection and `defaultSocketPath()`.
- Remove `workspace.observe` call from session_start. The daemon watches all running Herdr sessions independently.
- Store `currentWorkspaceId` directly from `HERDR_WORKSPACE_ID` when `HERDR_ENV=1`.
- Subscribe using `agent.notifications.subscribe` only when current workspace id exists.
- Listen for `agent.event`, not `worker.event`.
- On `before_agent_start`, always request `agent.list` for current workspace when current workspace id exists. If daemon is unavailable, return `{}` and set UI status to a concise error; do not throw into Pi turn startup.
- Include only current workspace agents in hidden context.
- Acknowledge pending events after hidden context is built.
- Rename helper exports to `formatHiddenAgentContext` and `formatHiddenAgentUpdates`.

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm test test/unit/shepherd-pi-extension.test.ts`

Expected: Pi extension tests pass.

- [x] **Step 5: Commit**

```bash
git add packages/shepherd-pi/src/index.ts test/unit/shepherd-pi-extension.test.ts
git commit -m "pi: inject agent history context"
```

### Task 2: Update Herdr plugin to agent surface

**Objective:** Replace old context/dashboard plugin surface with agent list/read views.

**Files:**
- Modify: `packages/shepherd-herdr-plugin/index.mjs`
- Modify: `packages/shepherd-herdr-plugin/herdr-plugin.toml`
- Modify: `test/unit/herdr-plugin-package.test.ts`

**Interfaces:**
- Consumes: daemon RPC `agent.list` and optional `agent.read`.
- Produces: plugin action/pane for agent history.

- [x] **Step 1: Write the failing tests**

Update plugin package tests:

1. Manifest contains action id `agent-list`, title `Show Shepherd agents`, and no action id `context`.
2. Manifest pane title is `Shepherd Agents`, not `Shepherd Workers`.
3. Plugin `agent-list` command calls `agent.list` with current `HERDR_WORKSPACE_ID` from env.
4. Plugin pane renders rows with `status`, `agent`, `pane`, `last user`, and `last assistant`.
5. Invalid old command `context` returns usage error.
6. Pack dry-run still includes `index.mjs` and `herdr-plugin.toml` and no `dist/`.

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm test test/unit/herdr-plugin-package.test.ts`

Expected: Tests fail because plugin still exposes context/dashboard worker surface.

- [x] **Step 3: Write minimal implementation**

- Replace command parser entries with `agent-list` and `agents` pane command.
- Remove `workspace.observe` and `workspace.snapshot` usage.
- Require `HERDR_ENV=1` and `HERDR_WORKSPACE_ID`; otherwise print a concise Herdr context error.
- Call `agent.list` with `{ workspaceId: env.HERDR_WORKSPACE_ID }`.
- Render compact agent rows.

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm test test/unit/herdr-plugin-package.test.ts`

Expected: Plugin tests pass.

- [x] **Step 5: Commit**

```bash
git add packages/shepherd-herdr-plugin/index.mjs packages/shepherd-herdr-plugin/herdr-plugin.toml test/unit/herdr-plugin-package.test.ts
git commit -m "plugin: show shepherd agents"
```

### Task 3: Remove old worker/context/snapshot files and references

**Objective:** Finish terminology cleanup in active code and tests.

**Files:**
- Delete or replace: `src/db/workers.ts`, `src/db/worker-events.ts`, `src/db/worker-snapshots.ts`
- Delete or replace: `src/observability/worker-state-pipeline.ts`, `src/observability/pi-transcript-adapter.ts`, `src/observability/runtime-adapter.ts` if no longer used
- Modify: active tests under `test/unit` and `test/integration`
- Modify: imports in all source files

**Interfaces:**
- Consumes: agent replacements from child plans 01-04.
- Produces: active code with no old worker surface.

- [x] **Step 1: Search for old terms**

Run:

```bash
rg "worker|Worker|snapshot|context|observedWorkspace|observed-workspace|workspace\.snapshot|worker\.events|runtime\.telemetry|message-worker|wait-worker" src packages test README.md README.ja.md SKILL.md -n
```

Expected: Many hits before cleanup. Do not include `docs/plans` in this search because plan files may mention old names.

- [x] **Step 2: Remove or rename active code**

Rules:

- Delete unused old store/pipeline files when no imports remain.
- Replace `runtime.telemetry` with `agent.telemetry`.
- Replace `notification.subscribe` with `agent.notifications.subscribe` in active code.
- Replace `worker.event` stream with `agent.event`.
- Replace package descriptions that say worker observability.
- Keep the term `context` only when it refers to Pi/Herdr API types or general hidden context, not as a Shepherd command or API surface.
- Keep the term `snapshot` only for Herdr official `session.snapshot`, not Shepherd user-facing snapshot command.

- [x] **Step 3: Run targeted compile/test check**

Run:

```bash
pnpm typecheck
pnpm test test/unit/cli.test.ts test/unit/shepherd-pi-extension.test.ts test/unit/herdr-plugin-package.test.ts
```

Expected: Typecheck passes and targeted tests pass.

- [x] **Step 4: Re-run old-term search**

Run:

```bash
rg "message-worker|wait-worker|shepherd context|shepherd snapshot|workspace\.snapshot|worker\.events|worker\.event|WorkerStatePipeline|WorkerStore|WorkerSnapshot|worker_" src packages test README.md README.ja.md SKILL.md -n
```

Expected: No matches. If matches remain in quoted test fixtures for old rejection behavior, change tests to avoid old command strings or move the assertion to a focused parser test without documenting old names in user docs.

- [x] **Step 5: Commit**

```bash
git add src packages test package.json README.md README.ja.md SKILL.md
git add -u
git commit -m "cleanup: remove worker observability surface"
```

### Task 4: Update README, skill docs, and package descriptions

**Objective:** Document the new simple command surface and daemon behavior.

**Files:**
- Modify: `README.md`
- Modify: `README.ja.md`
- Modify: `SKILL.md`
- Modify: `packages/shepherd-pi/README.md`
- Modify: `packages/shepherd-pi/skills/shepherd/SKILL.md`
- Modify: `packages/shepherd-herdr-plugin/README.md`
- Modify: `package.json`
- Modify: `packages/shepherd-pi/package.json`
- Modify: `packages/shepherd-herdr-plugin/package.json`

**Interfaces:**
- Consumes: final CLI/RPC behavior.
- Produces: docs aligned with commands.

- [x] **Step 1: Write doc changes**

Docs must state:

- Shepherd indexes Herdr agents and their agent history.
- Start daemon explicitly:

```bash
shepherd daemon start
```

- Main commands:

```bash
shepherd agent list --json
shepherd agent get claude --json
shepherd agent read claude --limit 20 --json
shepherd agent list --all --json
```

- `agent list` is current workspace by default inside Herdr.
- Daemon watches all running Herdr sessions and all workspaces in them.
- Stopped Herdr sessions are not indexed.
- Pi extension can inject current workspace agent context automatically.
- Use Herdr for pane/tab/terminal control; use Shepherd for compact agent history.

Docs must not present `context`, `snapshot`, or worker commands.

- [x] **Step 2: Run doc term search**

Run:

```bash
rg "worker|Worker|shepherd context|shepherd snapshot|message-worker|wait-worker" README.md README.ja.md SKILL.md packages/shepherd-pi packages/shepherd-herdr-plugin -n
```

Expected: No matches except package changelog/history text if present. If matches remain in package lock or generated artifacts, do not edit generated artifacts for wording.

- [x] **Step 3: Commit**

```bash
git add README.md README.ja.md SKILL.md packages/shepherd-pi/README.md packages/shepherd-pi/skills/shepherd/SKILL.md packages/shepherd-herdr-plugin/README.md package.json packages/shepherd-pi/package.json packages/shepherd-herdr-plugin/package.json
git commit -m "docs: describe agent history workflow"
```

### Task 5: Full validation and dogfood in Herdr workspace

**Objective:** Prove the new surface works in tests and against the local Herdr workspace.

**Files:**
- No planned source edits unless validation reveals defects.

**Interfaces:**
- Consumes: all child plans.
- Produces: verified implementation.

- [x] **Step 1: Run full validation**

Run:

```bash
pnpm check
pnpm build
```

Expected:

- `pnpm check` passes typecheck, Vitest, Biome, Drizzle, Pi package, and Herdr plugin checks.
- `pnpm build` succeeds and import aliases resolve.

If PATH is stale, use:

```bash
PATH="$HOME/.local/share/mise/installs/node/24.18.0/bin:$HOME/.local/share/mise/installs/pnpm/11.9.0/bin:$PATH" pnpm check
PATH="$HOME/.local/share/mise/installs/node/24.18.0/bin:$HOME/.local/share/mise/installs/pnpm/11.9.0/bin:$PATH" pnpm build
```

- [x] **Step 2: Start daemon with isolated home for dogfood**

Run:

```bash
rm -rf /tmp/shepherd-agent-history-dogfood
SHEPHERD_HOME=/tmp/shepherd-agent-history-dogfood pnpm build
SHEPHERD_HOME=/tmp/shepherd-agent-history-dogfood node dist/src/cli/shepherd.js daemon start
```

Expected: daemon starts and writes socket under `/tmp/shepherd-agent-history-dogfood`.

- [x] **Step 3: Verify Herdr sessions are indexed**

Run:

```bash
herdr session list --json
SHEPHERD_HOME=/tmp/shepherd-agent-history-dogfood node dist/src/cli/shepherd.js agent list --all --json
```

Expected:

- Herdr reports at least the running `default` session.
- Shepherd returns agents from running Herdr sessions.

- [x] **Step 4: Verify workspace `wB`**

From any shell, run:

```bash
SHEPHERD_HOME=/tmp/shepherd-agent-history-dogfood node dist/src/cli/shepherd.js agent list --workspace wB --json
SHEPHERD_HOME=/tmp/shepherd-agent-history-dogfood node dist/src/cli/shepherd.js agent get claude --workspace wB --json
SHEPHERD_HOME=/tmp/shepherd-agent-history-dogfood node dist/src/cli/shepherd.js agent read claude --workspace wB --limit 10 --json
```

Expected:

- `agent list` includes Pi pane `wB:p1` and Claude pane `wB:p2` when those panes exist.
- `agent get claude` includes metadata and compact history.
- `agent read claude --limit 10` includes recent user/assistant/tool_result messages and no full raw tool output.

- [x] **Step 5: Verify daemon-required behavior**

Run with daemon stopped:

```bash
SHEPHERD_HOME=/tmp/shepherd-agent-history-dogfood node dist/src/cli/shepherd.js daemon stop
SHEPHERD_HOME=/tmp/shepherd-agent-history-dogfood node dist/src/cli/shepherd.js agent list --all
```

Expected: command fails with guidance to run `shepherd daemon start`; it does not auto-start.

- [x] **Step 6: Commit validation fixes only if needed**

If validation required fixes, commit them with a targeted message. If no fixes, do not create an empty commit.

## Validation

- `pnpm check`
- `pnpm build`
- `SHEPHERD_HOME=/tmp/shepherd-agent-history-dogfood node dist/src/cli/shepherd.js agent list --all --json`
- `SHEPHERD_HOME=/tmp/shepherd-agent-history-dogfood node dist/src/cli/shepherd.js agent list --workspace wB --json`
- `SHEPHERD_HOME=/tmp/shepherd-agent-history-dogfood node dist/src/cli/shepherd.js agent get claude --workspace wB --json`
- `SHEPHERD_HOME=/tmp/shepherd-agent-history-dogfood node dist/src/cli/shepherd.js agent read claude --workspace wB --limit 10 --json`

## Risks, Tradeoffs, and Open Questions

- Hidden context can grow when many agents exist in one workspace. Keep list output compact and bounded.
- Pi extension should degrade gracefully if daemon is down; CLI should fail clearly.
- `rg "worker"` may find legitimate third-party package or archived docs. Limit cleanup gates to active source/docs/packages/tests, excluding `docs/plans`.
- Herdr workspace `wB` is a local dogfood fixture and may not exist on every machine. Tests must not depend on it; it is manual verification only.
