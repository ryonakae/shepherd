# Telemetry Cleanup, Public Documentation, Validation, and Dogfood Plan

> **For implementers:** Execute this plan task-by-task. Complete each checkbox step, run the listed validation, and commit after each task.

**Status:** Completed

**Goal:** Remove unused per-turn telemetry, document the final owner-only cached-context behavior, prove regressions through deterministic tests, and validate the no-hitch user path in a real Herdr/Pi workspace.

**Architecture:** Cleanup removes the dormant excerpt-telemetry surface after exact Pi session identity has moved to presence registration. Public docs describe `/shepherd on` as the single switch for cached context plus notifications/wake, explain cached `agent.list` versus live detail reads, and avoid promising context while off or disconnected. Automated validation proves absence of prompt-path RPC by call counts rather than timing; dogfood validates the human-visible send experience and cache lifecycle.

**Tech Stack:** TypeScript, TypeBox/Ajv, Vitest, pnpm quality gates, Herdr >= 0.7.0, Pi >= 0.80.6, Markdown.

## Global Constraints

- Inherit every constraint from the parent plan and children 01–04.
- Remove telemetry code rather than leaving empty exports, dummy handlers, compatibility schemas, or comments about deleted behavior.
- Keep the `message_end` handler logic that marks a delivered wake batch successful; remove only telemetry excerpt construction/request code.
- Do not remove `sessionRef` from Pi extension state because presence registration now requires it.
- Do not weaken secret redaction elsewhere; only delete helpers whose sole consumer is removed telemetry.
- Public docs remain bilingual at root (`README.md`, `README.ja.md`) and English in the published Pi package README.
- Do not edit archived plans. Update the still-active dogfood plan because its pending phases currently assert context for non-owner/off Pi.
- Automated performance regressions use call/read counts and exact scheduler constants. Do not add flaky wall-clock upper-bound assertions to Vitest.
- Manual dogfood may record durations and screen behavior, but must not mutate the normal Shepherd database for destructive reconnect/owner-transfer scenarios.
- Run the closest focused tests before full `pnpm check`, then `pnpm build` and `pnpm package:check`.

## Current Context

- `src/observability/contracts.ts` exports `AgentTelemetryEvent` only for dead telemetry normalization/schema code.
- `src/observability/schemas.ts` validates tool/final excerpt payloads.
- `src/daemon/observability-server.ts` accepts `agent.telemetry` and returns `{ accepted: true }` without storage or processing.
- `src/observability/pi-telemetry.ts` and `test/unit/pi-telemetry.test.ts` are disconnected from the daemon pipeline.
- `packages/shepherd-pi/src/index.ts` tracks tool start data, sanitizes output, and sends tool/final RPCs even for non-owner Pi.
- Root/package READMEs currently promise normal hidden context to every connected Pi and say context remains active while off.
- `docs/plans/2026-07-14-shepherd-test-dogfooding.md` is active and has extended routing/lifecycle phases pending; it assumes non-owner context.

## File Structure

- Delete: `src/observability/pi-telemetry.ts` — unused normalization/idempotency helpers.
- Delete: `test/unit/pi-telemetry.test.ts` — tests only deleted behavior.
- Modify: `src/observability/contracts.ts` — remove `AgentTelemetryEvent`.
- Modify: `src/observability/schemas.ts` — remove `agentTelemetryInputSchema` and private telemetry schemas.
- Modify: `src/daemon/observability-server.ts` — remove `agent.telemetry` dispatch.
- Modify: `packages/shepherd-pi/src/index.ts` — remove per-tool/final telemetry state/hooks/helpers while retaining wake completion logic.
- Modify: `test/unit/observability-contracts.test.ts` — remove telemetry acceptance and add RPC-schema absence coverage where practical.
- Modify: `test/unit/shepherd-pi-extension.test.ts` — remove telemetry expectations and retain presence/context/wake tests.
- Modify: `README.md` — owner-only cached context and cached list semantics.
- Modify: `README.ja.md` — matching Japanese behavior.
- Modify: `packages/shepherd-pi/README.md` — published extension semantics.
- Modify: `SKILL.md` — clarify cached list discovery versus live get/read details without changing commands.
- Modify: `docs/plans/2026-07-14-shepherd-test-dogfooding.md` — pending owner/non-owner/context and latency checks.
- Modify: parent/child plan files at completion — status/progress/completion evidence.

