# Pi Orchestrator Notification Routing Implementation Plan

> **For implementers:** Execute the child plans task-by-task. Complete each checkbox step, run the listed validation, and commit after each task. This parent plan is the source of scope, terminology, invariants, and ordering.

**Status:** Implementation complete; archive pending (manual Pi dogfood blocked by sandbox)

**Goal:** Let one Pi terminal per Herdr session/workspace become the Shepherd orchestrator through `/shepherd orchestrator on|off|status`, and route durable agent notifications only to that orchestrator while every Pi continues to send telemetry and receive normal workspace agent context.

**Architecture:** Shepherd daemon owns a durable orchestrator assignment and unread cursor for each `(herdrSessionName, workspaceId)` scope. Connected shepherd-pi instances register connection-bound presence using Herdr socket/workspace/pane identity; the daemon resolves the stable Herdr terminal, routes `agent.event` only to the active owner, and broadcasts transient role changes only to Pi connections in affected scopes. The owner follows the Herdr terminal across Pi session replacement and cross-workspace pane moves, while reconnect/grace handling prevents both stale owners and role loss during `/reload` or daemon restart.

**Tech Stack:** TypeScript ESM + NodeNext, Node.js >=24.18.0, pnpm 11.9.0, SQLite via `node:sqlite`, Drizzle schema/migrations, TypeBox/Ajv RPC schemas, Vitest, Node `net`, Herdr socket/runtime identity, Pi extension lifecycle and command APIs.

## Global Constraints

- Chat responses are Japanese; public repository code/docs and commit messages are English.
- Plan-only work must not edit implementation, tests, runtime config, generated DB files, or docs outside this plan tree.
- Orchestrator scope is exactly `(herdrSessionName, workspaceId)`, not workspace id alone, Herdr session alone, or daemon-global.
- Shepherd daemon is the source of truth. Pi session logs and project settings are not role authorities.
- `/shepherd orchestrator on` claims the current Pi terminal. A successful later claim in the same scope atomically replaces the previous owner; last successful claim wins.
- `/shepherd orchestrator off` releases the role only when the calling connection belongs to the current owner terminal. A non-owner call is a no-op and reports that this Pi is not the orchestrator.
- `/shepherd orchestrator` and `/shepherd orchestrator status` both report current status and owner pane.
- With no owner, no Pi receives pushed agent updates. Do not auto-select the first, focused, or any other Pi.
- Non-owner Pi instances continue to connect for presence/role changes, send `agent.telemetry`, call `agent.list`, and receive `[SHEPHERD AGENT CONTEXT]` before turns.
- `agent.event` is sent only to the active owner connection. `agent.orchestrator.changed` is sent to every registered Pi connection in each affected scope.
- Events whose `terminalId` equals the owner terminal are never pushed, replayed, injected, or used to auto-resume that owner. Other Pi terminals remain valid notification sources.
- Each scope has one durable ack cursor. The first-ever claim initializes it to `AgentEventStore.latestEventId(scope)`; later claims preserve it. Events created while no owner exists remain pending after the scope has been initialized.
- An owner switch transfers unacked events to the new owner. Delivery is at-least-once until `agent.notifications.ack` advances the shared cursor.
- Owner identity is the stable Herdr terminal id. Pi `subscriberId` is current connection/session metadata, not role identity.
- Pi `/new`, `/resume`, `/fork`, `/clone`, and `/reload` preserve the role when the replacement extension reconnects from the same Herdr terminal.
- A Herdr cross-workspace pane move moves the role to the terminal's new `(herdrSessionName, workspaceId)`, clears the old scope owner, and replaces any owner in the destination scope.
- Normal disconnects use `DISCONNECT_GRACE_MS = 5_000`. If no connection for the same terminal returns before expiry, clear the role and broadcast the change.
- Daemon startup uses `STARTUP_RECONNECT_GRACE_MS = 10_000` for persisted owners. A matching reconnect preserves the role; otherwise clear it. Intentional daemon shutdown must not clear durable owners.
- shepherd-pi automatically reconnects after daemon/socket failure. Backoff must reach a retry interval no greater than 1 second so it can normally reconnect inside the grace window.
- Only the owner displays persistent footer status `Shepherd: orchestrator`. Non-owners clear that footer key. A replaced owner receives a transient notification naming the new owner pane.
- Existing unread status/widget behavior and `autoResume` behavior remain owner-only because only owners receive agent events.
- Do not add project config files, environment toggles, automatic owner election, owner targeting commands, global force-off commands, or changes to the Herdr plugin.
- Remove obsolete subscriber-scoped notification tables/classes instead of leaving unused compatibility exports. Stage this as migration `0001` (add new state) and migration `0002` (drop old state after daemon migration); do not rewrite `0000_rare_robin_chapel.sql`.
- Follow TDD. Run focused tests after every task, `pnpm db:generate` after schema changes, `pnpm check` after implementation, and `pnpm build` because the Pi package/runtime entrypoint changes.

## Current Context

