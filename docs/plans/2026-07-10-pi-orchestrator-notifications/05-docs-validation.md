# Documentation, Integration Validation, and Dogfooding Plan

> **For implementers:** Execute this plan task-by-task. Complete each checkbox step, run the listed validation, and commit after each task.

**Status:** Planned

**Goal:** Document explicit orchestrator notification routing and prove the complete workflow with automated checks and a real Herdr workspace.

**Architecture:** Public docs explain that all Pi instances retain agent context/telemetry while exactly one explicitly selected terminal receives pushed updates. Automated validation combines contracts, SQLite, daemon sockets, topology reconciliation, and Pi package tests; manual dogfood covers terminal/session behavior that unit tests cannot fully represent.

**Tech Stack:** Markdown, Vitest, pnpm checks/build, npm pack dry-run, Shepherd daemon/CLI, Herdr 0.7.x, Pi 0.80.x.

## Global Constraints

- Inherit all parent constraints.
- Documentation must not describe automatic owner election or project configuration.
- `/shepherd orchestrator ...` is a Pi extension command, not a `shepherd` shell CLI command.
- Do not add orchestrator commands to root `SKILL.md` as shell commands. The skill may state when hidden updates are available.
- README English/Japanese sections must remain semantically aligned.
- Manual validation must use a disposable `SHEPHERD_HOME` when DB reset/restart behavior is exercised.
- Do not archive the plan during the implementation commit series. Archive it later in a separate docs-only commit after all work is accepted, per repository policy.

## Current Context

- Root README and `packages/shepherd-pi/README.md` currently say every Pi subscribes to current-workspace updates.
- Both Shepherd skill files say Pi may receive unread updates but do not describe role selection.
- `pnpm check` already includes typecheck, all tests, Biome, Drizzle, Pi package dry-run, and Herdr plugin checks.
- `pnpm build` is separately required for package/entrypoint changes.

## File Structure

- Modify: `README.md` — orchestrator selection and behavior.
- Modify: `README.ja.md` — aligned Japanese behavior.
- Modify: `packages/shepherd-pi/README.md` — command reference and lifecycle semantics.
- Modify: `packages/shepherd-pi/skills/shepherd/SKILL.md` — owner-only update note.
- Modify: `SKILL.md` — owner-only hidden update boundary.
- Modify: `docs/plans/2026-07-10-pi-orchestrator-notifications.md` — progress/completion evidence after implementation.
- Modify: child plan progress boxes only while executing corresponding tasks.

## Tasks

### Task 1: Update Public Documentation

**Objective:** Make installation users understand how to select, inspect, transfer, and release the orchestrator role.

**Files:**
- Modify: `README.md`
- Modify: `README.ja.md`
- Modify: `packages/shepherd-pi/README.md`
- Modify: `packages/shepherd-pi/skills/shepherd/SKILL.md`
- Modify: `SKILL.md`

**Interfaces:**
- Consumes: final command and role behavior.
- Produces: user-facing operating instructions.

- [ ] **Step 1: Update root Pi extension sections**

English content must state:

- every Pi still receives compact current-workspace agent context before turns;
- pushed unread agent updates go only to the explicit orchestrator;
- select it from that Pi with `/shepherd orchestrator on`;
- inspect with `/shepherd orchestrator` or `status`;
- another Pi's `on` atomically transfers the role in the same Herdr session/workspace;
- release with `off` from the owner;
- no owner means no push notifications;
- the role follows the Herdr terminal across Pi session replacement and pane movement, and clears after the terminal disconnect grace expires.

Add equivalent Japanese statements to `README.ja.md`. Keep examples concise; do not expose daemon RPC names.

- [ ] **Step 2: Expand package README command reference**

Include this exact command block:

```text
/shepherd orchestrator on
/shepherd orchestrator
/shepherd orchestrator status
/shepherd orchestrator off
```

Clarify that these are entered in Pi, not a shell, and that only the owner displays `Shepherd: orchestrator` in the footer.

- [ ] **Step 3: Update skill boundaries**

Replace generic “Pi may receive unread updates” text with: current workspace agent context remains available to all Pi instances; unread updates are included only when that terminal is the explicit Shepherd orchestrator. Do not instruct the model to claim the role without the user asking.

- [ ] **Step 4: Check links and bilingual parity**

Run:

```bash
rg -n "orchestrator|オーケストレーター|agent updates|agent update" README.md README.ja.md packages/shepherd-pi/README.md packages/shepherd-pi/skills/shepherd/SKILL.md SKILL.md
rg -n "agent\.notifications\.subscribe|subscriptionId" README.md README.ja.md packages/shepherd-pi/README.md packages/shepherd-pi/skills/shepherd/SKILL.md SKILL.md
```

