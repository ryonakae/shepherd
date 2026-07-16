# Cached Pi Agent Context Implementation Plan

> **For implementers:** Execute the child plans task-by-task. Complete each checkbox step, run the listed validation, and commit after each task. This parent plan is the source of scope, terminology, invariants, and ordering.

**Status:** Completed

**Goal:** Preserve owner Pi awareness of other agents while removing all daemon RPC and history I/O from the user-message path by maintaining a daemon-owned, persisted agent context cache and pushing owner-scoped snapshots to shepherd-pi.

**Architecture:** The Shepherd daemon is the source of truth for current agent context. It persists one latest compact snapshot per indexed agent, detects dirty panes from Herdr pane revisions and status events, reuses resolved history paths, and pushes current-workspace snapshots only to the `/shepherd on` owner. shepherd-pi keeps a local mirror, pins it for one agent run, and injects it ephemerally through Pi's synchronous `context` hook without performing RPC or file I/O from the prompt path.

**Tech Stack:** TypeScript ESM + NodeNext, Node.js >= 24.18.0, pnpm 11.9.0, SQLite via `node:sqlite`, Drizzle schema/migrations, TypeBox/Ajv, Vitest, Node `net`, Herdr socket protocol/pane revisions, Pi >= 0.80.6 extension events.

## Global Constraints

- Chat responses are Japanese; public repository code, docs, test names, and commit messages are English.
- Follow TDD: focused red test, failing-test confirmation, minimal implementation, focused green test, then refactor.
- Do not add runtime dependencies.
- Do not change Herdr or Pi minimum versions: Herdr remains `>= 0.7.0`; Pi remains `>= 0.80.6`.
- The user-message path must perform **zero Shepherd daemon RPCs and zero filesystem/history reads**. This applies to `before_agent_start`, `agent_start`, and `context` handlers.
- `before_agent_start` must no longer call `agent.orchestrator.get` or `agent.list`. Remove the handler when no other behavior remains.
- Pi's `context` handler may only filter message objects, read in-memory extension state, format bounded text, and return messages. It must not `await`, call `client.request`, call `pi.exec`, or read files.
- Agent context, `agent.event`, pending-count UI, auto-wake, and acknowledgement are delivered only to the active `/shepherd on` owner for the exact `(herdrSessionName, workspaceId)` scope.
- A non-owner/off Pi keeps connection-bound presence so `/shepherd on`, owner replacement, pane movement, and reconnect recovery continue to work. It receives no agent context, no agent events, and sends no per-turn telemetry.
- Every Pi presence registration includes the exact Pi session path known from `ctx.sessionManager.getSessionFile()`, regardless of owner state. This is identity metadata, not turn telemetry.
- Owner context excludes only the receiving Pi's `terminalId`. Other Pi terminals in the same workspace remain visible as other agents.
- If no current-scope local snapshot exists, Pi injects no Shepherd context and proceeds immediately. It never waits for an initial snapshot or reconnect.
- Pin the local snapshot at the start of one Pi agent run and keep it unchanged through tool continuations, retries, and compaction retries until `agent_settled`.
- Auto-wake runs use only `shepherd-wake-context`; do not add the normal all-agent snapshot to a Shepherd-triggered run.
- Agent updates that arrive before or during a normal user run are not mixed into that run. Existing busy deferral schedules an independent wake after `agent_settled`.
- Keep `WAKE_SETTLE_MS = 500`, `DISCONNECT_GRACE_MS = 5_000`, and `STARTUP_RECONNECT_GRACE_MS = 10_000` unchanged.
- Normal cached context is ephemeral provider context. Do not append a new persistent `shepherd-agent-context` message each turn. Filter legacy persisted `shepherd-agent-context` messages before appending the current ephemeral message.
- Preserve the existing normal-context format and `oneLine()` bound of 240 characters per last-user/last-assistant excerpt.
- Persist latest agent context snapshots and resolved history refs in SQLite so daemon restart does not require an empty cache window or unconditional rediscovery.
- Store Herdr `agent_session` and Pi presence session hints separately. Effective priority is Herdr-reported ref, exact Pi hint, then discovery.
- Reuse a discovered history ref until agent identity, cwd, foreground cwd, or authoritative session ref changes; the path disappears; pane revision increases while the source fingerprint remains unchanged; or pane revision resets/decreases.
- Dirty history refresh granularity is one pane/agent. Merge refreshed agents into the persisted workspace snapshot; do not refresh every agent in a dirty workspace.
- Push a rebuilt workspace snapshot when context-visible metadata changes even if compact history does not: agent add/remove, status change, pane/terminal identity change, or workspace move. A move/removal invalidates both the prior and current scopes as applicable.
- Reconcile Pi presence/owner locations from the refreshed agent index before pushing any changed workspace snapshot, so pane moves cannot route new context to the old scope.
- `paneRevision` is a non-negative integer when Herdr provides it and `null` otherwise. A null revision forces that agent's context refresh during each 60-second full rescan.
- Sessions containing at least one `working` agent are revision-checked every `10_000` ms. Other running sessions continue to use the existing `60_000` ms full rescan as the recovery path.
- A `pane.agent_status_changed` event refreshes that agent immediately and does not wait for revision polling.
- Serialize scheduled/full refresh, status-event refresh, and Pi presence session-ref refresh per Herdr session. Coalesce refresh calls only within the same mutation epoch so an older result cannot overwrite a newer status or identity snapshot.
- When a pane id is reused by a different non-null terminal id, create a new agent identity; never inherit the previous terminal's agent id, session ref, or context snapshot through pane fallback.
- `agent.list` returns persisted cached context without history discovery. `agent.get` and `agent.read` retain live stat/read behavior but reuse the persisted preferred history ref; they rediscover only when that ref is invalid.
- Delete no-op tool-result/final-message telemetry hooks, `agent.telemetry` RPC/schema/contracts, and dead telemetry normalization code/tests. Do not replace them with another excerpt ingestion pipeline.
- CLI target resolution, event persistence, owner cursor semantics, wake projection, ack ordering, pane-move ownership, reconnect grace, and Herdr plugin behavior remain unchanged.
- Generate a new Drizzle migration with `pnpm db:generate`; do not edit migrations `0000` through `0002`.
- Run `pnpm check` after implementation. Also run `pnpm build` and `pnpm package:check` because daemon contracts and the Pi package entrypoint change.

