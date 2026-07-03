# Cleanup, Documentation, and Validation

Parent: [2026-07-02-herdr-worker-observability-rewrite.md](../2026-07-02-herdr-worker-observability-rewrite.md)

## Status

Not started.

## Progress

- Not started — Task 14 through Task 16 plus final validation and risk review.

## Next steps

- Execute the first unchecked step in this child plan after all earlier child plans are complete.

## Objective

Remove legacy Gateway/session surfaces, update docs/package metadata, and run full validation.

## Scope

Task 14 through Task 16 plus final validation and risk review.

### Task 14: Remove Old Gateway, Session, Slack, and Thin Herdr Tool Paths

**Objective:** Delete obsolete session/Gateway orchestration code so Shepherd cannot regress into an LLM gateway or Herdr proxy.

**Files:**
- Delete: `src/gateway/server.ts`
- Delete: `src/gateway/runtime.ts`
- Delete: `src/gateway/builtin-tools.ts`
- Delete: `src/gateway/tools.ts`
- Delete: `src/gateway/pi-turn-queue.ts`
- Delete: `src/db/pi-turns.ts`
- Delete: `src/db/event-store.ts` if not reused for worker events
- Delete: `src/db/session-bindings.ts`
- Delete: `src/delivery/*`
- Delete: `src/platforms/*`
- Delete tests that validate removed behavior
- Modify: `src/config/schema.ts`
- Test: `test/unit/config-schema.test.ts`
- Delete: `test/integration/gateway-runtime.test.ts`
- Test: `test/integration/daemon-service.test.ts`

**Interfaces:**
- Consumes: replacement daemon API from prior tasks.
- Produces: smaller codebase centered on worker observability.

- [ ] **Step 1: Write failing deletion guard tests**

Add tests that assert:

- config rejects `platforms.slack`
- config rejects `gateway.pi` old queue settings
- old CLI commands `send`, `open`, `watch`, `audit` are invalid
- public tool list does not contain `herdr_read`, `herdr_read_pane`, `herdr_open_pane`, `herdr_send_pane_text`, `session_read`

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test test/unit/config-schema.test.ts test/unit/cli.test.ts`

Expected: old config/CLI/tool paths still exist.

- [ ] **Step 3: Remove obsolete files and exports**

Remove code paths that are no longer part of the architecture. Keep only reusable low-level utilities:

- JSON Lines encoder/decoder
- process manager if still used by daemon start/stop
- Herdr socket/session client
- config runtime path loading
- SQLite migration helpers

- [ ] **Step 4: Update config schema**

MVP config should include only:

```yaml
runtime:
  db_path: state.db
  socket_path: shepherd.sock
  pid_path: shepherd.pid
  log_path: logs/shepherd.log
observability:
  telemetry:
    max_excerpt_bytes: 4096
```

`observability.telemetry.max_excerpt_bytes` defaults to `4096`. Retention settings are not active in MVP.

- [ ] **Step 5: Run focused tests**

Run: `pnpm test test/unit/config-schema.test.ts test/unit/cli.test.ts test/integration/observability-rpc.test.ts`

Expected: focused tests pass and no imports refer to deleted modules.

- [ ] **Step 6: Commit**

```bash
git add src test package.json
git commit -m "refactor: remove legacy gateway surfaces"
```

### Task 15: Update Documentation and Package Metadata

**Objective:** Document Shepherd's new purpose, install flow, CLI, Pi extension, Herdr plugin, and validation commands.

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md` if commands or important paths change
- Modify: `packages/shepherd-pi/package.json`
- Modify: `packages/shepherd-herdr-plugin/package.json`
- Modify: `package.json`
- Test: docs reviewed manually

**Interfaces:**
- Consumes: final CLI and package names from implementation.
- Produces: user-facing and agent-facing instructions aligned with new architecture.

- [ ] **Step 1: Update README**

README must state:

- Shepherd is a Herdr worker observability/orchestration layer.
- Shepherd is not an LLM gateway.
- Shepherd is not a thin Herdr wrapper.
- Core value:
  - structured worker snapshots
  - enriched worker events
  - orchestrator push notifications
- Quick start:
  - `pnpm install`
  - `pnpm check`
  - `pnpm build`
  - `shepherd daemon start`
  - `pi install ./packages/shepherd-pi`
  - `herdr plugin link ./packages/shepherd-herdr-plugin`
- CLI examples for `observe`, `snapshot`, `events`, `notifications`, and `ack`.

- [ ] **Step 2: Update AGENTS.md if needed**

If commands, important paths, or validation steps changed, update root `AGENTS.md` with concise bullets. Do not duplicate README examples.

- [ ] **Step 3: Add Herdr plugin package checks**

Update root `package.json` scripts so `pnpm check` validates the Herdr plugin package:

```json
{
  "scripts": {
    "herdr-plugin:check": "pnpm --dir packages/shepherd-herdr-plugin typecheck && (cd packages/shepherd-herdr-plugin && npm pack --dry-run --json > /dev/null)",
    "check": "pnpm typecheck && pnpm test && pnpm lint && pnpm format:check && pnpm db:check && pnpm pi-package:check && pnpm herdr-plugin:check"
  }
}
```

- [ ] **Step 4: Run documentation and package checks**