Expected: role behavior appears in all relevant docs; internal/removed RPC terms do not appear.

- [ ] **Step 5: Commit docs**

```bash
git add README.md README.ja.md packages/shepherd-pi/README.md packages/shepherd-pi/skills/shepherd/SKILL.md SKILL.md
git commit -m "docs: explain pi orchestrator notifications"
```

### Task 2: Run Targeted Automated Validation Matrix

**Objective:** Catch failures close to each changed responsibility before the full check.

**Files:**
- Modify implementation/tests only when a listed validation exposes a bug; return to the owning child plan's TDD task before fixing.

- [ ] **Step 1: Validate contracts and persistence**

Run:

```bash
pnpm test \
  test/unit/observability-contracts.test.ts \
  test/integration/agent-orchestrator-scope-store.test.ts \
  test/integration/agent-store-terminal-identity.test.ts \
  test/integration/sqlite-migrations.test.ts
```

Expected: strict schemas, scope cursor, terminal movement, and migration tests all pass.

- [ ] **Step 2: Validate daemon role/routing lifecycle**

Run:

```bash
pnpm test \
  test/integration/agent-orchestrator-service.test.ts \
  test/integration/herdr-pane-identity-resolver.test.ts \
  test/integration/observability-rpc.test.ts \
  test/integration/orchestrator-disconnect-grace.test.ts \
  test/integration/orchestrator-pane-move.test.ts \
  test/unit/herdr-session-watch-manager.test.ts
```

Expected: owner-only routing, scoped role broadcast, shared unread transfer, grace, and moves pass.

- [ ] **Step 3: Validate shepherd-pi**

Run:

```bash
pnpm test \
  test/integration/shepherd-pi-daemon-client.test.ts \
  test/unit/shepherd-pi-extension.test.ts
pnpm --dir packages/shepherd-pi typecheck
(cd packages/shepherd-pi && npm pack --dry-run --json)
```

Expected: reconnect/commands/context/telemetry pass and package includes both source files.

- [ ] **Step 4: Search invariants**

Run:

```bash
rg "agent\.notifications\.subscribe|currentSubscriptionId|subscriptionId|AgentNotificationCursorStore|AgentNotificationService" src packages/shepherd-pi test -n
rg "publishAgentEvent" src/daemon/observability-server.ts test/integration -n
```

Expected: first search has no matches. The second search points to owner-scoped routing tests, not an all-socket loop.

### Task 3: Run Full Repository Validation

**Objective:** Prove no package, schema, formatting, or build regression remains.

- [ ] **Step 1: Validate generated DB state**

Run: `pnpm db:check`

Expected: Drizzle reports valid schema/migration metadata; additive migration `0001` and legacy-table cleanup migration `0002` are present.

- [ ] **Step 2: Run full check**

Run with the repository's pinned toolchain when PATH is stale:

```bash
PATH="$HOME/.local/share/mise/installs/node/24.18.0/bin:$HOME/.local/share/mise/installs/pnpm/11.9.0/bin:$PATH" pnpm check
```

Expected: typecheck, all Vitest tests, Biome lint/format, Drizzle, Pi package, and Herdr plugin checks pass.

- [ ] **Step 3: Run build**

Run:

```bash
PATH="$HOME/.local/share/mise/installs/node/24.18.0/bin:$HOME/.local/share/mise/installs/pnpm/11.9.0/bin:$PATH" pnpm build
```

Expected: TypeScript emits `dist`, `tsc-alias` resolves imports, and no source import points to deleted notification stores.

- [ ] **Step 4: Commit validation fixes only if needed**

If full validation exposed a defect, add a regression test in the owning test file, verify red/green, and commit only that focused fix. Do not create a “misc cleanup” commit.

### Task 4: Dogfood in a Real Herdr Session

**Objective:** Verify connection identity, Pi lifecycle, role UI, and real event delivery beyond mocks.

**Prerequisites:**

- Installed Herdr supports `HERDR_SOCKET_PATH`, `HERDR_WORKSPACE_ID`, `HERDR_PANE_ID`, `terminal_id`, `pane.moved`, and `session.snapshot`.
- Built Shepherd CLI/package points at this checkout.
- Two Pi panes and one non-owner agent pane can run in the same Herdr workspace.
- Every dogfood Pi process is launched with `SHEPHERD_HOME=/tmp/shepherd-orchestrator-dogfood` so its extension connects to the isolated daemon socket; setting the variable only on the daemon is insufficient.

- [ ] **Step 1: Start isolated daemon**

