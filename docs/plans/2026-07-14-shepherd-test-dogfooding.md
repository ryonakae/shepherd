# Shepherd-Test Dogfooding Plan

**Status:** Phase 1 core acceptance completed; extended routing/lifecycle phases pending

**Goal:** Exercise Shepherd from `/Users/ryo.nakae/Dev/_sandbox/shepherd-test` as a real user would, covering structured agent history, the Shepherd Agent Skill, Pi hidden context, and selected-Pi updates without risking the normal Shepherd runtime state.

**Architecture:** Run one Pi wake owner, one Claude agent, and one shell observer in the same Herdr workspace. Complete a short core loop first, then add a second Pi for routing and lifecycle checks. Use an isolated `SHEPHERD_HOME` for restart, disconnect, and unread-transfer scenarios so the normal `~/.shepherd` database is not changed by destructive tests.

**Tech Stack:** Shepherd 0.2.0, Herdr 0.7.2, Pi 0.80.6, Claude Code or another supported agent runtime, JSON CLI output.

## Global Constraints

- Run all agent panes from `/Users/ryo.nakae/Dev/_sandbox/shepherd-test`.
- Do not reuse recorded Herdr workspace or pane ids. Re-read them because public ids can compact.
- Enter `/shepherd [on|off|status]` in Pi, not in a shell.
- Use Shepherd for structured status/history and Herdr for raw terminal output or pane control.
- Do not inspect raw session files unless a Shepherd result is demonstrably wrong and diagnosis is required.
- Do not record credentials, complete session files, SQLite databases, or unredacted terminal dumps as evidence.
- A `done` status is only observable while the completed agent pane has not been viewed.
- Test ownerless event replay only after the scope has had an owner once. The first-ever claim deliberately starts its cursor at the latest existing event.
- Use a disposable Shepherd home for daemon restart, disconnect expiry, owner transfer with pending events, and ownerless replay.

## Current Context

- `/Users/ryo.nakae/Dev/_sandbox/shepherd-test/.pi/settings.json` loads `packages/shepherd-pi` from the local Shepherd checkout.
- Project skills `herdr` and `shepherd` are installed under `.agents/skills/` and Pi discovers both.
- The installed `shepherd` wrapper executes this checkout's `dist/src/cli/shepherd.js`.
- Shepherd daemon and CLI queries currently work against the normal `~/.shepherd` home.
- A previous default Herdr workspace contains Pi and Claude sessions for this directory, but this plan does not depend on its `wB:*` ids.
- The previously archived orchestrator plan left real interactive Pi checks unverified; this dogfood run targets those gaps.

## Test Topology

Use one Herdr workspace with these panes:

| Role | Process | Purpose |
| --- | --- | --- |
| Pi A | `pi` | Primary wake owner and hidden-context consumer |
| Agent | `claude` initially | Produces status transitions, messages, and tool results |
| Observer | shell | Runs `shepherd agent list/get/read` without changing pane focus |
| Pi B | `pi` in the extended run | Tests owner replacement, non-owner behavior, and unread transfer |

Start with Pi A, Agent, and Observer. Add Pi B only after the core loop passes.

## Phase 1: Core Loop With Normal Runtime

**Objective:** Get useful evidence in about 20 minutes before testing lifecycle edge cases.

- [ ] **Step 1: Verify versions and daemon health from a normal shell**

```bash
cd /Users/ryo.nakae/Dev/_sandbox/shepherd-test
shepherd daemon status
herdr --version
pi --version
```

Expected:

- daemon reports `state: "running"` and `socketReachable: true`;
- Herdr reports `0.7.2` or newer;
- Pi reports `0.80.6` or newer.

- [ ] **Step 2: Start or attach Herdr from the target directory**

```bash
cd /Users/ryo.nakae/Dev/_sandbox/shepherd-test
herdr
```

Create the Pi A, Agent, and Observer panes using the normal Herdr UI. In the Observer pane, run:

```bash
herdr pane list
```

Expected: all three panes belong to one workspace and have the target directory as their working directory. Record the current session name, workspace id, and pane ids.

- [ ] **Step 3: Enable wake in Pi A**

Start Pi A with `pi`, then enter:

```text
/shepherd status
/shepherd on
/shepherd status
```

Expected:

- the first status may report no owner;
- `on` identifies Pi A as owner for the current Herdr session/workspace;
- Pi A's footer shows `◆ Shepherd`.

- [x] **Step 4: Give the agent a harmless tool-using task**

Start Claude Code in the agent pane and submit:

```text
Create dogfood-output/agent-note.md. Include a short heading, the current working directory, and the names of the files directly under this directory. Use tools to inspect the directory and write the file, then report the exact path you changed.
```

Do not focus the agent pane after submission. From the Observer pane, query while it is running and again after completion:

```bash
shepherd agent list --json
```

Expected:

- the agent appears in the current workspace;
- `agentStatus` changes through an observed runtime state, normally `working` and then `done`;
- the final user and assistant excerpts match the submitted task and completion report.

If the task completes too quickly to observe `working`, record that as timing-related rather than a failure and repeat with a longer harmless task.

- [x] **Step 5: Validate structured metadata and compact history**

Use the current Agent pane id returned by `agent list`:

```bash
shepherd agent get <agent-pane-id> --json
shepherd agent read <agent-pane-id> --limit 20 --json
```

Expected:

- `get` returns the agent metadata, compact history, and latest compact tool result when available;
- `read` contains normalized `user`, `assistant`, and compact `tool_result` messages in recent order;
- output is concise and does not dump full raw terminal output;
- Claude history identifies its source as `claude-jsonl`.

Also compare the structured result with raw terminal evidence only once:

```bash
herdr pane read <agent-pane-id> --source recent-unwrapped --lines 80
```

Expected: Shepherd preserves the meaningful messages while omitting terminal chrome and unrelated stream text.

- [x] **Step 6: Validate Pi hidden context**

In Pi A, submit:

```text
Shepherd hidden contextだけを使い、別ペインのagentが最後に依頼されたことと、最後に報告したことを説明してください。追加のCLI問い合わせはしないでください。
```

Expected: Pi A identifies the agent and accurately summarizes its latest user/assistant messages without invoking `shepherd agent get/read` during this turn.

- [x] **Step 7: Validate Shepherd Agent Skill behavior**

In Pi A, submit:

```text
別ペインのagentの現在の状態、直近20件の履歴、最後のtool resultを確認してください。
```

Expected:

- Pi loads the Shepherd skill;
- it checks daemon state before the first explicit Shepherd query;
- it starts from `agent list`, selects the exact current pane id, then uses `get` or `read`;
- it reports structured history rather than relying on Herdr scrollback;
- it does not guess an agent name when multiple same-name agents exist.

- [x] **Step 8: Validate pushed update consumption**

Give the agent a second harmless task while Pi A remains owner:

```text
Append a section named "Second pass" to dogfood-output/agent-note.md and report completion.
```

Wait for the agent to finish without sending a turn from Pi A.

Expected:

- only Pi A displays an unread Shepherd event indicator;
- Pi A's next normal prompt receives the agent update in hidden context;
- after that turn, the unread indicator clears and the event is acknowledged;
- Pi A does not receive a notification for Pi A's own terminal activity.

## Phase 2: Isolated Wake Ownership Routing

**Objective:** Exercise ownership and unread behavior without modifying normal `~/.shepherd` state.

- [ ] **Step 1: Start a disposable daemon and Herdr session**

Stop using the Phase 1 Pi processes before switching homes. In a fresh shell:

```bash
export SHEPHERD_HOME=/tmp/shepherd-test-dogfood
rm -rf "$SHEPHERD_HOME"
shepherd daemon start
cd /Users/ryo.nakae/Dev/_sandbox/shepherd-test
herdr --session shepherd-dogfood
```

Expected: the daemon creates a clean runtime home, and processes launched from this Herdr session inherit the same `SHEPHERD_HOME`. Start Pi A, Pi B, Agent, and Observer only after the export is active.

- [ ] **Step 2: Prove no-owner silence, then initialize the scope**

Before claiming, run `/shepherd status` in Pi A and Pi B and trigger one Agent transition.

Expected: neither Pi receives pushed unread updates, but both still receive ordinary current-workspace agent context on their next turns.

Then claim once from Pi A:

```text
/shepherd on
```

Expected: Pi A becomes owner and establishes the scope cursor.

- [ ] **Step 3: Replace the owner atomically**

In Pi B:

```text
/shepherd on
```

Then run status from both Pi instances. In Pi A, also run:

```text
/shepherd off
```

Expected:

- the footer moves from Pi A to Pi B;
- Pi A receives one transient notification naming Pi B's pane;
- both status calls identify Pi B;
- Pi A's non-owner `off` is a no-op and reports `Shepherd is off`.

- [ ] **Step 4: Verify owner-only delivery and self-event exclusion**

Trigger an agent completion while Pi B owns wake. Then make Pi B perform a normal tool-using turn.

Expected:

- the agent update reaches Pi B only;
- Pi A receives no unread agent update;
- Pi B's own terminal event does not become an unread event in Pi B and does not cause a resume loop.