## Tasks

### Task 1: Remove No-Op Turn Telemetry End to End

**Objective:** Delete the unused payload, RPC, normalization, and Pi hooks after session identity is available through presence.

**Files:**
- Delete: `src/observability/pi-telemetry.ts`
- Delete: `test/unit/pi-telemetry.test.ts`
- Modify: `src/observability/contracts.ts`
- Modify: `src/observability/schemas.ts`
- Modify: `src/daemon/observability-server.ts`
- Modify: `packages/shepherd-pi/src/index.ts`
- Modify: `test/unit/observability-contracts.test.ts`
- Modify: `test/unit/shepherd-pi-extension.test.ts`

**Interfaces:**
- Consumes: child 01 presence `sessionRef`.
- Produces: no telemetry runtime surface.

- [x] **Step 1: Change tests to reject/remove telemetry behavior**

Delete `validates agent telemetry` and the dedicated normalization tests. In daemon RPC integration, add:

```ts
await expect(
  client.request("agent.telemetry", {
    event: {},
    workspaceId: "wB",
  }),
).rejects.toThrow("Unknown method: agent.telemetry");
```

In shepherd-pi tests:

1. Rename `registers presence, adopts daemon location, reconnects, and sends telemetry` to cover only presence/location/reconnect.
2. Emit `tool_execution_start`, `tool_result`, and a non-wake assistant `message_end`; assert `client.calls` contains no `agent.telemetry`.
3. Preserve the wake `message_end` assertion that sets `assistantFinalSucceeded` and enables acknowledgement after settle.

- [x] **Step 2: Run focused tests to verify red**

Run: `pnpm test test/unit/observability-contracts.test.ts test/integration/observability-rpc.test.ts test/unit/shepherd-pi-extension.test.ts test/unit/pi-telemetry.test.ts`

Expected: old RPC still succeeds and the old telemetry test file still exists.

- [x] **Step 3: Delete the daemon telemetry contract**

Remove:

- `AgentTelemetryEvent` from contracts;
- `agentToolTelemetryEventSchema`, `agentMessageFinalTelemetryEventSchema`, and `agentTelemetryInputSchema` from schemas;
- the schema import and `case "agent.telemetry"` from the RPC server;
- `src/observability/pi-telemetry.ts` and its test.

Do not add a deprecated alias response.

- [x] **Step 4: Delete Pi turn telemetry while keeping wake completion**

Remove:

- `toolStartTimes` state/type/initialization;
- `tool_execution_start` handler;
- `tool_result` telemetry handler;
- telemetry portion of `message_end`;
- `MAX_EXCERPT`, `sanitize()`, and any helper/import left unused solely by telemetry.

Keep this behavior in `message_end`:

```ts
const message = record(event.message);
if (message.role !== "assistant") return;
const stopReason = stringValue(message.stopReason);
if (state.deliveredBatch) {
  state.deliveredBatch.assistantFinalSucceeded =
    stopReason === "stop" || stopReason === "length";
}
```

- [x] **Step 5: Run focused tests and repository search**

Run:

```bash
pnpm test test/unit/observability-contracts.test.ts test/integration/observability-rpc.test.ts test/unit/shepherd-pi-extension.test.ts
rg "agent\.telemetry|AgentTelemetryEvent|normalizePi|piTelemetry|toolStartTimes|sanitizeTelemetry" src packages test
```

Expected: tests pass; `rg` exits 1 with no matches.

- [x] **Step 6: Commit**

```bash
git add -A src/observability src/daemon/observability-server.ts packages/shepherd-pi/src/index.ts test/unit/observability-contracts.test.ts test/integration/observability-rpc.test.ts test/unit/shepherd-pi-extension.test.ts test/unit/pi-telemetry.test.ts
git commit -m "refactor(observability): remove unused Pi telemetry"
```

### Task 2: Update Public and Active Validation Documentation

**Objective:** Make user-facing semantics match owner-only cached context and cached list freshness.

**Files:**
- Modify: `README.md`
- Modify: `README.ja.md`
- Modify: `packages/shepherd-pi/README.md`
- Modify: `SKILL.md`
- Modify: `docs/plans/2026-07-14-shepherd-test-dogfooding.md`

**Interfaces:**
- Consumes: final behavior from all implementation children.
- Produces: accurate installation/operation/skill/dogfood guidance.