- `packages/shepherd-pi/src/index.ts` currently subscribes every Pi session with `agent.notifications.subscribe`, stores subscriber-local pending events, broadcasts unread UI locally, and has a non-reconnecting `JsonLineDaemonClient` embedded in the same file.
- `src/daemon/observability-server.ts` currently keeps a `Set<Socket>` and broadcasts every `agent.event` to every socket; request dispatch has no connection-bound identity.
- `src/db/agent-notification-cursors.ts` and `src/observability/agent-notification-service.ts` implement subscriber-scoped durable cursors. Their model conflicts with one transferable workspace cursor.
- `src/db/agent-events.ts` already provides `latestEventId(scope)`, but `AgentEventRecord` does not store stable `terminalId`.
- `src/db/agents.ts` indexes both pane and terminal ids, but `replaceForSession()` finds existing rows by pane first. Cross-workspace Herdr moves change public pane ids and must preserve terminal identity and agent row id.
- `src/daemon/herdr-session-watch-manager.ts` restarts its Herdr subscription after `pane.moved`, but it does not notify another service after the refreshed agent index is available.
- `src/db/herdr-sessions.ts` stores the socket path needed to resolve `HERDR_SOCKET_PATH` to `herdrSessionName`, but has no lookup method by socket path.
- Current official Herdr repository HEAD inspected during design: `ogulcancelik/herdr@c8850a2`. It injects `HERDR_SOCKET_PATH`, `HERDR_WORKSPACE_ID`, `HERDR_TAB_ID`, and `HERDR_PANE_ID` into managed pane processes; stable terminal identity remains separate from public pane identity.
- Pi 0.80.3 emits `session_shutdown` followed by a fresh `session_start` for reload/new/resume/fork flows. Extension command handlers use `pi.registerCommand(name, { handler(args, ctx) })`; persistent footer status uses `ctx.ui.setStatus(key, value)` and transient feedback uses `ctx.ui.notify(message, level)`.
- The repository currently has one baseline migration. Generate `0001` for additive orchestrator/event identity state and `0002` for legacy notification table removal, preserving a runnable schema at each commit without altering the baseline.

## Child Plans

1. [Contracts, scope persistence, shared cursor, and terminal-stable events](2026-07-10-pi-orchestrator-notifications/01-contracts-db.md)
2. [Daemon presence, role service, scoped routing, and grace lifecycle](2026-07-10-pi-orchestrator-notifications/02-daemon-presence-routing.md)
3. [Herdr terminal reconciliation and cross-workspace role movement](2026-07-10-pi-orchestrator-notifications/03-herdr-terminal-reconciliation.md)
4. [shepherd-pi reconnecting client, orchestrator commands, notification context, and UI](2026-07-10-pi-orchestrator-notifications/04-pi-extension-ux.md)
5. [Documentation, integration validation, and dogfooding](2026-07-10-pi-orchestrator-notifications/05-docs-validation.md)

## Requirement Coverage

| Session decision | Implementation tasks | Proof |
| --- | --- | --- |
| Exact `(herdrSessionName, workspaceId)` exclusivity | Child 01 Task 2; Child 02 Tasks 1-3 | scope store and multi-socket RPC tests |
| `/shepherd orchestrator on|off|status`; bare orchestrator means status | Child 04 Task 3 | command parser/notification tests |
| `on` replaces every other Pi in scope; `off` only affects caller-owner | Child 02 Tasks 1 and 3; Child 04 Task 3 | service replacement and non-owner-off tests |
| Daemon is source of truth; no project/session-log setting | Child 01 Task 2; Child 02 Task 3; Child 04 Tasks 2-3 | DB/RPC tests and no local role entry |
| No owner means no pushed updates; all Pi retain telemetry/context | Child 02 Task 3; Child 04 Task 4 | routing matrix and extension behavior tests |
| Agent updates only to owner; role changes to all Pi in affected scope | Child 02 Task 3 | three-scope socket test |
| Owner's own terminal events excluded | Child 01 Task 3; Child 02 Tasks 1 and 3; Child 04 Task 4 | persisted terminal id and self-filter tests |
| One shared durable cursor; first claim starts latest; later unacked transfers and ownerless events queue | Child 01 Task 2; Child 02 Tasks 1 and 3; Child 04 Tasks 3-4 | store/service/set-response/replay tests |
| Role belongs to Herdr terminal across Pi `/new`, `/resume`, `/fork`, `/clone`, `/reload` | Child 02 Tasks 2 and 4; Child 04 Tasks 1-2 | reconnect/new-subscriber tests and dogfood |
| Cross-workspace pane move follows terminal and replaces destination owner | Child 01 Task 3; Child 03 Tasks 1-3 | stable agent id and move integration tests |
| Disconnect grace, daemon restart persistence, automatic reconnect | Child 02 Task 4; Child 04 Tasks 1-2 | fake-timer and real-socket reconnect tests |
| Owner-only footer; replaced owner gets one transient notification | Child 04 Task 3 | role UI and duplicate-suppression tests |
| Public docs and end-to-end verification | Child 05 Tasks 1-5 | bilingual docs, full check/build, Herdr dogfood |