```bash
rm -rf /tmp/shepherd-orchestrator-dogfood
SHEPHERD_HOME=/tmp/shepherd-orchestrator-dogfood shepherd daemon start
```

Expected: daemon creates/migrates a new DB and listens without schema errors. If daemon start is foreground-only in the current build, run it in a dedicated Herdr pane instead of backgrounding it. Launch/relaunch Pi A, Pi B, and later Pi C as `SHEPHERD_HOME=/tmp/shepherd-orchestrator-dogfood pi` before continuing.

- [ ] **Step 2: Verify no-owner state**

In Pi A and Pi B, run `/shepherd orchestrator status`.

Expected: both report no owner; neither footer shows `Shepherd: orchestrator`. Trigger a worker status transition in the same workspace; neither Pi gets unread updates, while each next normal turn still includes current `[SHEPHERD AGENT CONTEXT]`.

- [ ] **Step 3: Claim and replace owner**

In Pi A run `/shepherd orchestrator on`, then in Pi B run the same command.

Expected:

- A initially gets the footer;
- B's claim moves the footer to B;
- A gets one transient `Shepherd orchestrator moved to <B pane>` notification;
- status from both identifies B;
- A cannot clear B by running `off`.

- [ ] **Step 4: Verify owner-only and self-event routing**

Trigger `done`, `blocked`, or `idle` transitions from the worker pane and from Pi B itself.

Expected: worker updates reach B only; Pi B's own terminal transitions do not create unread updates or auto-resume loops; A receives neither.

- [ ] **Step 5: Verify shared unread transfer and ownerless queue**

Create a worker event while B is owner but before B starts another turn. Claim from A before B acks.

Expected: A receives the pending update; B loses local pending state and cannot ack it. Then turn owner off, create another worker event, claim from B, and verify B receives the event created during the ownerless interval.

- [ ] **Step 6: Verify Pi session replacement**

With B owner, execute `/new`, `/resume`, and `/fork` one at a time, allowing each replacement session to start.

Expected: the same Herdr terminal restores the footer without another `on`; status shows the new Pi session connection owns through the same terminal.

- [ ] **Step 7: Verify cross-workspace pane move**

Create destination workspace containing Pi C as owner, then use Herdr pane move to move owner Pi B's live pane into it.

Expected:

- source workspace becomes ownerless;
- B remains owner in destination with its new public pane id;
- C is automatically off and receives one transient notification;
- source/destination events route according to the new scopes;
- B telemetry/context on its next turn uses destination workspace.

- [ ] **Step 8: Verify daemon restart recovery**

Restart the isolated Shepherd daemon while B remains running.

Expected: shepherd-pi reconnects automatically within startup grace, B footer returns/stays, and role does not require another command. Event delivery resumes.

- [ ] **Step 9: Verify disconnect expiry**

Exit Pi B without starting another Pi in that terminal and wait longer than 5 seconds.

Expected: destination scope owner clears. A status query from another Pi reports no owner. Claim another Pi and verify accumulated pending worker events replay once.

- [ ] **Step 10: Capture evidence**

Record exact Herdr session/workspace/pane ids and concise pass/fail notes in the parent plan `Completion Notes`. Do not commit terminal dumps, SQLite DBs, or secrets.

### Task 5: Close the Plan Without Mixing Archive Work

**Objective:** Leave auditable completion state after implementation.

- [ ] **Step 1: Update progress**

Mark each implemented child and task checkbox complete only when its listed validation passed. Add `Completion Notes` to the parent with:

- migration `0001` and `0002` filenames;
- focused test commands;
- `pnpm check` and `pnpm build` results;
- dogfood scope ids and behavior evidence;
- any accepted residual risk.

- [ ] **Step 2: Commit plan completion metadata**

```bash
git add docs/plans/2026-07-10-pi-orchestrator-notifications.md docs/plans/2026-07-10-pi-orchestrator-notifications/
git commit -m "docs: record orchestrator validation"
```

- [ ] **Step 3: Defer archive**

Do not move the plan under `docs/plans/archived/` in the implementation commit. Archive in a later docs-only commit after review/acceptance.

## Validation

- `pnpm check`
- `pnpm build`
- Targeted matrix in Task 2
- Manual dogfood in Task 4
- Visual inspection of README language switch links and command formatting

## Risks, Tradeoffs, and Open Questions

- Manual dogfood can be blocked by an installed Herdr/Pi version older than the documented identity APIs. Report the exact installed versions and leave that case unverified rather than faking environment variables.
- Role state is intentionally not exposed as a shell CLI in this feature. Do not add one just to simplify dogfood.
- No product questions remain for this child plan.

## Next Steps

After implementation and validation, request review. Archive this active plan only in a separate docs-only commit after acceptance.