- [x] **Step 1: Update root README behavior in both languages**

Replace “every connected Pi receives context” and “context remains active while off” with the exact semantics:

- `/shepherd on` makes this terminal the sole Shepherd owner for the current Herdr session/workspace.
- Only the owner receives cached current-workspace agent context, pending counts, updates, and auto-wake.
- Context excludes the owner Pi itself but includes other Pi terminals.
- Normal context is daemon-cached and injected without waiting for history reads; it can be temporarily absent after startup/reconnect/scope movement until a snapshot arrives.
- `/shepherd off` releases owner behavior for this Pi; another owner's role is unaffected.
- Completed/blocked outcomes still start one visible wake and continue only the existing user request.
- If a normal user run is active, wake waits until that run settles.

For CLI commands, state:

- `agent list` returns the latest cached status and last user/assistant excerpts with `updatedAt` freshness.
- `agent get/read` perform the explicit detail lookup/read path.

Keep installation and command examples unchanged.

- [x] **Step 2: Update the published Pi package README**

Use concise English matching root README. Explicitly state:

```text
`on` enables both cached agent context and automatic agent-update wake for this Pi.
`off` disables both context and wake for this Pi while keeping the daemon connection available for a later claim.
```

Do not document internal table names, pane polling, or source fingerprints in package docs.

- [x] **Step 3: Update the Shepherd Skill freshness guidance**

Keep the same commands and selection rules. Add two bounded statements:

- `agent list` is the fast cached discovery/index view; inspect `updatedAt` when freshness matters.
- Use `agent get/read` for explicit current detail after selecting an exact target.

Do not instruct agents to call `agent list` repeatedly in a polling loop.

- [x] **Step 4: Update the active dogfood plan's pending phases**

Change its owner/non-owner expectations:

- Pi A on: receives cached normal context and wake.
- Pi B off: receives neither context nor updates.
- After direct claim by Pi B: Pi B receives the cached snapshot; Pi A immediately loses context and wake.
- Add prompt-send hitch validation, cached list duration capture, working 10-second refresh, idle 60-second recovery, cache-miss no-block, self exclusion, another-Pi inclusion, and pending-during-normal-run post-settle wake.

Do not rewrite completed Phase 1 evidence as if it were produced by the new implementation. Mark old all-Pi context observations as historical where necessary.

- [x] **Step 5: Review links and terminology**

Run:

```bash
rg "every connected Pi|all connected Pi|context remains active while wake is off|Hidden agent context remains active" README.md README.ja.md packages/shepherd-pi/README.md docs/plans/2026-07-14-shepherd-test-dogfooding.md
rg "agent list|agent get|agent read|/shepherd on|/shepherd off" README.md README.ja.md packages/shepherd-pi/README.md SKILL.md
```

Expected: obsolete claims return no matches; current commands appear in every expected document.

- [x] **Step 6: Commit**

```bash
git add README.md README.ja.md packages/shepherd-pi/README.md SKILL.md docs/plans/2026-07-14-shepherd-test-dogfooding.md
git commit -m "docs: explain owner-only cached Pi context"
```

### Task 3: Run Deterministic Regression and Package Validation

**Objective:** Prove the performance property through call counts and complete project gates before manual dogfood.

**Files:**
- Modify implementation/tests only if validation reveals a scoped defect; do not broaden behavior.

**Interfaces:**
- Consumes: all prior tasks.
- Produces: automated completion evidence.

- [x] **Step 1: Run the prompt-path regression set**

Run:

```bash
pnpm test \
  test/unit/shepherd-pi-extension.test.ts \
  test/integration/shepherd-pi-daemon-client.test.ts \
  test/integration/observability-rpc.test.ts
```

Expected assertions include:

- no prompt lifecycle hook invokes `client.request`;
- cache miss returns immediately with no context;
- cached context is local, pinned, and ephemeral;
- `agent.list` invokes no history method;
- owner-only response/stream routing passes.

- [x] **Step 2: Run cache/index/scheduler regression set**

Run:

```bash
pnpm test \
  test/unit/agent-history-service.test.ts \
  test/integration/agent-context-snapshot-store.test.ts \
  test/integration/agent-context-service.test.ts \
  test/integration/agent-index-service.test.ts \
  test/unit/herdr-session-watch-manager.test.ts \
  test/integration/sqlite-migrations.test.ts
```