- [ ] **Step 5: Transfer an unacknowledged event**

Trigger another Agent completion while Pi B owns the role. Before Pi B sends its next turn, claim from Pi A.

Expected:

- the pending event transfers to Pi A;
- Pi B clears its local unread state;
- Pi A receives the update in its next hidden context and acknowledges it once.

- [ ] **Step 6: Replay an event created with no owner**

After the scope has already had an owner, turn the current owner off, trigger an agent completion, then claim from Pi B.

Expected: Pi B receives the event created during the ownerless interval. This distinguishes initialized-scope replay from the intentional first-claim cursor behavior.

## Phase 3: Lifecycle and Topology

**Objective:** Cover behavior that automated tests cannot visually prove.

- [ ] **Step 1: Replace the Pi session on the owner terminal**

With Pi B as owner, exercise `/new`, `/reload`, and one of `/resume` or `/fork` after suitable sessions/entries exist.

Expected: the same Herdr terminal regains or retains `◆ Shepherd` without another `on`, and status continues to identify that terminal under the replacement Pi session.

- [ ] **Step 2: Restart the disposable daemon**

From the Observer pane or an external shell using the same environment:

```bash
SHEPHERD_HOME=/tmp/shepherd-test-dogfood shepherd daemon restart
SHEPHERD_HOME=/tmp/shepherd-test-dogfood shepherd daemon status
```

Expected: the Pi extension reconnects automatically within startup grace, the owner's footer returns or remains, and subsequent Agent events are delivered without reclaiming.

- [ ] **Step 3: Verify disconnect expiry**

Exit the owner Pi process and do not restart Pi in that terminal for more than 5 seconds. Query status from the remaining Pi.

Expected: the scope becomes ownerless. Claim from the remaining Pi and confirm that later Agent updates are delivered normally.

- [ ] **Step 4: Verify a live cross-workspace move**

Create a destination workspace with another Pi owner. Use Herdr's UI pane-move action to move the current owner Pi terminal into the destination workspace. Re-read ids with `herdr pane list` after the move.

Expected:

- the source workspace becomes ownerless;
- the moved terminal becomes owner in the destination under its new public pane id;
- the previous destination owner loses the footer and receives one transient notification;
- subsequent hidden context and Agent updates use the destination workspace.

## Phase 4: Runtime Compatibility Matrix

**Objective:** Confirm each available supported runtime with the same small task, without blocking core acceptance on tools that are not installed.

Repeat Phase 1 Steps 4 and 5 for each locally available runtime:

| Runtime | Expected history source |
| --- | --- |
| Claude Code | `claude-jsonl` |
| Codex | `codex-jsonl` |
| Gemini CLI | `gemini-json` |
| OpenCode | `opencode-sqlite` |
| Pi | `pi-jsonl` |

For every available runtime, verify:

- [ ] current status appears in `agent list`;
- [ ] last user/assistant excerpts are correct;
- [ ] `agent read --limit 20` returns normalized messages;
- [ ] compact tool results do not expose full raw output;
- [ ] two same-runtime panes require selecting by pane id rather than relying on an ambiguous runtime name.

Mark unavailable runtimes as skipped with the missing executable/version; do not count them as Shepherd failures.

## Evidence Template

Record one concise entry per failed or surprising check:

```text
Time:
Shepherd / Herdr / Pi versions:
SHEPHERD_HOME: normal | /tmp/shepherd-test-dogfood
Herdr session / workspace / pane ids:
Scenario and exact command or prompt:
Expected:
Actual:
Relevant sanitized JSON excerpt:
Reproducible on second attempt: yes | no
```

Do not keep raw session files or databases in the repository. A screenshot is useful only for footer, unread widget, or transient-notification defects that JSON cannot represent.

## Dogfood Findings

### 2026-07-14: New workspace returned no agents

**Result:** Phase 1 failed at the first structured agent query and correctly blocked further acceptance checks.

**Environment:**

- Shepherd `0.2.0` using the normal `~/.shepherd` home;
- Herdr `0.7.2`, session `default`, current workspace `wJ`;
- Claude agent pane `wJ:p2` completed `dogfood-output/agent-note.md` successfully.

**Observed:**

```text
$ shepherd agent list --json
{"agents":[]}

$ shepherd agent get wJ:p2
agent target not found: wJ:p2
```

An explicit `shepherd agent list --workspace wJ --session default --json` also returned no agents. `shepherd agent list --all --json` showed the daemon still indexed old workspace `wB`; its stale `wB:p2` Claude row contained the new Claude session history because history discovery selected the latest session with the same working directory. The SQLite agent/workspace rows had not been refreshed since daemon startup.