Run: `pnpm format:check && pnpm herdr-plugin:check`

Expected: formatting check passes for files covered by Biome, and the Herdr plugin package typechecks and packs in dry-run mode. Markdown is reviewed manually for links and command accuracy.

- [ ] **Step 5: Commit**

```bash
git add README.md AGENTS.md package.json packages/shepherd-pi/package.json packages/shepherd-herdr-plugin/package.json
git commit -m "docs: describe worker observability rewrite"
```

### Task 16: Full Validation and Build

**Objective:** Verify the rewrite as a complete product slice.

**Files:**
- No new files expected unless validation exposes missing docs or tests.

**Interfaces:**
- Consumes: all prior tasks.
- Produces: final confidence that the rewrite builds and tests pass.

- [ ] **Step 1: Run full validation**

Run:

```bash
pnpm check
pnpm build
```

Expected:

- `pnpm check` passes typecheck, tests, Biome, format check, Drizzle check, Pi package check, Herdr plugin package check, and package dry-runs.
- `pnpm build` emits `dist` without TypeScript or alias resolution errors.

- [ ] **Step 2: Manual smoke test with Herdr and Pi**

In a Herdr pane with Pi and the Shepherd Pi extension installed:

```bash
shepherd daemon start
shepherd observe-current --json
shepherd snapshot <observedWorkspaceId> --json
```

Expected:

- `observe-current` returns an `observedWorkspaceId`.
- `snapshot` returns workers auto-discovered from the current Herdr workspace.
- A Pi tool result updates the worker snapshot with `lastTool`.
- A worker completion emits `worker.completed` and appears as an unread notification.
- Next Pi turn receives hidden Shepherd worker notification context.

- [ ] **Step 3: Manual smoke test with Herdr plugin**

```bash
herdr plugin link ./packages/shepherd-herdr-plugin
herdr plugin action invoke observe-workspace --plugin shepherd.observability
herdr plugin pane open --plugin shepherd.observability --entrypoint dashboard
```

Expected:

- observe action prints an observed workspace id.
- dashboard pane renders worker rows and refreshes.

- [ ] **Step 4: Commit any validation-only fixes**

If validation required fixes, commit them as:

```bash
git add <fixed-files>
git commit -m "fix: stabilize observability rewrite"
```

If no fixes were needed, do not create an empty commit.

## Validation

Run after all tasks:

```bash
pnpm check
pnpm build
```

Expected final result:

- All TypeScript checks pass.
- All unit and integration tests pass.
- Biome lint and format checks pass.
- Drizzle check passes with the new baseline schema.
- Package checks pass for Pi and Herdr plugin packages.
- Build succeeds and CLI entrypoints resolve aliases.

Manual validation:

- `shepherd daemon start` starts the daemon and creates the configured socket.
- `shepherd observe-current --json` works only inside Herdr and returns a stable `observedWorkspaceId`.
- `shepherd snapshot <observedWorkspaceId> --json` returns orchestration-oriented worker snapshots, not pane dumps.
- `shepherd events <observedWorkspaceId> --json` streams `worker.*` events.
- Pi extension sends bounded telemetry and receives non-invasive notifications.
- Herdr plugin observe action and dashboard pane work against the daemon through CLI commands.

## Risks, Tradeoffs, and Open Questions

- **Risk: scope size.** This is a rewrite across DB, daemon, CLI, Pi extension, and plugin packaging. The task order keeps reviewable slices and commits after each task.
- **Risk: Herdr subscription shape.** Herdr `pane.agent_status_changed` subscriptions may require pane-specific subscription entries. Task 3 forces tests against the current raw API before pipeline work depends on it.
- **Risk: heuristic events.** `worker.completed` and `worker.blocked` are rule-based in MVP. Every enriched event must include confidence and evidence so orchestrators can decide whether to act.
- **Risk: data retention.** MVP keeps sanitized excerpts indefinitely. This is accepted for MVP. Full tool results are not stored; future retention settings can prune worker events and snapshots.
- **Risk: deleting old Slack/session behavior.** This is intended. The rewrite goal explicitly drops old Gateway/session/Slack compatibility.
- **Tradeoff: no daemon LLM summarizer.** Snapshot quality is bounded by structured telemetry, transcript adapters, Herdr status, and deterministic rules. This avoids making Shepherd an LLM gateway again.
- **Tradeoff: Herdr Plugin is companion only.** Plugin hooks are not used as the main event stream because they spawn commands per event and have in-flight limits. Daemon socket subscription remains the primary event path.
- **No blocking open questions.** The MVP decisions in this plan are sufficient for implementation.

## Self-Review Checklist

- Requirement coverage: every `/dig` decision is represented in Global Constraints, Core Interfaces, or Tasks.
- Placeholder check: no placeholder markers or undefined future work is required for MVP execution.
- Naming consistency: `observedWorkspaceId`, `workerId`, `workerKey`, `WorkerStatePipeline`, `WorkerTelemetryEvent`, and RPC method names are used consistently.
- Testability: every task has a failing-test step and a passing-test validation command.
- Scope: old Gateway/session/Slack compatibility is intentionally removed; low-level Herdr proxy behavior is not reintroduced.
- DRY: shared contracts and schemas are defined first and consumed by stores, pipeline, daemon, CLI, and Pi extension.