## Current Context

- `packages/shepherd-pi/src/index.ts` currently awaits `agent.orchestrator.get` and `agent.list` in `before_agent_start`; measured `agent.list` latency in the dogfood workspace is 3.76–3.90 seconds.
- The same workspace has null `agentSession` for Pi, Claude, and Codex. Fallback discovery scans 141 Pi JSONL files (112.5 MiB), 256 Claude files (281.2 MiB), and 1,164 Codex files (1,175.8 MiB).
- `src/agent-history/discovery.ts` recursively lists every candidate and calls `readFile()` on each entire JSONL before inspecting up to 100 records for cwd.
- `src/agent-history/service.ts` checks the content cache only after discovery, so `agent_history_cache` does not avoid root scanning.
- `HerdrSessionWatchManager` already refreshes every running Herdr session at startup and every 60 seconds, but `AgentIndexService.refreshHerdrSession()` resolves compact history for every agent before checking whether status changed.
- Herdr protocol 16 exposes pane `revision` in `session.snapshot`. Arbitrary `pane_output_changed` is not available as a wildcard `events.subscribe` subscription, so Shepherd must compare revisions from lightweight snapshots.
- Direct Herdr `session.snapshot` measured 103–111 ms; the expensive work is Shepherd history discovery.
- Pi's official `context` hook runs before each LLM call and can non-destructively replace the outgoing message list. It does not persist returned-only messages to the Pi session.
- `sendMessage({ triggerTurn: true })` for Shepherd wake bypasses `before_agent_start`, so wake delivery already has its own `shepherd-wake-context` path.
- The daemon currently accepts `agent.telemetry` and returns `{ accepted: true }` without persistence or processing.
- The Pi extension knows its exact session file at `session_start` but does not send it in presence registration.