**Cause:**

- periodic Herdr session rescans skipped snapshots for an already-watched session;
- an event-stream exception terminated that session's watch loop because the outer catch swallowed it;
- a real Herdr socket close rejected pending RPC calls but did not wake or reject active event subscribers.

A missed lifecycle event or disconnected stream could therefore leave the agent index stale indefinitely.

**Fix and automated evidence:**

- active sessions now replace their watcher and refresh their snapshot on every 60-second rescan;
- stream failures retry with the existing one-second backoff;
- socket close errors now reject `subscribeEvents()` so the watch manager can reconnect;
- focused watcher/socket/index/RPC tests pass.

**Live recovery evidence:** after `pnpm check`, `pnpm build`, and one normal-daemon restart, `agent list` returned Pi `wJ:p1` and Claude `wJ:p2` under `default/wJ`. `agent get wJ:p2` returned `claude-jsonl` history and its latest compact tool result; `agent read` returned normalized Claude and Pi messages. The daemon subsequently reported `socketReachable: true`.

**Separate observation:** Claude tool results were compacted and readable, but their `toolName` was `unknown`. This does not invalidate the agent-index recovery and should be investigated separately in the Claude history reader if the runtime log contains enough information to recover tool names.

**Hidden-context evidence:** Pi answered without a CLI or Skill call, correctly identifying Claude `wJ:p2` as idle, reconstructing the `agent-note.md` request, and summarizing the created path and listed entries. Pi noted that the report ended mid-sentence because hidden context intentionally limits each one-line message excerpt to 240 characters. This is acceptable for compact context, but it is a useful quality observation when prompts request complete reports.

**Skill evidence:** Pi explicitly loaded the project Shepherd skill, checked daemon status first, started it after observing a stopped state, listed the current Herdr workspace, selected exact target `wJ:p2`, and used both metadata/history queries. Its final answer correctly reported `idle`, all five available normalized messages, and the latest non-error compact tool result with the known `toolName: unknown` limitation.

**Daemon lifecycle observation:** repeated starts overwrote the PID file while older daemon processes remained attached to the same configured socket path. After PID `87875` exited, `daemon status` reported it stale while `agent list` still succeeded through older daemon PID `67945`; `lsof` also found older PID `4507`. The server had unlinked a reachable Unix socket during startup, allowing duplicate daemons rather than rejecting the new start. The fix classifies a reachable socket with missing/stale PID ownership as `orphaned` and refuses start/stop until the operator cleans up the unknown owner.

**Cleanup evidence:** with explicit approval, old PID `67945` stopped from the coding environment; sandbox policy blocked signaling PID `4507`, so the user stopped it from the ordinary shell. The stale PID/socket were removed. No pre-fix daemon remains.

**Remaining live check:** rerun Phase 1 Step 8 for owner-only pushed update consumption against the single rebuilt daemon.

### 2026-07-14: Claude completion produced no selected-Pi notification

**Result:** Phase 1 Step 8 failed. Claude completed the `Second pass` edit, but Pi A displayed no unread event.

**Observed:**

- `agent_orchestrator_scopes` still owned `default/wJ` from Pi `wJ:p1`;
- Claude changed from a `working` snapshot to an `idle` snapshot and its latest history contained the successful completion report;
- `agent_events` contained no `default/wJ` events, so owner routing had nothing to deliver;
- daemon status referenced exited PID `87875`, while agent RPC still succeeded through an older daemon process.

**Cause:** Herdr `0.7.2` streams official subscription events as `{ "event": "pane.agent_status_changed", "data": { ... } }`. Broad lifecycle events use snake_case event names such as `pane_created`. Shepherd's tests used a synthetic `{ type: "pane.agent_status_changed", ... }` payload, and the runtime passed the official envelope through unchanged. The watch manager only inspected `event.type`, so every real Herdr status/lifecycle event was ignored. Periodic snapshots updated the stored status but did not append events, which hid the stream failure from CLI history while preventing notifications.

**Fix and automated evidence:**

- official `{event,data}` envelopes now flatten to internal `{type,...}` records;
- dot-form status names and snake_case lifecycle names are both normalized;
- periodic snapshot refresh compares terminal/pane-stable previous agents and appends one terminal event for missed status transitions;
- stale/missing PID plus reachable socket is reported as `orphaned`, and start/stop refuse to create or signal an ambiguously owned daemon;
- focused tests, `pnpm check` (31 files, 139 tests), and `pnpm build` pass.