Expected: preferred-ref reuse, invalidation matrix, dirty-pane-only refresh, exact 10/60 cadence, persistence, and migration pass.

- [x] **Step 3: Run ownership/wake regression set**

Run:

```bash
pnpm test \
  test/integration/agent-orchestrator-service.test.ts \
  test/integration/orchestrator-disconnect-grace.test.ts \
  test/integration/orchestrator-pane-move.test.ts \
  test/unit/shepherd-pi-wake.test.ts \
  test/unit/shepherd-pi-agent-update-ui.test.ts
```

Expected: cursor, owner transfer, move, reconnect grace, wake projection, and card rendering remain unchanged.

- [x] **Step 4: Run full repository gates**

Use the project-pinned PATH if the shell resolves older Node/pnpm:

```bash
PATH="$HOME/.local/share/mise/installs/node/24.18.0/bin:$HOME/.local/share/mise/installs/pnpm/11.9.0/bin:$PATH" pnpm check
PATH="$HOME/.local/share/mise/installs/node/24.18.0/bin:$HOME/.local/share/mise/installs/pnpm/11.9.0/bin:$PATH" pnpm build
PATH="$HOME/.local/share/mise/installs/node/24.18.0/bin:$HOME/.local/share/mise/installs/pnpm/11.9.0/bin:$PATH" pnpm package:check
```

Expected: all commands exit 0. `pnpm check` includes typecheck, all Vitest tests, Biome, Drizzle, root package, Pi package, and Herdr plugin checks.

- [x] **Step 5: Inspect the final diff**

Run:

```bash
git status --short
git diff --check
git diff --stat HEAD~1..HEAD
```

Expected: no generated runtime DB/dist/node_modules files, no whitespace errors, and only planned source/test/docs/migration files.

### Task 4: Dogfood the No-Hitch and Cache Lifecycle in Herdr

**Objective:** Verify the user-visible behavior that motivated the change using the local package and an isolated destructive-test runtime.

**Files:**
- Evidence updates: `docs/plans/2026-07-14-shepherd-test-dogfooding.md`

**Interfaces:**
- Consumes: built CLI, local shepherd-pi package, running Herdr workspace.
- Produces: real latency/context/wake/owner evidence.

- [x] **Step 1: Prepare a safe topology**

Use `/Users/ryo.nakae/Dev/_sandbox/shepherd-test` with local `.pi/settings.json`, one owner Pi A, one off Pi B, Claude, Codex, and a shell observer. Re-read current workspace/pane ids. Use normal `~/.shepherd` only for non-destructive read/interaction checks; use a disposable `SHEPHERD_HOME` for daemon restart/grace tests.

- [x] **Step 2: Capture cached CLI and background-refresh evidence**

Verify:

1. `shepherd agent list --workspace <id> --json` returns cached rows and `updatedAt` without the prior multi-second discovery delay; record five `/usr/bin/time -p` real values as evidence, not as an automated threshold.
2. While one agent remains `working`, produce new output, wait no more than 15 seconds, then confirm the owner Pi's next normal run sees the updated cached excerpt without CLI/tool inspection.
3. With all agents idle, allow one 60-second recovery interval and verify a missed/manual history change appears.
4. Confirm daemon logs/process behavior does not show overlapping repeated refreshes for the same session.

- [x] **Step 3: Verify prompt responsiveness and owner-only context**

In Pi A after `/shepherd on`:

1. Submit five short prompts while the daemon has large Pi/Claude/Codex history roots. Confirm the Pi working indicator begins without the prior visible ~1-second-or-more pause.
2. Ask Pi A, without Shepherd CLI/tool calls, to identify the other agents' last request/result. Confirm owner Pi A is absent from its own summary and Pi B remains visible as another agent.
3. In Pi B while off, submit the same no-tool prompt and confirm no hidden Shepherd context is available.
4. Claim from Pi B. Confirm Pi B receives cached context on its next run and Pi A no longer does.
5. Turn the owner off and confirm neither Pi receives context or wake until a new claim.

- [x] **Step 4: Verify cache gaps, reconnect, and movement**

Using the disposable Shepherd home where restart is required:

1. Start a Pi before initial cache delivery and submit immediately; confirm the turn proceeds with no hitch and no Shepherd context rather than waiting.
2. Reconnect/restart daemon within grace; confirm the same owner restores cached context through registration.
3. Move the owner pane to another workspace; confirm old context is cleared during the gap and destination context arrives after role reconciliation.
4. Confirm a same-terminal new Pi session path replaces the old path and subsequent cached list/context reflects the new session.

- [x] **Step 5: Verify pending-update separation and wake**

Start a normal long-running Pi A turn, complete Claude while Pi is busy, and confirm:

1. the normal turn is not interrupted and does not incorporate `[SHEPHERD AGENT UPDATES]`;
2. after normal settle, one visible Shepherd wake starts;
3. the wake context contains the bounded final Claude result but not the normal all-agent context;
4. ack/footer clearing occurs only after the wake produces a successful final response and settles;
5. existing failed-wake/retry suppression still behaves as documented.

- [x] **Step 6: Record evidence and cleanup**

Add measured values, exact commands, observed workspace/pane roles, and pass/fail outcomes to the active dogfood plan. Do not include raw session contents or credentials. Stop/remove disposable daemon/socket/DB/logs and verify the normal runtime was not altered by destructive scenarios.

- [x] **Step 7: Commit dogfood evidence**

```bash
git add docs/plans/2026-07-14-shepherd-test-dogfooding.md
git commit -m "test(dogfood): verify cached Pi context responsiveness"
```

### Task 5: Complete and Archive the Plan Tree

**Objective:** Leave active plans accurate and archive completed implementation planning separately from source changes.

**Files:**
- Modify: `docs/plans/2026-07-16-cached-pi-agent-context.md`
- Modify: `docs/plans/2026-07-16-cached-pi-agent-context/*.md`
- Move after completion: parent and child directory to `docs/plans/archived/`

**Interfaces:**
- Consumes: automated and dogfood evidence.
- Produces: completed plan history.

- [x] **Step 1: Update status and evidence**

Mark every implemented child `Status: Completed`, check parent progress, replace `Next Steps` with remaining work or “No implementation work remains,” and record focused/full validation commands plus dogfood evidence. Do not mark blocked/unverified dogfood as complete.

- [x] **Step 2: Check parent/child links before archive**

Verify the child directory name exactly matches the parent basename and every relative link resolves.

- [x] **Step 3: Archive in a docs-only commit**

Only after every required item is complete:

```bash
mkdir -p docs/plans/archived
mv docs/plans/2026-07-16-cached-pi-agent-context.md docs/plans/archived/
mv docs/plans/2026-07-16-cached-pi-agent-context docs/plans/archived/
git add docs/plans
git commit -m "docs: archive cached Pi context plan"
```

## Progress

- [x] Telemetry cleanup completed
- [x] Public and dogfood documentation updated
- [x] Full validation, dogfood, and archive completed

## Next Steps

No implementation work remains.

## Completion Evidence

- No-op telemetry was removed, public docs and active dogfood guidance were updated, and feature evidence shipped in `8e6f228`.
- Focused regressions, 235-test full check, build/package gates, real cached-list and Pi owner/off dogfood, restart recovery, pending wake, cleanup, and archive steps completed.

## Validation

- Focused telemetry-removal search has no matches.
- Root/package README claims match owner-only cache/wake behavior.
- Active dogfood plan no longer expects off/non-owner context.
- All focused test groups pass.
- `pnpm check`, `pnpm build`, and `pnpm package:check` exit 0.
- Manual dogfood verifies prompt responsiveness, cached freshness, owner gating, reconnect/movement, and post-settle wake.

## Risks, Tradeoffs, and Open Questions

- **Subjective hitch validation:** automated tests prove zero prompt-path RPC; dogfood verifies the visual experience. Do not convert human timing into a flaky CI threshold.
- **Cached freshness:** working refresh can be up to 10 seconds behind and idle recovery up to 60 seconds. Docs expose `updatedAt` rather than implying synchronous freshness.
- **Off Pi behavior:** off Pi deliberately has no passive context. Explicit Shepherd Skill/CLI inspection remains available.
- **Telemetry removal:** tool failure excerpts no longer have a dormant wire contract. Current product behavior does not consume them; history readers remain the data source.
- **Dogfood safety:** an `Operation not permitted` sandbox denial must be reported, not bypassed. Leave affected checks unverified rather than weakening policy.
- **No unresolved questions remain in this child.**