## Child Plans

1. [Contracts, persisted agent context snapshots, pane revisions, and Pi session identity](2026-07-16-cached-pi-agent-context/01-contracts-persistence.md)
2. [History-ref reuse and daemon-owned cached agent context](2026-07-16-cached-pi-agent-context/02-history-context-cache.md)
3. [Dirty-pane refresh, adaptive revision polling, cached CLI list, and owner push](2026-07-16-cached-pi-agent-context/03-dirty-refresh-push.md)
4. [Owner-only Pi local mirror, ephemeral context, run pinning, and wake separation](2026-07-16-cached-pi-agent-context/04-pi-owner-context.md)
5. [Telemetry cleanup, public documentation, full validation, and dogfood](2026-07-16-cached-pi-agent-context/05-cleanup-docs-validation.md)

## Requirement Coverage

| Session decision | Implementation tasks | Proof |
| --- | --- | --- |
| Preserve all-agent awareness without prompt-time I/O | Child 02 Tasks 2–3; Child 03 Tasks 1–4; Child 04 Tasks 2–4 | cache store/service tests, socket push tests, Pi no-RPC context tests |
| Daemon owns cache; Pi holds a local mirror | Child 02 Task 3; Child 03 Task 4; Child 04 Tasks 1–2 | store/service tests and register/push/reconnect tests |
| Persist snapshot, history ref, revision, and timestamp | Child 01 Tasks 2–4 | migration and store round-trip tests |
| Dirty pane only | Child 03 Tasks 1–2 | two-pane revision test proves one history refresh |
| Working 10 seconds; otherwise 60 seconds | Child 03 Task 3 | fake-timer watcher tests with exact constants |
| Status events refresh immediately | Child 03 Task 2 | status event test updates context before poll |
| Reuse path; conditionally rediscover, including revision reset | Child 02 Tasks 1–2 | read-count and invalidation matrix tests |
| Herdr/Pi session ref priority | Child 01 Tasks 1 and 4; Child 02 Task 2; Child 03 Task 4; Child 04 Task 1 | contract/store/service registration tests |
| Push owner only; off receives nothing | Child 03 Task 4; Child 04 Tasks 1–2 | multi-socket owner routing tests |
| Owner self excluded; other Pi retained | Child 03 Task 4; Child 04 Task 3 | terminal-filter tests |
| Cache miss never blocks | Child 04 Task 3 | context hook returns unchanged messages and zero RPC |
| Ephemeral context; no duplicate session entries | Child 04 Task 3 | context filtering/injection tests |
| Snapshot pinned for the whole run | Child 04 Task 3 | agent_start/context/update/tool-continuation/settled test |
| Wake gets only wake context | Child 04 Task 4 | wake context test excludes normal marker |
| Pending event waits for independent post-settle wake | Child 04 Task 4 | replacement for current “consume pending update” test |
| `agent.list` cached; `get/read` live | Child 03 Task 5 | RPC service tests with discovery call counts |
| Presence includes session path for every Pi | Child 01 Task 1; Child 04 Task 1 | schema and owner/non-owner registration tests |
| Remove no-op telemetry | Child 05 Task 1 | repository search and contract rejection tests |
| CLI, wake, ownership, movement, and reconnect remain | Child 03 Task 5; Child 04 Task 4; Child 05 Tasks 2–4 | focused regression suites, full check/build, dogfood |

## Ordering

1. Complete child 01 so every later layer uses final wire and persistence contracts.
2. Complete child 02 so history resolution and cached list assembly exist independently of scheduling and sockets.
3. Complete child 03 so the daemon refreshes, persists, serves, and pushes snapshots before Pi consumes them.
4. Complete child 04 so shepherd-pi migrates from prompt-time pull to owner-only local context without changing wake guarantees.
5. Complete child 05 after all focused tests pass; remove dead telemetry, update public docs, run full validation, and dogfood the latency-sensitive path.