## Ordering

1. Complete child 01 so later code can depend on final contracts and stores.
2. Complete child 02 so the daemon exposes connection-bound role RPC and routing.
3. Complete child 03 so terminal identity survives Herdr topology changes before Pi relies on it.
4. Complete child 04 to migrate shepherd-pi from subscriber cursors to the new connection protocol.
5. Complete child 05 only after all focused tests pass.

## Progress

- [x] Child plan 01 implemented and verified.
- [x] Child plan 02 implemented and verified.
- [x] Child plan 03 implemented and verified.
- [x] Child plan 04 implemented and verified.
- [x] Child plan 05 docs and automated validation completed; manual Pi dogfood constraint recorded.

## Next Steps

Commit this completion metadata, then move the parent and child plan directory under `docs/plans/archived/` in a separate docs-only commit.

## Completion Notes

- Implementation commits: `99fec71` (contracts/DB/terminal identity), `7425941` (role service), `bc815d5` (presence/routing/grace and migration cleanup), `3f2f78a` (pane movement), `db4e9f4` (Pi reconnect/commands/UI), `5ce3ea7` (legacy invariant), `c60fc11` (public docs), and `1081ec9` (reviewed cursor/grace/null-event fixes). Each commit was pushed to `main`.
- Migrations: `drizzle/0001_opposite_toxin.sql` adds scope ownership and event terminal identity; `drizzle/0002_worthless_energizer.sql` removes subscriber notification tables.
- Targeted validation passed: contracts/persistence 14 tests, daemon lifecycle/topology 22 tests, and shepherd-pi 14 tests.
- Final validation passed on 2026-07-10: `pnpm check` (29 files, 130 tests), `pnpm build`, and `pnpm db:check`.
- A read-only implementation review found three P1 issues: skip/future ack, grace expiry after owner movement, and null-terminal delivery. Commit `1081ec9` added regression coverage and fixed all three; the repeated full check/build passed.
- Pi package dry-run includes `src/index.ts`, `src/daemon-client.ts`, and `skills/shepherd/SKILL.md`; it excludes build output, dependencies, and SQLite data.
- Real Herdr evidence: installed Herdr `0.7.2` returned `session.snapshot` with stable terminal ids; an isolated daemon migrated and indexed temporary workspace `default/wC`; direct JSONL registration resolved `wC:p1` / `term_6563c4179a105b` in scope `default/wC`.
- Full interactive Pi dogfood remained unverified. Installed Pi `0.80.6` was launched through agent-safehouse `0.9.0`; its wrapper did not pass the disposable `SHEPHERD_HOME`. A policy-preserving nested launch ended with `sandbox-exec: sandbox_apply: Operation not permitted` (exit 71), so no bypass was attempted. The temporary workspace, daemon, socket, DB, and logs were removed; the pre-existing `w9` and `wB` workspaces remained.
- Accepted residual risk: real footer/transient UI, `/new`/`/resume`/`/fork`, and live cross-workspace move behavior are covered by automated socket/Pi lifecycle tests but were not observed interactively in this sandboxed environment.

## Final Validation

- `pnpm check` — typecheck, all Vitest tests, Biome, Drizzle, Pi package, and Herdr plugin checks pass.
- `pnpm build` — TypeScript build and alias resolution pass with the split shepherd-pi client.
- `pnpm db:check` — Drizzle schema and generated migration metadata are valid.
- `npm pack --dry-run --json` under `packages/shepherd-pi` — both extension source files and skill files are present; no `dist/` or SQLite files are packed.
- Manual Herdr dogfood proves owner replacement, no-owner silence, self-event exclusion, shared unread transfer, Pi session replacement, pane movement, daemon restart recovery, and disconnect expiry as listed in child 05.

## Risks, Tradeoffs, and Open Questions

- **At-least-once delivery:** A role switch or reconnect before ack can duplicate an update. This is intentional; dropping a worker completion is worse than repeating it in hidden context.
- **Single monotonic cursor:** Ack must only advance through events delivered in order. The Pi extension must retain pending events until hidden context preparation and ack them in ascending event id order.
- **Topology races:** A Pi can connect before the first Herdr index refresh. Registration must return a retryable error and shepherd-pi must retry; it must not create an owner with unresolved terminal identity.
- **Cross-workspace move:** Herdr preserves the process but changes public pane identity. Terminal id is therefore the role key and `terminalId` must be copied into stored agent events for reliable self-filtering.
- **Daemon shutdown:** Closing sockets during an intentional stop must not run normal disconnect expiry and erase persisted owners.
- **Old notification data:** Subscriber cursor data cannot be meaningfully converted into one scope cursor. Migration removes those tables; each scope's first claim deliberately starts at the current latest event.
- **No unresolved product questions remain.** Constants and RPC names in the child plans are implementation decisions derived from the completed `/dig` session.