**Second live-run finding:** the official envelope fix alone still produced no notification. A direct real-Herdr subscription showed that broad lifecycle subscriptions replay retained events from sequence `0`. Shepherd reacted to the first historical lifecycle event by refreshing and reconnecting, then received the same historical event again, so it never kept a status subscription open. The final fix subscribes only to pane-specific `pane.agent_status_changed`; topology changes use the existing 60-second snapshot rescan. After restart as PID `33996`, `lsof` showed two stable outbound Herdr Unix socket connections instead of zero.

**Third live-run finding:** the final Claude probe generated persisted event IDs `1` through `5` for `idle→working→done→idle`, proving Herdr subscription and daemon persistence. Pi entered its reconnecting state because shepherd-pi passed object `{ unread: count }` to `ctx.ui.setWidget()`, whose Pi API expects string lines or a component factory. The UI exception destroyed the socket; reconnect registration returned the same pending events and repeated the exception indefinitely. The extension first switched to string-array widget input; the current implementation replaces that widget with the single Shepherd footer.

**Live daemon evidence:** after cleanup and rebuild, the current daemon reports `running` with `socketReachable: true`. The current `default/wJ` snapshot contains Pi `wJ:p1` and Claude `wJ:p2`, and the persisted owner remains Pi terminal `term_6568aed2ff7f314` with pane `wJ:p1`. Reloading the fixed project extension restored `◆ Shepherd · 5 agent updates`, proving reconnect, durable pending-event replay, and role preservation. Hidden-context consumption and cursor acknowledgement remain to verify.

### 2026-07-14: Daemon exited when started from shepherd-test

**Result:** daemon start returned PIDs `81747`, `87875`, and later `99872`, but each exited before a subsequent status check when launched from `/Users/ryo.nakae/Dev/_sandbox/shepherd-test`.

**Cause:** `runObservabilityDaemonService()` passed relative migration folder `drizzle` to Drizzle. The child process inherited the user's project cwd, so it searched for `/Users/ryo.nakae/Dev/_sandbox/shepherd-test/drizzle/meta/_journal.json` and exited with `Can't find meta/_journal.json file`. Successful older daemons had been launched from the Shepherd checkout, which hid the cwd dependency.

**Fix and evidence:** the daemon now searches upward from its own service module for `drizzle/meta/_journal.json` and passes that absolute package-root path to migrations. A unit test covers the built `dist/src/daemon` layout. Starting the rebuilt daemon from `shepherd-test` produced PID `10825`, remained reachable across repeated checks, and indexed `default/wJ` successfully.

**Live notification evidence:** after `/reload`, Pi restored `◆ Shepherd · 5 agent updates`. Its next turn used hidden Shepherd updates without CLI calls, accurately summarized Claude's `Final notification probe`, and reported the final idle state. The scope cursor advanced to event ID `5`. Pi's own subsequent event IDs `6` through `10` were not delivered back to the owner terminal, proving self-event exclusion. A second agent task then delivered without reload: Claude event IDs `11` and `12` were summarized accurately, the cursor advanced from `5` to `12`, and Pi's own event IDs `13` and `14` remained excluded.

## Acceptance Criteria

### Core acceptance

- [x] CLI `list/get/read` returns accurate structured data for at least Claude and Pi.
- [x] Pi hidden context accurately summarizes a agent without an explicit query.
- [x] Shepherd skill selects the proper scope and exact pane target.
- [x] One real agent update reaches the selected Pi and is acknowledged on the next turn.

### Extended acceptance

- [ ] owner replacement and non-owner `off` behave correctly;
- [ ] unacknowledged and ownerless events transfer/replay correctly;
- [ ] Pi session replacement preserves terminal ownership;
- [ ] daemon restart reconnects without manual reclaim;
- [ ] disconnect expiry clears ownership after more than 5 seconds;
- [ ] cross-workspace pane movement moves ownership and context to the destination.

A core failure blocks release confidence. An extended failure should include the evidence template and can become a focused regression test before implementation changes.

## Progress

- [x] Environment and package wiring verified.
- [x] Dogfood scenarios and acceptance criteria defined.
- [x] Phase 1 core loop executed and all core acceptance checks passed.
- [ ] Phase 2 isolated routing executed.
- [ ] Phase 3 lifecycle/topology executed.
- [ ] Phase 4 available-runtime matrix executed.

## Next Steps

1. Review and commit the Phase 1 fixes and dogfood evidence.
2. Schedule Phase 2 and Phase 3 in the disposable `SHEPHERD_HOME` session.
3. Run the compatibility matrix only for agent CLIs already available locally.