## Progress

- [x] Child plan 01: contracts and persistence
- [x] Child plan 02: history and context cache
- [x] Child plan 03: dirty refresh and push
- [x] Child plan 04: Pi owner context
- [x] Child plan 05: cleanup, docs, and validation

## Next Steps

No implementation work remains.

## Completion Evidence

- Feature implementation, tests, migration, public docs, and dogfood evidence were committed as `8e6f228` and pushed to `origin/main`.
- Focused regression groups passed with 59 prompt/RPC tests, 34 cache/index/scheduler tests, and 35 ownership/wake tests.
- Final `pnpm check` passed 35 files and 235 tests, followed by successful `pnpm build` and `pnpm package:check`.
- Real Herdr/Pi dogfood measured cached CLI calls at 0.47–0.49 seconds, five owner prompt starts at 0.3–4.0 milliseconds, Claude cache refresh in 7.85 seconds, owner/off context isolation, reconnect restoration, post-settle wake, and 60-second idle move recovery.
- Independent final review approved the implementation after watcher retirement and abort races received regression coverage.

## Validation

- `pnpm test test/unit/observability-contracts.test.ts test/integration/agent-context-snapshot-store.test.ts test/integration/sqlite-migrations.test.ts` — final contracts and migration persist exact snapshot metadata.
- `pnpm test test/unit/agent-history-service.test.ts test/integration/agent-index-service.test.ts` — preferred refs and dirty-agent updates avoid global rediscovery.
- `pnpm test test/unit/herdr-session-watch-manager.test.ts test/integration/herdr-socket-client.test.ts` — adaptive revision polling and event recovery are deterministic.
- `pnpm test test/integration/observability-rpc.test.ts test/integration/orchestrator-pane-move.test.ts test/integration/orchestrator-disconnect-grace.test.ts` — cached list and owner-scoped push preserve daemon behavior.
- `pnpm test test/unit/shepherd-pi-extension.test.ts test/integration/shepherd-pi-daemon-client.test.ts` — local mirror, ephemeral context, run pinning, no-RPC prompt path, and wake separation pass.
- `pnpm check` — typecheck, all tests, Biome, Drizzle, root package, Pi package, and Herdr plugin checks pass.
- `pnpm build` — compiled daemon/CLI and alias resolution pass.
- `pnpm package:check` — root tarball contents remain valid.
- Manual Herdr/Pi dogfood in child 05 proves no visible send hitch, owner-only context, post-settle wake, reconnect cache restoration, and live cached CLI output.

## Risks, Tradeoffs, and Open Questions

- **Cached list freshness:** `agent.list` becomes snapshot-based. `updatedAt` remains the freshness signal; `agent.get/read` are the explicit live-detail path.
- **Herdr output observability:** wildcard output subscriptions are unavailable, so revision polling is required. Polling only reads Herdr snapshots; history parsing remains dirty-pane-only.
- **TUI revision noise:** spinner/output updates can increase pane revision. Per-session mutation serialization, same-epoch refresh coalescing, and path/fingerprint cache prevent duplicate global discovery; the 10-second active interval bounds work.
- **Session replacement and revision reset:** a new session can reuse agent/cwd/pane and reset revision. Any revision change with an unchanged source fingerprint forces one rediscovery so the old history path is not pinned forever.
- **Persisted stale rows:** agent context rows cascade with agent deletion and are returned only for running Herdr sessions. Scope changes clear Pi local state before new owner context arrives.
- **Context hook frequency:** Pi calls `context` before every provider call. The extension must pin once per run and perform only synchronous in-memory formatting.
- **Wake history:** `shepherd-wake-context` and visible wake output remain persistent conversation history by design; only normal all-agent context is ephemeral.
- **No unresolved product questions remain.** Exact constants, owner semantics, cache-miss behavior, CLI freshness, and telemetry removal were decided in the `/dig` session.
